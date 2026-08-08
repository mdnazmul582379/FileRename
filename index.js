const INTERVAL = 3000;
const EXT_RE = /\.(mkv|mp4|avi|mov|webm|wmv|flv|m4v|ts)$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") return new Response("Bot is running.");
    if (request.method !== "POST" || url.pathname !== "/webhook")
      return new Response("Not Found", { status: 404 });

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!same(secret, env.WEBHOOK_SECRET || "")) return new Response("Forbidden", { status: 403 });

    let update;
    try { update = await request.json(); } catch { return new Response("Bad Request", { status: 400 }); }

    const uid = String(update?.message?.from?.id ?? update?.callback_query?.from?.id ?? "");
    if (!uid || !String(env.ADMIN_IDS || "").split(",").map(x => x.trim()).includes(uid))
      return new Response("OK");

    try {
      const id = env.BOT_STATE.idFromName("global");
      await env.BOT_STATE.get(id).fetch("https://do/update", {
        method: "POST",
        headers: {"content-type":"application/json"},
        body: JSON.stringify({ update })
      });
    } catch (e) {
      console.error("BOT_STATE dispatch failed:", e);
    }
    return new Response("OK");
  }
};

export class BotState {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    if (request.method !== "POST") return new Response("OK");
    let body;
    try {
      body = await request.json();
      await this.handle(body.update);
    } catch (e) {
      console.error("handle() failed for update", body?.update?.update_id, ":", e);
    }
    return new Response("OK");
  }

  async handle(update) {
    if (!this.env.BOT_TOKEN) {
      console.error("BOT_TOKEN is not set - check Variables and Secrets for this Worker.");
      return;
    }

    if (update?.callback_query) return this.callback(update.callback_query);

    const msg = update?.message;
    if (!msg?.from) return;
    const uid = String(msg.from.id);

    if (msg.text === "/start" || msg.text === "Start Upload") return this.start(uid);
    if (msg.text === "/cancel" || msg.text === "Cancel") return this.cancel(uid);
    if (msg.text === "Done") return this.done(uid);

    const s = await this.getSession();
    if ((s.state === "collecting") && (msg.video || msg.document))
      return this.collect(msg, s);
  }

  async start(uid) {
    const s = await this.getSession();
    if (s.state === "collecting" && s.items?.length) {
      return this.status(uid, s, `${s.items.length} file(s) collected.\n\nSend more files or press Done.`);
    }

    const ns = {state:"collecting", owner_id:uid, items:[], status_id:null};
    await this.state.storage.put("session", ns);
    return this.status(uid, ns,
      "<b>Filename Forward Bot</b>\n\nSend your video/file(s). The bot will collect them until you press <b>Done</b>.",
      true
    );
  }

  async status(uid, s, text, fresh=false) {
    if (!fresh && s.status_id) await del(this.token, uid, s.status_id);
    const m = await send(this.token, uid, text, collectKeyboard());
    s.status_id = m?.message_id || null;
    await this.state.storage.put("session", s);
  }

  async collect(msg, s) {
    const item = getFile(msg);
    if (!item) return;

    if (s.items.some(x => x.file_id === item.file_id)) return;

    s.items.push(item);
    await this.state.storage.put("session", s);
    await this.status(s.owner_id, s,
      `<b>${s.items.length}</b> file(s) collected.\n\nSend more files or press <b>Done</b>.`
    );
  }

  async done(uid) {
    const s = await this.getSession();
    if (s.state !== "collecting" || !s.items?.length) {
      return send(this.token, uid, "No files collected yet.");
    }

    if (s.status_id) await del(this.token, uid, s.status_id);

    s.items = s.items.map(x => ({...x, formatted: formatFilename(x.filename)}));
    s.state = "ready";
    s.ready_message_id = null;
    await this.state.storage.put("session", s);

    const preview = s.items.slice(0, 20).map((x,i) =>
      `${i+1}. <i>${esc(x.formatted)}</i>`
    ).join("\n");

    const text = `<b>${s.items.length} file(s) ready.</b>\n\n${preview}${s.items.length>20?"\n\n...and more.":""}\n\nPress the button below to send them serially.`;

    const m = await send(this.token, uid, text, {
      inline_keyboard: [[{text:"Send To Database Channel",callback_data:"send"}]]
    });

    s.ready_message_id = m?.message_id || null;
    await this.state.storage.put("session", s);
  }

  async callback(cq) {
    const uid = String(cq.from.id);
    if (cq.data === "cancel") {
      await ack(this.token, cq.id, "Cancelled");
      return this.cancel(uid);
    }

    if (cq.data !== "send") {
      await ack(this.token, cq.id);
      return;
    }

    await ack(this.token, cq.id);
    const s = await this.getSession();

    if (s.state !== "ready" || !s.items?.length) {
      return send(this.token, uid, "No ready files found.");
    }
    if (s.state === "sending") return;

    if (!this.env.DATABASE_CHANNEL_ID) {
      console.error("DATABASE_CHANNEL_ID is not set - check Variables and Secrets for this Worker.");
      return send(this.token, uid, "Cannot send: DATABASE_CHANNEL_ID is not configured on the Worker. Please set it and try again.");
    }

    if (s.ready_message_id) await del(this.token, uid, s.ready_message_id);

    s.state = "sending";
    s.sent = 0;
    await this.state.storage.put("session", s);
    await send(this.token, uid,
      `<b>Sending started.</b>\n\n${s.items.length} file(s), 3 seconds between each file.`
    );
    await this.state.storage.setAlarm(Date.now());
  }

  async cancel(uid) {
    const s = await this.getSession();
    if (s.status_id) await del(this.token, uid, s.status_id);
    if (s.ready_message_id) await del(this.token, uid, s.ready_message_id);
    await this.state.storage.deleteAll();
    await send(this.token, uid, "Collection cancelled.", mainKeyboard());
  }

  async alarm() {
    const s = await this.getSession();
    if (s.state !== "sending" || !s.items?.length) return;

    if (!this.env.DATABASE_CHANNEL_ID) {
      console.error("DATABASE_CHANNEL_ID is not set - aborting scheduled send.");
      await send(this.token, s.owner_id, "Cannot send: DATABASE_CHANNEL_ID is not configured on the Worker.");
      return;
    }

    try {
      const item = s.items.shift();
      await sendFile(this.token, this.env.DATABASE_CHANNEL_ID, item);

      s.sent = (s.sent || 0) + 1;

      if (s.items.length) {
        await this.state.storage.put("session", s);
        await this.state.storage.setAlarm(Date.now() + INTERVAL);
        return;
      }

      const owner = s.owner_id;
      const total = s.sent;
      await this.state.storage.deleteAll();
      await send(this.token, owner, `<b>Completed.</b>\n\n${total} file(s) sent to the Database Channel.`);
    } catch (e) {
      console.error(e);
      await this.state.storage.put("session", s);
      await this.state.storage.setAlarm(Date.now() + INTERVAL);
    }
  }

  async getSession() {
    return (await this.state.storage.get("session")) || {state:"idle",items:[]};
  }

  get token() { return this.env.BOT_TOKEN; }
}

function getFile(msg) {
  if (msg.document) return {
    type:"document", file_id:msg.document.file_id,
    filename:msg.document.file_name || `file_${msg.message_id}`,
    unique_id:msg.document.file_unique_id
  };

  if (msg.video) return {
    type:"video", file_id:msg.video.file_id,
    filename:msg.video.file_name || captionFilename(msg.caption) || `video_${msg.message_id}.mp4`,
    unique_id:msg.video.file_unique_id
  };
  return null;
}

function captionFilename(c) {
  const m = String(c || "").match(/([^\n]+\.(?:mkv|mp4|avi|mov|webm|wmv|flv|m4v|ts))$/i);
  return m?.[1]?.trim() || null;
}

function formatFilename(filename) {
  let ext = (String(filename).match(EXT_RE) || [""])[0];
  let n = ext ? String(filename).slice(0,-ext.length) : String(filename);

  n = n
    .replace(/\s*[\(\[]?\s*(?:MVZMod[- ]?Zone|MVZMod|Mov4kHub)\s*[\)\]]?\s*$/i,"")
    .trim();

  const res = take(n, /\b(2160p|1440p|1080p|720p|576p|480p|360p)\b/i);
  const bit = take(n, /\b(8|10|12)Bit\b/i);
  const sources = all(n, /\b(WEBRip|WEB-DL|WEBDL|BluRay|BRRip|HDRip|HDTV|DVDRip|AMZN|NF|DSNP|MAX|ATVP|CR|HMAX)\b/gi);
  const langs = languageList(n);
  const subs = /\bESubs?\b/i.test(n);

  let title = n
    .replace(/\b(?:2160p|1440p|1080p|720p|576p|480p|360p)\b/gi,"")
    .replace(/\b(?:8|10|12)Bit\b/gi,"")
    .replace(/\b(?:WEBRip|WEB-DL|WEBDL|BluRay|BRRip|HDRip|HDTV|DVDRip|AMZN|NF|DSNP|MAX|ATVP|CR|HMAX)\b/gi,"")
    .replace(/\b(?:HINDI|ENG|ENGLISH|KOR|KOREAN|TAMIL|TELUGU|MALAYALAM|BENGALI|JAPANESE|CHINESE|FRENCH|SPANISH|ARABIC)\b/gi,"")
    .replace(/\bESubs?\b/gi,"")
    .replace(/\s{2,}/g," ").trim();

  const parts = [title, ...sources.map(normSource)];
  if (res) parts.push(res.toLowerCase());
  if (bit) parts.push(bit.replace(/bit$/i,"Bit"));
  if (langs.length) parts.push(langs.join(" - "));
  if (subs) parts.push("ESubs");

  return `Fɪʟᴇɴᴀᴍᴇ : @backup2k24 ${parts.join(" ")} | Full Movie - Mov4kHub${ext}`;
}

function languageList(n) {
  const map = {
    HINDI:"Hindi", ENG:"English", ENGLISH:"English", KOR:"Korean",
    KOREAN:"Korean", TAMIL:"Tamil", TELUGU:"Telugu", MALAYALAM:"Malayalam",
    BENGALI:"Bengali", JAPANESE:"Japanese", CHINESE:"Chinese",
    FRENCH:"French", SPANISH:"Spanish", ARABIC:"Arabic"
  };
  const m = n.match(/\b(?:HINDI|ENG|ENGLISH|KOR|KOREAN|TAMIL|TELUGU|MALAYALAM|BENGALI|JAPANESE|CHINESE|FRENCH|SPANISH|ARABIC)(?:[-+&](?:HINDI|ENG|ENGLISH|KOR|KOREAN|TAMIL|TELUGU|MALAYALAM|BENGALI|JAPANESE|CHINESE|FRENCH|SPANISH|ARABIC))+\b/i);
  if (!m) return [];
  return m[0].toUpperCase().split(/[-+&]/).map(x=>map[x.trim()]).filter(Boolean);
}

function take(s,re) { return s.match(re)?.[1] || ""; }
function all(s,re) { return [...s.matchAll(re)].map(x=>normSource(x[1])).filter((x,i,a)=>a.indexOf(x)===i); }

function normSource(x) {
  const m = {WEBRIP:"WEBRip","WEB-DL":"WEB-DL",WEBDL:"WEB-DL",BLURAY:"BluRay",
    BRRIP:"BRRip",HDRIP:"HDRip",DVDRIP:"DVDRip",AMZN:"AMZN",NF:"NF",
    DSNP:"DSNP",MAX:"MAX",ATVP:"ATVP",CR:"CR",HMAX:"HMAX"};
  return m[String(x).toUpperCase()] || x;
}

async function sendFile(token, chat, item) {
  const caption = formatFilename(item.filename);
  const html = `<b>Fɪʟᴇɴᴀᴍᴇ : @backup2k24</b> <i>${esc(caption.replace("Fɪʟᴇɴᴀᴍᴇ : @backup2k24 ",""))}</i>`;

  return api(token, item.type === "video" ? "sendVideo" : "sendDocument", {
    chat_id:chat,
    [item.type === "video" ? "video" : "document"]:item.file_id,
    caption:html, parse_mode:"HTML"
  });
}

function collectKeyboard() {
  return {keyboard:[[{text:"Cancel"},{text:"Done"}]],resize_keyboard:true,is_persistent:true};
}
function mainKeyboard() {
  return {keyboard:[[{text:"Start Upload"}]],resize_keyboard:true,is_persistent:true};
}

async function send(token,chat_id,text,reply_markup) {
  const p={chat_id,text,parse_mode:"HTML"};
  if(reply_markup) p.reply_markup=reply_markup;
  return api(token,"sendMessage",p);
}
async function ack(token,id,text) {
  const p={callback_query_id:id};
  if(text)p.text=text;
  return api(token,"answerCallbackQuery",p);
}
async function del(token,chat_id,message_id) {
  try { await api(token,"deleteMessage",{chat_id,message_id}); } catch(e) {}
}
async function api(token,method,payload) {
  const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)
  });
  const d=await r.json();
  if(!r.ok || !d.ok) throw new Error(d.description || `Telegram ${r.status}`);
  return d.result;
}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function same(a,b){
  if(a.length!==b.length)return false;
  let x=0; for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);
  return x===0;
}