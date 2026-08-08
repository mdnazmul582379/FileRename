const INTERVAL = 3000;
const PREVIEW_BATCH_SIZE = 5;
const EXT_RE = /\.(mkv|mp4|avi|mov|webm|wmv|flv|m4v|ts)$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") return new Response("Bot is running.");
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!same(secret, env.WEBHOOK_SECRET || "")) return new Response("Forbidden", { status: 403 });

    let update;
    try { update = await request.json(); }
    catch { return new Response("Bad Request", { status: 400 }); }

    const uid = String(update?.message?.from?.id ?? update?.callback_query?.from?.id ?? "");
    const admins = String(env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
    if (!uid || !admins.includes(uid)) return new Response("OK");

    try {
      const id = env.BOT_STATE.idFromName("global");
      await env.BOT_STATE.get(id).fetch("https://do/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update })
      });
    } catch (e) {
      console.error("BOT_STATE dispatch failed:", e);
    }
    return new Response("OK");
  }
};

export class BotState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

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

  async handle(update) {
    if (!this.env.BOT_TOKEN) {
      console.error("BOT_TOKEN is not set.");
      return;
    }

    if (update?.callback_query) return this.callback(update.callback_query);

    const msg = update?.message;
    if (!msg?.from) return;

    const uid = String(msg.from.id);
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    const s = await this.getSession();

    if (text === "/start") return this.showMainMenu(uid, s);
    if (text === "/cancel") return this.cancelToMain(uid, s);

    if (text === "Add Thumbnail") return this.enterThumb(uid, s);
    if (text === "File Rename") return this.enterRename(uid, s);

    if (s.mode === "thumb") return this.handleThumbMsg(uid, s, msg, text);

    if (s.mode === "rename") {
      if (text === "Done") return this.renameDone(uid, s);
      if (text === "Cancel") return this.renameCancel(uid, s);
      if (text === "Preview") return this.renamePreview(uid, s);
      if (text === "Edit Data") return this.renameEditPrompt(uid, s);
      if (text === "View Data") return this.renameViewData(uid, s);
      if (text === "Clear All") return this.renameClearAll(uid, s);
      if (text === "Back") return this.backToMenu(uid, s);

      if (s.awaiting_edit && text) return this.applyEdit(uid, s, text);
      if (msg.video || msg.document) return this.collect(msg, s);
      return;
    }

    // If a file arrives while the bot is idle, enter rename mode automatically.
    if (msg.video || msg.document) {
      s.mode = "rename";
      s.owner_id = uid;
      s.state = "rename_collecting";
      if (!Array.isArray(s.items)) s.items = [];
      await this.state.storage.put("session", s);
      return this.collect(msg, s);
    }

    return this.showMainMenu(uid, s);
  }

  async callback(cq) {
    const uid = String(cq.from.id);
    const data = String(cq.data || "");

    if (data === "preview_continue") {
      await ack(this.token, cq.id);
      const s = await this.getSession();
      if (s.mode !== "rename" || !s.items?.length) return;
      if (s.preview_control_id) {
        await del(this.token, uid, s.preview_control_id);
        s.preview_control_id = null;
      }
      await this.state.storage.put("session", s);
      return this.sendPreviewBatch(uid, s, false);
    }

    if (data === "send") {
      await ack(this.token, cq.id);
      const s = await this.getSession();
      return this.startSending(uid, s);
    }

    if (data === "cancel_send") {
      await ack(this.token, cq.id, "Cancelled");
      return;
    }

    await ack(this.token, cq.id);
  }

  // -------------------------------------------------------------------
  // MAIN MENU / NAVIGATION
  // -------------------------------------------------------------------
  async showMainMenu(uid, s) {
    await this.clearTransientMessages(uid, s);
    s.mode = null;
    s.state = "idle";
    s.awaiting_edit = false;
    s.awaiting_thumb_photo = false;
    s.preview_index = 0;
    s.preview_control_id = null;
    await this.state.storage.put("session", s);
    await send(this.token, uid,
      "<b>Channel File Manager</b>\n\nChoose an action from the keyboard below.",
      mainKeyboard()
    );
  }

  async backToMenu(uid, s) {
    await this.clearTransientMessages(uid, s);
    s.mode = null;
    s.state = "idle";
    s.awaiting_edit = false;
    s.awaiting_thumb_photo = false;
    s.preview_index = 0;
    s.preview_control_id = null;
    await this.state.storage.put("session", s);

    // Remove the current mode keyboard first. The next main-menu message restores it.
    await send(this.token, uid, "Returning to the main menu.", removeKeyboard());
    await send(this.token, uid, "<b>Main Menu</b>", mainKeyboard());
  }

  async cancelToMain(uid, s) {
    await this.clearTransientMessages(uid, s);
    s.mode = null;
    s.state = "idle";
    s.items = [];
    s.awaiting_edit = false;
    s.awaiting_thumb_photo = false;
    s.preview_index = 0;
    s.preview_control_id = null;
    await this.state.storage.put("session", s);
    await send(this.token, uid, "Operation cancelled.", removeKeyboard());
    await send(this.token, uid, "<b>Main Menu</b>", mainKeyboard());
  }

  async clearTransientMessages(uid, s) {
    for (const id of [s.status_id, s.ready_message_id, s.progress_message_id, s.preview_control_id]) {
      if (id) await del(this.token, uid, id);
    }
    s.status_id = null;
    s.ready_message_id = null;
    s.progress_message_id = null;
    s.preview_control_id = null;
  }

  // -------------------------------------------------------------------
  // FILE RENAME
  // -------------------------------------------------------------------
  async enterRename(uid, s) {
    s.mode = "rename";
    s.owner_id = uid;
    if (!Array.isArray(s.items)) s.items = [];
    if (!s.items.length) s.state = "rename_collecting";
    s.awaiting_edit = false;
    s.preview_index = 0;
    await this.state.storage.put("session", s);

    // Never create a second status message when entering the same mode again.
    if (s.status_id) {
      await edit(this.token, uid, s.status_id, renameStatusText(s.items.length), renameCollectKeyboard());
      return;
    }

    const m = await send(this.token, uid, renameStatusText(s.items.length), renameCollectKeyboard());
    s.status_id = m?.message_id || null;
    await this.state.storage.put("session", s);
  }

  async collect(msg, s) {
    const item = getFile(msg);
    if (!item) return;
    if (!Array.isArray(s.items)) s.items = [];

    if (s.items.some(x => x.file_id === item.file_id)) return;

    s.items.push(item);
    s.owner_id = s.owner_id || String(msg.from?.id || "");
    s.state = "rename_collecting";
    await this.state.storage.put("session", s);

    // One message only: edit the original counter from 1 -> 2 -> 3...
    if (s.status_id) {
      const ok = await edit(this.token, s.owner_id, s.status_id,
        renameStatusText(s.items.length), renameCollectKeyboard());
      if (ok) return;
    }

    const m = await send(this.token, s.owner_id,
      renameStatusText(s.items.length), renameCollectKeyboard());
    s.status_id = m?.message_id || null;
    await this.state.storage.put("session", s);
  }

  async renameDone(uid, s) {
    if (!s.items?.length) {
      return send(this.token, uid, "No files have been collected yet.", renameCollectKeyboard());
    }

    s.items = s.items.map(x => x.override ? x : { ...x, formatted: formatFilename(x.filename) });
    s.state = "rename_ready";
    s.awaiting_edit = false;
    s.preview_index = 0;

    if (s.status_id) {
      await del(this.token, uid, s.status_id);
      s.status_id = null;
    }
    await this.state.storage.put("session", s);

    const text = `<b>${s.items.length} file(s) ready.</b>\n\nSelect <b>Preview</b> to review the actual files.`;
    if (s.ready_message_id) await del(this.token, uid, s.ready_message_id);

    // Reply keyboards cannot be attached to an inline-keyboard message.
    // This single message replaces Done/Cancel with the ready-mode keyboard.
    const m = await send(this.token, uid, text, renameReadyKeyboard());
    s.ready_message_id = m?.message_id || null;
    await this.state.storage.put("session", s);
  }

  async renamePreview(uid, s) {
    if (!s.items?.length) return send(this.token, uid, "No files have been collected yet.", renameReadyKeyboard());

    // Start from the first item every time Preview is pressed.
    s.preview_index = 0;
    if (s.preview_control_id) {
      await del(this.token, uid, s.preview_control_id);
      s.preview_control_id = null;
    }
    await this.state.storage.put("session", s);
    await this.sendPreviewBatch(uid, s, true);
  }

  async sendPreviewBatch(uid, s, firstBatch) {
    const start = Number(s.preview_index || 0);
    const end = Math.min(start + PREVIEW_BATCH_SIZE, s.items.length);

    for (let i = start; i < end; i++) {
      const item = s.items[i];
      try {
        await sendFile(this.token, uid, item, true);
      } catch (e) {
        console.error("Preview send failed:", e);
        await send(this.token, uid, `<b>Preview error</b>\nFile ${i + 1} could not be displayed: ${esc(e.message || "Unknown error")}`);
      }
      if (i < end - 1) await sleep(INTERVAL);
    }

    s.preview_index = end;

    const remaining = s.items.length - end;
    const rows = [];
    if (remaining > 0) {
      rows.push([{ text: "Continue", callback_data: "preview_continue" }, { text: "Send Post", callback_data: "send" }]);
    } else {
      rows.push([{ text: "Send Post", callback_data: "send" }]);
    }

    const control = await send(this.token, uid,
      remaining > 0
        ? `<b>Preview complete for this batch.</b>\n\n${remaining} file(s) remaining.`
        : `<b>Preview complete.</b>\n\nAll ${s.items.length} file(s) have been previewed.`,
      { inline_keyboard: rows }
    );
    s.preview_control_id = control?.message_id || null;
    await this.state.storage.put("session", s);
  }

  async renameViewData(uid, s) {
    if (!s.items?.length) return send(this.token, uid, "No files have been collected yet.", renameReadyKeyboard());
    const list = s.items.map((x, i) => `${i + 1}. ${esc(x.filename)}`).join("\n");
    await send(this.token, uid, `<b>Original File Data</b>\n\n${list}`, renameReadyKeyboard());
  }

  async renameEditPrompt(uid, s) {
    if (!s.items?.length) return send(this.token, uid, "No files have been collected yet.", renameReadyKeyboard());
    s.awaiting_edit = true;
    await this.state.storage.put("session", s);
    const list = s.items.map((x, i) => `${i + 1}. ${esc(x.filename)}`).join("\n");
    await send(this.token, uid,
      `<b>Edit File Name</b>\n\n${list}\n\nSend the file number followed by the new file name.\n\nExample: <code>2 Pathaan (2023) 1080p WEB-DL.mkv</code>`,
      renameReadyKeyboard()
    );
  }

  async applyEdit(uid, s, text) {
    const m = text.match(/^(\d+)\s+(.+)$/s);
    if (!m) return send(this.token, uid, "Invalid format. Use: <code>number new_name</code>", renameReadyKeyboard());

    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= s.items.length) {
      return send(this.token, uid, "No file exists with that number.", renameReadyKeyboard());
    }

    let name = m[2].trim();
    const item = s.items[idx];
    if (!EXT_RE.test(name)) {
      const origExt = (item.filename.match(EXT_RE) || [""])[0];
      name += origExt;
    }

    item.formatted = name;
    item.override = true;
    s.awaiting_edit = false;
    await this.state.storage.put("session", s);
    await send(this.token, uid, `File ${idx + 1} updated successfully.\n\n<i>${esc(name)}</i>`, renameReadyKeyboard());
  }

  async renameClearAll(uid, s) {
    if (s.preview_control_id) await del(this.token, uid, s.preview_control_id);
    if (s.ready_message_id) await del(this.token, uid, s.ready_message_id);
    s.items = [];
    s.awaiting_edit = false;
    s.state = "rename_collecting";
    s.preview_index = 0;
    s.preview_control_id = null;
    s.ready_message_id = null;
    await this.state.storage.put("session", s);

    if (s.status_id) {
      await edit(this.token, uid, s.status_id, renameStatusText(0), renameCollectKeyboard());
    } else {
      const m = await send(this.token, uid, renameStatusText(0), renameCollectKeyboard());
      s.status_id = m?.message_id || null;
      await this.state.storage.put("session", s);
    }
  }

  async renameCancel(uid, s) {
    if (s.state === "rename_sending") {
      return send(this.token, uid, "Files are currently being sent. Please wait until the operation finishes.");
    }
    await this.clearTransientMessages(uid, s);
    s.mode = null;
    s.state = "idle";
    s.items = [];
    s.awaiting_edit = false;
    s.preview_index = 0;
    await this.state.storage.put("session", s);
    await send(this.token, uid, "File Rename cancelled.", removeKeyboard());
    await send(this.token, uid, "<b>Main Menu</b>", mainKeyboard());
  }

  // -------------------------------------------------------------------
  // ADD THUMBNAIL
  // -------------------------------------------------------------------
  async enterThumb(uid, s) {
    s.mode = "thumb";
    s.owner_id = uid;
    s.awaiting_thumb_photo = false;
    await this.state.storage.put("session", s);

    const text = s.thumb_file_id
      ? "<b>Add Thumbnail</b>\n\nA thumbnail is currently set. You can replace it, preview it, or remove it."
      : "<b>Add Thumbnail</b>\n\nNo thumbnail is set. Select <b>Set</b> and then send a photo.";

    await send(this.token, uid, text, thumbKeyboard());
  }

  async handleThumbMsg(uid, s, msg, text) {
    if (text === "Set") {
      s.awaiting_thumb_photo = true;
      await this.state.storage.put("session", s);
      return send(this.token, uid, "Send a photo now. It will be saved as the thumbnail.", thumbKeyboard());
    }

    if (text === "Preview") {
      if (!s.thumb_file_id) return send(this.token, uid, "No thumbnail is currently set.", thumbKeyboard());
      return sendPhoto(this.token, uid, s.thumb_file_id, "Current thumbnail", thumbKeyboard());
    }

    if (text === "Remove") {
      s.thumb_file_id = null;
      s.awaiting_thumb_photo = false;
      await this.state.storage.put("session", s);
      return send(this.token, uid, "Thumbnail removed.", thumbKeyboard());
    }

    if (s.awaiting_thumb_photo && msg.photo?.length) {
      // Use the smallest Telegram photo variant. It is JPEG and is much more likely
      // to satisfy Telegram's thumbnail size limits than the largest photo variant.
      const best = msg.photo[0];
      s.thumb_file_id = best.file_id;
      s.awaiting_thumb_photo = false;
      await this.state.storage.put("session", s);
      return send(this.token, uid,
        "Thumbnail saved successfully. Send a video or file and the saved thumbnail will be attached.",
        thumbKeyboard()
      );
    }

    if (msg.video || msg.document) {
      if (!s.thumb_file_id) return send(this.token, uid, "Set a thumbnail first.", thumbKeyboard());
      return this.applyThumb(uid, msg, s.thumb_file_id);
    }

    if (text === "Back") return this.backToMenu(uid, s);
  }

  async applyThumb(uid, msg, thumbFileId) {
    const item = getFile(msg);
    if (!item) return;

    const wait = await send(this.token, uid, "Applying thumbnail...");
    try {
      const thumbBuf = await downloadTelegramFile(this.token, thumbFileId);
      await sendFileWithThumb(this.token, uid, item, thumbBuf, item.filename);
      if (wait?.message_id) await del(this.token, uid, wait.message_id);
    } catch (e) {
      console.error("applyThumb failed:", e);
      if (wait?.message_id) {
        await edit(this.token, uid, wait.message_id,
          `<b>Thumbnail could not be applied.</b>\n\n${esc(e.message || "Telegram rejected the thumbnail.")}`,
          thumbKeyboard()
        );
      } else {
        await send(this.token, uid, "Thumbnail could not be applied. Please try another photo.", thumbKeyboard());
      }
    }
  }

  // -------------------------------------------------------------------
  // SEND TO DATABASE CHANNEL
  // -------------------------------------------------------------------
  async startSending(uid, s) {
    if (s.state !== "rename_ready" || !s.items?.length) {
      return send(this.token, uid, "No ready files are available. Complete File Rename first.");
    }
    if (s.state === "rename_sending") return;

    if (!this.env.DATABASE_CHANNEL_ID) {
      console.error("DATABASE_CHANNEL_ID is not set.");
      return send(this.token, uid, "Cannot send because DATABASE_CHANNEL_ID is not configured.");
    }

    if (s.ready_message_id) {
      await del(this.token, uid, s.ready_message_id);
      s.ready_message_id = null;
    }
    if (s.preview_control_id) {
      await del(this.token, uid, s.preview_control_id);
      s.preview_control_id = null;
    }

    const total = s.items.length;
    s.state = "rename_sending";
    s.sent = 0;
    s.total = total;
    const m = await send(this.token, uid, `<b>Sending started.</b>\n\n0/${total} sent.`);
    s.progress_message_id = m?.message_id || null;
    await this.state.storage.put("session", s);
    await this.state.storage.setAlarm(Date.now());
  }

  async alarm() {
    const s = await this.getSession();
    if (s.state !== "rename_sending" || !s.items?.length) return;

    if (!this.env.DATABASE_CHANNEL_ID) {
      await send(this.token, s.owner_id, "Sending stopped because DATABASE_CHANNEL_ID is not configured.");
      return;
    }

    try {
      const item = s.items.shift();
      await sendFile(this.token, this.env.DATABASE_CHANNEL_ID, item, false);

      s.sent = (s.sent || 0) + 1;
      const total = s.total || s.sent;

      if (s.items.length) {
        if (s.progress_message_id) {
          await edit(this.token, s.owner_id, s.progress_message_id,
            `<b>Sending...</b>\n\n${s.sent}/${total} sent.`);
        }
        await this.state.storage.put("session", s);
        await this.state.storage.setAlarm(Date.now() + INTERVAL);
        return;
      }

      if (s.progress_message_id) {
        await edit(this.token, s.owner_id, s.progress_message_id,
          `<b>Completed.</b>\n\n${s.sent}/${total} file(s) sent to the database channel.`);
      } else {
        await send(this.token, s.owner_id,
          `<b>Completed.</b>\n\n${s.sent}/${total} file(s) sent to the database channel.`);
      }

      const owner = s.owner_id;
      s.mode = null;
      s.state = "idle";
      s.items = [];
      s.status_id = null;
      s.ready_message_id = null;
      s.progress_message_id = null;
      s.preview_control_id = null;
      s.awaiting_edit = false;
      s.preview_index = 0;
      await this.state.storage.put("session", s);

      await send(this.token, owner, "<b>Main Menu</b>", mainKeyboard());
    } catch (e) {
      console.error("Scheduled send failed:", e);
      await this.state.storage.put("session", s);
      await this.state.storage.setAlarm(Date.now() + INTERVAL);
    }
  }

  async getSession() {
    const s = await this.state.storage.get("session");
    return s || {
      mode: null,
      state: "idle",
      items: [],
      owner_id: null,
      status_id: null,
      ready_message_id: null,
      progress_message_id: null,
      preview_control_id: null,
      preview_index: 0,
      thumb_file_id: null,
      awaiting_edit: false,
      awaiting_thumb_photo: false
    };
  }

  get token() { return this.env.BOT_TOKEN; }
}

// ---------------------------------------------------------------------
// FILE HELPERS
// ---------------------------------------------------------------------
function getFile(msg) {
  if (msg.document) return {
    type: "document",
    file_id: msg.document.file_id,
    filename: msg.document.file_name || `file_${msg.message_id}`,
    unique_id: msg.document.file_unique_id,
    thumb_file_id: msg.document.thumbnail?.file_id || msg.document.thumb?.file_id || null
  };
  if (msg.video) return {
    type: "video",
    file_id: msg.video.file_id,
    filename: msg.video.file_name || captionFilename(msg.caption) || `video_${msg.message_id}.mp4`,
    unique_id: msg.video.file_unique_id,
    thumb_file_id: msg.video.thumbnail?.file_id || msg.video.thumb?.file_id || null
  };
  return null;
}

function captionFilename(c) {
  const m = String(c || "").match(/([^\n]+\.(?:mkv|mp4|avi|mov|webm|wmv|flv|m4v|ts))$/i);
  return m?.[1]?.trim() || null;
}

function formatFilename(filename) {
  const ext = (String(filename).match(EXT_RE) || [""])[0];
  let n = ext ? String(filename).slice(0, -ext.length) : String(filename);

  n = n.replace(/\s*[\(\[]?\s*(?:MVZMod[- ]?Zone|MVZMod|Mov4kHub)\s*[\)\]]?\s*$/i, "").trim();

  const res = take(n, /\b(2160p|1440p|1080p|720p|576p|480p|360p)\b/i);
  const bit = take(n, /\b(8|10|12)Bit\b/i);
  const sources = all(n, /\b(WEBRip|WEB-DL|WEBDL|BluRay|BRRip|HDRip|HDTV|DVDRip|AMZN|NF|DSNP|MAX|ATVP|CR|HMAX)\b/gi);
  const langs = languageList(n);
  const subs = /\bESubs?\b/i.test(n);

  let title = n
    .replace(/\b(?:2160p|1440p|1080p|720p|576p|480p|360p)\b/gi, "")
    .replace(/\b(?:8|10|12)Bit\b/gi, "")
    .replace(/\b(?:WEBRip|WEB-DL|WEBDL|BluRay|BRRip|HDRip|HDTV|DVDRip|AMZN|NF|DSNP|MAX|ATVP|CR|HMAX)\b/gi, "")
    .replace(/\b(?:HINDI|ENG|ENGLISH|KOR|KOREAN|TAMIL|TELUGU|MALAYALAM|BENGALI|JAPANESE|CHINESE|FRENCH|SPANISH|ARABIC)\b/gi, "")
    .replace(/\bESubs?\b/gi, "")
    .replace(/\s{2,}/g, " ").trim();

  const parts = [title, ...sources.map(normSource)];
  if (res) parts.push(res.toLowerCase());
  if (bit) parts.push(bit.replace(/bit$/i, "Bit"));
  if (langs.length) parts.push(langs.join(" - "));
  if (subs) parts.push("ESubs");

  return `F : @backup2k24 ${parts.join(" ")} | Full Movie - Mov4kHub${ext}`;
}

function languageList(n) {
  const map = {
    HINDI: "Hindi", ENG: "English", ENGLISH: "English", KOR: "Korean",
    KOREAN: "Korean", TAMIL: "Tamil", TELUGU: "Telugu", MALAYALAM: "Malayalam",
    BENGALI: "Bengali", JAPANESE: "Japanese", CHINESE: "Chinese",
    FRENCH: "French", SPANISH: "Spanish", ARABIC: "Arabic"
  };
  const m = n.match(/\b(?:HINDI|ENG|ENGLISH|KOR|KOREAN|TAMIL|TELUGU|MALAYALAM|BENGALI|JAPANESE|CHINESE|FRENCH|SPANISH|ARABIC)(?:[-+&](?:HINDI|ENG|ENGLISH|KOR|KOREAN|TAMIL|TELUGU|MALAYALAM|BENGALI|JAPANESE|CHINESE|FRENCH|SPANISH|ARABIC))+\b/i);
  if (!m) return [];
  return m[0].toUpperCase().split(/[-+&]/).map(x => map[x.trim()]).filter(Boolean);
}

function take(s, re) { return s.match(re)?.[1] || ""; }
function all(s, re) { return [...s.matchAll(re)].map(x => normSource(x[1])).filter((x, i, a) => a.indexOf(x) === i); }
function normSource(x) {
  const m = {
    WEBRIP: "WEBRip", "WEB-DL": "WEB-DL", WEBDL: "WEB-DL", BLURAY: "BluRay",
    BRRIP: "BRRip", HDRIP: "HDRip", DVDRIP: "DVDRip", AMZN: "AMZN", NF: "NF",
    DSNP: "DSNP", MAX: "MAX", ATVP: "ATVP", CR: "CR", HMAX: "HMAX"
  };
  return m[String(x).toUpperCase()] || x;
}

// Sends a file while preserving the original thumbnail when possible.
async function sendFile(token, chat, item, isPreview = false) {
  const formatted = item.formatted || formatFilename(item.filename);
  const caption = isPreview
    ? `<b>Preview ${esc(formatted)}</b>`
    : `<b>${esc(formatted)}</b>`;

  if (item.thumb_file_id) {
    try {
      const buf = await downloadTelegramFile(token, item.thumb_file_id);
      return await sendFileWithThumb(token, chat, item, buf, null, caption);
    } catch (e) {
      console.error("Thumbnail preserve failed:", e);
    }
  }

  return api(token, item.type === "video" ? "sendVideo" : "sendDocument", {
    chat_id: chat,
    [item.type === "video" ? "video" : "document"]: item.file_id,
    caption,
    parse_mode: "HTML"
  });
}

async function downloadTelegramFile(token, fileId) {
  const info = await api(token, "getFile", { file_id: fileId });
  if (!info?.file_path) throw new Error("Telegram did not return a file path.");
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
  if (!r.ok) throw new Error(`Failed to download thumbnail: HTTP ${r.status}`);
  return await r.arrayBuffer();
}

async function sendFileWithThumb(token, chatId, item, thumbBuf, plainFilename, htmlCaption) {
  if (thumbBuf.byteLength > 200 * 1024) {
    throw new Error("The thumbnail is larger than Telegram's 200 KB thumbnail limit. Please use a smaller image.");
  }

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(item.type === "video" ? "video" : "document", item.file_id);
  form.append("thumbnail", new Blob([thumbBuf], { type: "image/jpeg" }), "thumb.jpg");

  const caption = htmlCaption || (plainFilename ? `<b>${esc(plainFilename)}</b>` : "");
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }

  const method = item.type === "video" ? "sendVideo" : "sendDocument";
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form });
  const d = await r.json();
  if (!r.ok || !d.ok) throw new Error(d.description || `Telegram HTTP ${r.status}`);
  return d.result;
}

// ---------------------------------------------------------------------
// KEYBOARDS  no emoji in keyboard buttons
// ---------------------------------------------------------------------
function mainKeyboard() {
  return {
    keyboard: [[{ text: "Add Thumbnail" }, { text: "File Rename" }]],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false
  };
}

function renameCollectKeyboard() {
  return {
    keyboard: [[{ text: "Done" }, { text: "Cancel" }]],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false
  };
}

function renameReadyKeyboard() {
  return {
    keyboard: [
      [{ text: "Preview" }, { text: "Edit Data" }],
      [{ text: "View Data" }, { text: "Clear All" }],
      [{ text: "Back" }]
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false
  };
}

function thumbKeyboard() {
  return {
    keyboard: [
      [{ text: "Set" }, { text: "Preview" }, { text: "Remove" }],
      [{ text: "Back" }]
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false
  };
}

function removeKeyboard() {
  return { remove_keyboard: true };
}

function renameStatusText(count) {
  if (!count) {
    return "<b>File Rename</b>\n\nSend video or document files. They will be collected here.\n\nPress <b>Done</b> when you have finished.";
  }
  return `<b>${count} file(s) collected.</b>\n\nSend more files or press <b>Done</b>.`;
}

// ---------------------------------------------------------------------
// TELEGRAM API HELPERS
// ---------------------------------------------------------------------
async function send(token, chatId, text, replyMarkup) {
  const p = { chat_id: chatId, text, parse_mode: "HTML" };
  if (replyMarkup) p.reply_markup = replyMarkup;
  return api(token, "sendMessage", p);
}

async function sendPhoto(token, chatId, photo, caption, replyMarkup) {
  const p = { chat_id: chatId, photo };
  if (caption) {
    p.caption = caption;
    p.parse_mode = "HTML";
  }
  if (replyMarkup) p.reply_markup = replyMarkup;
  return api(token, "sendPhoto", p);
}

async function edit(token, chatId, messageId, text, replyMarkup) {
  try {
    const p = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" };
    if (replyMarkup) p.reply_markup = replyMarkup;
    await api(token, "editMessageText", p);
    return true;
  } catch (e) {
    if (String(e.message || "").toLowerCase().includes("message is not modified")) return true;
    console.error("edit failed:", e);
    return false;
  }
}

async function ack(token, id, text) {
  const p = { callback_query_id: id };
  if (text) p.text = text;
  return api(token, "answerCallbackQuery", p);
}

async function del(token, chatId, messageId) {
  if (!messageId) return;
  try { await api(token, "deleteMessage", { chat_id: chatId, message_id: messageId }); }
  catch (_) {}
}

async function api(token, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const d = await r.json();
  if (!r.ok || !d.ok) throw new Error(d.description || `Telegram HTTP ${r.status}`);
  return d.result;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}