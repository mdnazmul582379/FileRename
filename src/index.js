const INTERVAL = 3000;
const EXT_RE = /\.(mkv|mp4|avi|mov|webm|wmv|flv|m4v|ts)$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") return new Response("Bot is running.");
    if (request.method !== "POST" || url.pathname !== "/webhook")
      return new Response("Not Found", { status: 404 });

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!same(secret, env.WEBHOOK_SECRET || ""))
      return new Response("Forbidden", { status: 403 });

    let update;
    try { update = await request.json(); }
    catch { return new Response("Bad Request", { status: 400 }); }

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
      await this.handle(body?.update);
    } catch (e) {
      console.error("handle() failed for update", body?.update?.update_id, ":", e);
    }
    return new Response("OK");
  }

  // ---------------------------------------------------------------------
  // ROUTER
  // ---------------------------------------------------------------------
  async handle(update) {
    if (!this.env.BOT_TOKEN) {
      console.error("BOT_TOKEN is not set - check Variables and Secrets.");
      return;
    }

    if (update?.callback_query) return this.callback(update.callback_query);

    const msg = update?.message;
    if (!msg?.from) return;
    const uid = String(msg.from.id);
    const text = typeof msg.text === "string" ? msg.text.trim() : undefined;

    const s = await this.getSession();

    // Global navigation — always available, never gets "lost"
    if (text === "/start") return this.showMainMenu(uid, s);
    if (text === "/cancel" || text === "🔙 Back") return this.backToMenu(uid, s);
    if (text === "🖼 Add Thumbnail") return this.enterThumb(uid, s);
    if (text === "📁 File Rename") return this.enterRename(uid, s);

    if (s.mode === "rename") {
      if (text === "✅ Done") return this.renameDone(uid, s);
      if (text === "❌ Cancel") return this.renameCancel(uid, s);
      if (text === "👁 Preview") return this.renamePreview(uid, s);
      if (text === "📝 Edit Data") return this.renameEditPrompt(uid, s);
      if (text === "📋 View Data") return this.renameViewData(uid, s);
      if (text === "🗑 Clear All") return this.renameClearAll(uid, s);
      if (s.awaiting_edit && text) return this.applyEdit(uid, s, text);
      if (msg.video || msg.document) return this.collect(msg, s);
      return;
    }

    if (s.mode === "thumb") return this.handleThumbMsg(uid, s, msg, text);

    // No mode selected yet — be forgiving instead of silently ignoring.
    if (msg.video || msg.document) {
      s.mode = "rename";
      s.owner_id = uid;
      await this.state.storage.put("session", s);
      await this.enterRename(uid, s);
      return this.collect(msg, s);
    }

    return this.showMainMenu(uid, s);
  }

  async callback(cq) {
    const uid = String(cq.from.id);
    if (cq.data === "cancel") {
      await ack(this.token, cq.id, "Cancelled");
      const s = await this.getSession();
      return this.renameCancel(uid, s);
    }
    if (cq.data !== "send") {
      await ack(this.token, cq.id);
      return;
    }

    await ack(this.token, cq.id);
    const s = await this.getSession();

    if (s.state !== "rename_ready" || !s.items?.length)
      return send(this.token, uid, "কোনো রেডি ফাইল পাওয়া যায়নি।");
    if (s.state === "rename_sending") return;

    if (!this.env.DATABASE_CHANNEL_ID) {
      console.error("DATABASE_CHANNEL_ID is not set.");
      return send(this.token, uid, "Cannot send: DATABASE_CHANNEL_ID is not configured on the Worker.");
    }

    if (s.ready_message_id) await del(this.token, uid, s.ready_message_id);

    const total = s.items.length;
    s.state = "rename_sending";
    s.sent = 0;
    s.total = total;

    const label = String(total).padStart(2, "0");
    const m = await send(this.token, uid, `<b>Sending started.</b>\n\n00/${label} sent so far.`);
    s.progress_message_id = m?.message_id || null;

    await this.state.storage.put("session", s);
    await this.state.storage.setAlarm(Date.now());
  }

  // ---------------------------------------------------------------------
  // MAIN MENU
  // ---------------------------------------------------------------------
  async showMainMenu(uid, s) {
    s.mode = null;
    await this.state.storage.put("session", s);
    await send(this.token, uid,
      "👋 <b>স্বাগতম!</b>\n\nনিচের বাটন থেকে যেকোনো একটি বেছে নিন:",
      mainKeyboard()
    );
  }

  async backToMenu(uid, s) {
    s.mode = null;
    s.awaiting_edit = false;
    s.awaiting_thumb_photo = false;
    await this.state.storage.put("session", s);
    await send(this.token, uid, "🏠 <b>মেইন মেনু</b>", mainKeyboard());
  }

  // ---------------------------------------------------------------------
  // FILE RENAME MODE
  // ---------------------------------------------------------------------
  async enterRename(uid, s) {
    s.mode = "rename";
    s.owner_id = uid;
    if (!s.items) s.items = [];
    if (s.state !== "rename_ready" && s.state !== "rename_sending") s.state = "rename_collecting";
    await this.state.storage.put("session", s);
    await this.renderRenameStatus(uid, s, true);
  }

  // Edits the existing status message in place whenever possible instead
  // of delete+resend, so collecting many files doesn't spam the chat.
  async renderRenameStatus(uid, s, freshMessage) {
    const count = s.items.length;
    const text = count
      ? `<b>${count}</b> file(s) collected.\n\nSend more files or press <b>✅ Done</b>.`
      : `<b>📁 File Rename</b>\n\nভিডিও/ফাইল পাঠান, বট সংগ্রহ করবে।\nশেষ হলে <b>✅ Done</b> চাপুন।`;

    if (!freshMessage && s.status_id) {
      const ok = await edit(this.token, uid, s.status_id, text);
      if (ok) {
        await this.state.storage.put("session", s);
        return;
      }
    }
    const m = await send(this.token, uid, text, renameMenuKeyboard());
    s.status_id = m?.message_id || null;
    await this.state.storage.put("session", s);
  }

  async collect(msg, s) {
    const item = getFile(msg);
    if (!item || s.items.some(x => x.file_id === item.file_id)) return;
    s.items.push(item);
    await this.state.storage.put("session", s);
    await this.renderRenameStatus(s.owner_id, s, false);
  }

  async renameDone(uid, s) {
    if (!s.items?.length) return send(this.token, uid, "এখনো কোনো ফাইল সংগ্রহ করা হয়নি।");

    s.items = s.items.map(x => x.override ? x : {...x, formatted: formatFilename(x.filename)});
    s.state = "rename_ready";
    await this.state.storage.put("session", s);

    const preview = s.items.slice(0, 20).map((x,i) =>
      `${i+1}. <i>${esc(x.formatted)}</i>`
    ).join("\n");

    const text = `<b>${s.items.length} file(s) ready.</b>\n\n${preview}${s.items.length>20?"\n\n...and more.":""}\n\nনিচের বাটনে চাপ দিন চ্যানেলে সিরিয়ালি পাঠানোর জন্য।`;

    if (s.ready_message_id) await del(this.token, uid, s.ready_message_id);
    const m = await send(this.token, uid, text, {
      inline_keyboard: [[{text:"📤 Send To Database Channel",callback_data:"send"}]]
    });
    s.ready_message_id = m?.message_id || null;
    await this.state.storage.put("session", s);
  }

  async renamePreview(uid, s) {
    if (!s.items?.length) return send(this.token, uid, "কোনো ফাইল সংগ্রহ করা হয়নি।");
    const list = s.items.map((x,i) =>
      `${i+1}. <i>${esc(x.override ? x.formatted : formatFilename(x.filename))}</i>`
    ).join("\n");
    await send(this.token, uid, `👁 <b>Preview</b>\n\n${list}`);
  }

  async renameViewData(uid, s) {
    if (!s.items?.length) return send(this.token, uid, "কোনো ফাইল সংগ্রহ করা হয়নি।");
    const list = s.items.map((x,i) => `${i+1}. ${esc(x.filename)}`).join("\n");
    await send(this.token, uid, `📋 <b>Original Filenames</b>\n\n${list}`);
  }

  async renameEditPrompt(uid, s) {
    if (!s.items?.length) return send(this.token, uid, "কোনো ফাইল সংগ্রহ করা হয়নি।");
    s.awaiting_edit = true;
    await this.state.storage.put("session", s);
    const list = s.items.map((x,i) => `${i+1}. ${esc(x.filename)}`).join("\n");
    await send(this.token, uid,
      `📝 <b>Edit Data</b>\n\n${list}\n\nযে ফাইলের নাম ঠিক করতে চান, এভাবে রিপ্লাই দিন:\n<code>নাম্বার নতুন_নাম</code>\n\nউদাহরণ: <code>2 Pathaan (2023) 1080p WEB-DL.mkv</code>`
    );
  }

  async applyEdit(uid, s, text) {
    const m = text.match(/^(\d+)\s+(.+)$/s);
    if (!m) return send(this.token, uid, "সঠিক ফরম্যাটে দিন: <code>নাম্বার নতুন_নাম</code>");
    const idx = parseInt(m[1], 10) - 1;
    if (idx < 0 || idx >= s.items.length) return send(this.token, uid, "এই নাম্বারে কোনো ফাইল নেই।");

    let name = m[2].trim();
    const item = s.items[idx];
    if (!EXT_RE.test(name)) {
      const origExt = (item.filename.match(EXT_RE) || [""])[0] || "";
      name += origExt;
    }
    item.formatted = name;
    item.override = true;
    s.awaiting_edit = false;
    await this.state.storage.put("session", s);
    await send(this.token, uid, `✅ আপডেট হয়েছে:\n${idx+1}. <i>${esc(name)}</i>`);
  }

  async renameClearAll(uid, s) {
    s.items = [];
    s.awaiting_edit = false;
    s.state = "rename_collecting";
    if (s.ready_message_id) { await del(this.token, uid, s.ready_message_id); s.ready_message_id = null; }
    await this.state.storage.put("session", s);
    await send(this.token, uid, "🗑 সব ফাইল মুছে ফেলা হয়েছে। নতুন করে ফাইল পাঠান।");
  }

  async renameCancel(uid, s) {
    if (s.state === "rename_sending") return send(this.token, uid, "⏳ পাঠানো চলছে, একটু অপেক্ষা করুন।");
    if (s.status_id) await del(this.token, uid, s.status_id);
    if (s.ready_message_id) await del(this.token, uid, s.ready_message_id);
    s.mode = null;
    s.state = "idle";
    s.items = [];
    s.status_id = null;
    s.ready_message_id = null;
    s.awaiting_edit = false;
    await this.state.storage.put("session", s);
    await send(this.token, uid, "❌ বাতিল করা হয়েছে।", mainKeyboard());
  }

  // ---------------------------------------------------------------------
  // ADD THUMBNAIL MODE
  // ---------------------------------------------------------------------
  async enterThumb(uid, s) {
    s.mode = "thumb";
    s.owner_id = uid;
    await this.state.storage.put("session", s);
    const text = s.thumb_file_id
      ? "✅ থাম্বনেইল সেট করা আছে।\n\nএখন যেকোনো ভিডিও/ফাইল পাঠান — বট সেটাতে এই থাম্বনেইল বসিয়ে ফেরত পাঠাবে।"
      : "🖼 <b>Add Thumbnail</b>\n\nএখনো কোনো থাম্বনেইল সেট নেই। নিচের বাটনে চেপে একটি ছবি পাঠান।";
    await send(this.token, uid, text, thumbKeyboard());
  }

  async handleThumbMsg(uid, s, msg, text) {
    if (text === "🖼 Set Thumbnail") {
      s.awaiting_thumb_photo = true;
      await this.state.storage.put("session", s);
      return send(this.token, uid, "📷 এখন একটি ছবি (photo) পাঠান, সেটি থাম্বনেইল হিসেবে সেট হবে।");
    }
    if (text === "👁 Preview Thumbnail") {
      if (!s.thumb_file_id) return send(this.token, uid, "কোনো থাম্বনেইল সেট করা নেই।");
      return sendPhoto(this.token, uid, s.thumb_file_id, "বর্তমান থাম্বনেইল");
    }
    if (text === "🗑 Remove Thumbnail") {
      s.thumb_file_id = null;
      s.awaiting_thumb_photo = false;
      await this.state.storage.put("session", s);
      return send(this.token, uid, "🗑 থাম্বনেইল মুছে ফেলা হয়েছে।");
    }

    if (s.awaiting_thumb_photo && msg.photo?.length) {
      const best = msg.photo[msg.photo.length - 1];
      s.thumb_file_id = best.file_id;
      s.awaiting_thumb_photo = false;
      await this.state.storage.put("session", s);
      return send(this.token, uid,
        "✅ থাম্বনেইল সেট হয়েছে।\n\nএখন যেকোনো ভিডিও/ফাইল পাঠান — বট থাম্বনেইলসহ ফেরত পাঠাবে।",
        thumbKeyboard()
      );
    }

    if (msg.video || msg.document) {
      if (!s.thumb_file_id) return send(this.token, uid, "আগে থাম্বনেইল সেট করুন (🖼 Set Thumbnail চাপুন)।");
      return this.applyThumb(uid, msg, s.thumb_file_id);
    }
  }

  async applyThumb(uid, msg, thumbFileId) {
    const item = getFile(msg);
    if (!item) return;
    const wait = await send(this.token, uid, "⏳ থাম্বনেইল বসানো হচ্ছে...");
    try {
      const thumbBuf = await downloadTelegramFile(this.token, thumbFileId);
      await sendFileWithThumb(this.token, uid, item, thumbBuf, item.filename);
      if (wait?.message_id) await del(this.token, uid, wait.message_id);
    } catch (e) {
      console.error("applyThumb failed:", e);
      if (wait?.message_id) await edit(this.token, uid, wait.message_id, "❌ থাম্বনেইল বসাতে সমস্যা হয়েছে। আবার চেষ্টা করুন।");
      else await send(this.token, uid, "❌ থাম্বনেইল বসাতে সমস্যা হয়েছে।");
    }
  }

  // ---------------------------------------------------------------------
  // SCHEDULED SEND (Durable Object alarm, one file per INTERVAL ms)
  // ---------------------------------------------------------------------
  async alarm() {
    const s = await this.getSession();
    if (s.state !== "rename_sending" || !s.items?.length) return;

    if (!this.env.DATABASE_CHANNEL_ID) {
      console.error("DATABASE_CHANNEL_ID is not set - aborting scheduled send.");
      await send(this.token, s.owner_id, "Cannot send: DATABASE_CHANNEL_ID is not configured on the Worker.");
      return;
    }

    try {
      const item = s.items.shift();
      await sendFile(this.token, this.env.DATABASE_CHANNEL_ID, item);

      s.sent = (s.sent || 0) + 1;
      const total = s.total || s.sent;
      const label = String(total).padStart(2, "0");
      const sentLabel = String(s.sent).padStart(2, "0");

      if (s.items.length) {
        if (s.progress_message_id)
          await edit(this.token, s.owner_id, s.progress_message_id, `<b>Sending…</b>\n\n${sentLabel}/${label} sent so far.`);
        await this.state.storage.put("session", s);
        await this.state.storage.setAlarm(Date.now() + INTERVAL);
        return;
      }

      if (s.progress_message_id)
        await edit(this.token, s.owner_id, s.progress_message_id, `<b>Completed.</b>\n\n${sentLabel}/${label} file(s) sent to the Database Channel.`);
      else
        await send(this.token, s.owner_id, `<b>Completed.</b>\n\n${sentLabel}/${label} file(s) sent to the Database Channel.`);

      const owner = s.owner_id;
      s.mode = null;
      s.state = "idle";
      s.items = [];
      s.status_id = null;
      s.ready_message_id = null;
      s.progress_message_id = null;
      s.awaiting_edit = false;
      await this.state.storage.put("session", s);
      if (owner) await send(this.token, owner, "🏠 মেইন মেনুতে ফিরে এসেছেন।", mainKeyboard());
    } catch (e) {
      console.error("Scheduled send failed:", e);
      await this.state.storage.put("session", s);
      await this.state.storage.setAlarm(Date.now() + INTERVAL);
    }
  }

  async getSession() {
    const s = await this.state.storage.get("session");
    return s || {
      mode: null, state: "idle", items: [], owner_id: null,
      status_id: null, ready_message_id: null, progress_message_id: null,
      thumb_file_id: null, awaiting_edit: false, awaiting_thumb_photo: false
    };
  }

  get token() { return this.env.BOT_TOKEN; }
}

// ---------------------------------------------------------------------
// FILE HELPERS
// ---------------------------------------------------------------------
function getFile(msg) {
  if (msg.document) return {
    type:"document", file_id:msg.document.file_id,
    filename:msg.document.file_name || `file_${msg.message_id}`,
    unique_id:msg.document.file_unique_id,
    thumb_file_id: msg.document.thumbnail?.file_id || msg.document.thumb?.file_id || null
  };
  if (msg.video) return {
    type:"video", file_id:msg.video.file_id,
    filename:msg.video.file_name || captionFilename(msg.caption) || `video_${msg.message_id}.mp4`,
    unique_id:msg.video.file_unique_id,
    thumb_file_id: msg.video.thumbnail?.file_id || msg.video.thumb?.file_id || null
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

  n = n.replace(/\s*[\(\[]?\s*(?:MVZMod[- ]?Zone|MVZMod|Mov4kHub)\s*[\)\]]?\s*$/i,"").trim();

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

// Forwards a collected file to the database channel, re-attaching its
// original thumbnail (if it had one) so the channel copy keeps it.
async function sendFile(token, chat, item) {
  const formatted = item.formatted || formatFilename(item.filename);
  const caption = `<b>Fɪʟᴇɴᴀᴍᴇ : @backup2k24</b> <i>${esc(formatted.replace("Fɪʟᴇɴᴀᴍᴇ : @backup2k24 ",""))}</i>`;

  if (item.thumb_file_id) {
    try {
      const buf = await downloadTelegramFile(token, item.thumb_file_id);
      return await sendFileWithThumb(token, chat, item, buf, null, caption);
    } catch (e) {
      console.error("thumb preserve failed, sending without thumb:", e);
    }
  }

  return api(token, item.type === "video" ? "sendVideo" : "sendDocument", {
    chat_id:chat,
    [item.type === "video" ? "video" : "document"]:item.file_id,
    caption, parse_mode:"HTML"
  });
}

// Downloads actual bytes of a Telegram-hosted file (used for thumbnails,
// since Telegram's `thumbnail` param can't be reused by file_id — it must
// be freshly uploaded as multipart/form-data on every request).
async function downloadTelegramFile(token, file_id) {
  const info = await api(token, "getFile", {file_id});
  const path = info.file_path;
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  if (!r.ok) throw new Error(`Failed to download file: ${r.status}`);
  return await r.arrayBuffer();
}

// Sends a video/document by file_id while attaching a freshly uploaded
// thumbnail image.
async function sendFileWithThumb(token, chat_id, item, thumbBuf, plainFilename, htmlCaption) {
  const form = new FormData();
  form.append("chat_id", String(chat_id));
  form.append(item.type === "video" ? "video" : "document", item.file_id);
  form.append("thumbnail", new Blob([thumbBuf], {type:"image/jpeg"}), "thumb.jpg");

  const caption = htmlCaption || (plainFilename ? `<b>${esc(plainFilename)}</b>` : "");
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }

  const method = item.type === "video" ? "sendVideo" : "sendDocument";
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method:"POST", body: form });
  const d = await r.json();
  if (!r.ok || !d.ok) throw new Error(d.description || `Telegram ${r.status}`);
  return d.result;
}

// ---------------------------------------------------------------------
// KEYBOARDS
// ---------------------------------------------------------------------
// Always-present persistent 2-button main menu — never disappears.
function mainKeyboard() {
  return {
    keyboard: [[{text:"🖼 Add Thumbnail"},{text:"📁 File Rename"}]],
    resize_keyboard: true, is_persistent: true
  };
}
function renameMenuKeyboard() {
  return {
    keyboard: [
      [{text:"✅ Done"},{text:"❌ Cancel"}],
      [{text:"👁 Preview"},{text:"📝 Edit Data"}],
      [{text:"📋 View Data"},{text:"🗑 Clear All"}],
      [{text:"🔙 Back"}]
    ],
    resize_keyboard: true, is_persistent: true
  };
}
function thumbKeyboard() {
  return {
    keyboard: [
      [{text:"🖼 Set Thumbnail"}],
      [{text:"👁 Preview Thumbnail"},{text:"🗑 Remove Thumbnail"}],
      [{text:"🔙 Back"}]
    ],
    resize_keyboard: true, is_persistent: true
  };
}

// ---------------------------------------------------------------------
// TELEGRAM API HELPERS
// ---------------------------------------------------------------------
async function send(token,chat_id,text,reply_markup) {
  const p={chat_id,text,parse_mode:"HTML"};
  if(reply_markup) p.reply_markup=reply_markup;
  return api(token,"sendMessage",p);
}
async function sendPhoto(token,chat_id,photo,caption) {
  const p={chat_id,photo};
  if(caption) p.caption=caption;
  return api(token,"sendPhoto",p);
}
async function edit(token,chat_id,message_id,text) {
  try { await api(token,"editMessageText",{chat_id,message_id,text,parse_mode:"HTML"}); return true; }
  catch(e) {
    if (String(e.message||"").includes("message is not modified")) return true;
    console.error("edit failed:", e);
    return false;
  }
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
