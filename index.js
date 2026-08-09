const CHANNEL_ID = "-1004378372197";
const ADMIN_START_MESSAGE =
  "Please send files to the channel. I don't work with files in private chat.";

const EXT_RE = /\.(mkv|mp4|avi|mov|webm|wmv|flv|m4v|ts)$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Bot is running.");
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (env.WEBHOOK_SECRET && !same(secret, env.WEBHOOK_SECRET)) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      await handleUpdate(update, env);
    } catch (error) {
      console.error("Update handling failed:", error);
    }

    // Always answer Telegram quickly.
    return new Response("OK");
  }
};

async function handleUpdate(update, env) {
  if (!env.BOT_TOKEN) {
    console.error("BOT_TOKEN is not set.");
    return;
  }

  // ---------------------------------------------------------------
  // PRIVATE CHAT:
  // Only an admin can use /start. Everything else is ignored.
  // ---------------------------------------------------------------
  const privateMessage = update?.message;
  if (privateMessage?.chat?.type === "private") {
    const uid = String(privateMessage.from?.id ?? "");
    if (!isAdmin(uid, env)) return;

    const text = typeof privateMessage.text === "string"
      ? privateMessage.text.trim()
      : "";

    if (text === "/start") {
      await sendMessage(env.BOT_TOKEN, uid, ADMIN_START_MESSAGE);
    }

    // Ignore all private files/messages/commands.
    return;
  }

  // ---------------------------------------------------------------
  // CHANNEL:
  // Only the configured channel is processed.
  // Bot does NOT send the file anywhere. It edits only the caption
  // of the existing channel post, so Telegram keeps the original
  // file/media and its existing thumbnail.
  // ---------------------------------------------------------------
  const channelPost = update?.channel_post;
  if (!channelPost) return;

  const chatId = String(channelPost.chat?.id ?? "");
  if (chatId !== CHANNEL_ID) return;

  const item = getChannelFile(channelPost);
  if (!item) return;

  const newCaption = formatFilename(item.filename);

  // If the caption is already exactly the desired text, do nothing.
  if (normalizeHtml(channelPost.caption || "") === normalizeHtml(newCaption)) {
    return;
  }

  try {
    await editMessageCaption(
      env.BOT_TOKEN,
      CHANNEL_ID,
      channelPost.message_id,
      newCaption
    );
  } catch (error) {
    // "Message is not modified" is harmless.
    if (!String(error?.message || "").toLowerCase().includes("message is not modified")) {
      console.error(
        `Caption edit failed for channel message ${channelPost.message_id}:`,
        error
      );
    }
  }
}

function isAdmin(uid, env) {
  const admins = String(env.ADMIN_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  return Boolean(uid) && admins.includes(uid);
}

function getChannelFile(msg) {
  if (msg.document) {
    return {
      type: "document",
      filename:
        msg.document.file_name ||
        captionFilename(msg.caption) ||
        `file_${msg.message_id}`
    };
  }

  if (msg.video) {
    return {
      type: "video",
      filename:
        msg.video.file_name ||
        captionFilename(msg.caption) ||
        `video_${msg.message_id}.mp4`
    };
  }

  return null;
}

function captionFilename(caption) {
  const match = String(caption || "").match(
    /([^\n]+\.(?:mkv|mp4|avi|mov|webm|wmv|flv|m4v|ts))$/i
  );

  return match?.[1]?.trim() || null;
}

function formatFilename(filename) {
  const original = String(filename || "").trim();
  const ext = (original.match(EXT_RE) || [""])[0];

  let n = ext ? original.slice(0, -ext.length) : original;

  n = n
    .replace(
      /\s*[\(\[]?\s*(?:MVZMod[- ]?Zone|MVZMod|Mov4kHub)\s*[\)\]]?\s*$/i,
      ""
    )
    .trim();

  const resolution = take(
    n,
    /\b(2160p|1440p|1080p|720p|576p|480p|360p)\b/i
  );

  const bit = take(n, /\b(8|10|12)Bit\b/i);

  const sources = all(
    n,
    /\b(WEBRip|WEB-DL|WEBDL|BluRay|BRRip|HDRip|HDTV|DVDRip|AMZN|NF|DSNP|MAX|ATVP|CR|HMAX)\b/gi
  );

  const langs = languageList(n);
  const subs = /\bESubs?\b/i.test(n);

  let title = n
    .replace(/\b(?:2160p|1440p|1080p|720p|576p|480p|360p)\b/gi, "")
    .replace(/\b(?:8|10|12)Bit\b/gi, "")
    .replace(
      /\b(?:WEBRip|WEB-DL|WEBDL|BluRay|BRRip|HDRip|HDTV|DVDRip|AMZN|NF|DSNP|MAX|ATVP|CR|HMAX)\b/gi,
      ""
    )
    .replace(
      /\b(?:HINDI|ENG|ENGLISH|KOR|KOREAN|TAMIL|TELUGU|MALAYALAM|BENGALI|JAPANESE|CHINESE|FRENCH|SPANISH|ARABIC)\b/gi,
      ""
    )
    .replace(/\bESubs?\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const parts = [title, ...sources.map(normSource)];

  if (resolution) parts.push(resolution.toLowerCase());
  if (bit) parts.push(bit.replace(/bit$/i, "Bit"));
  if (langs.length) parts.push(langs.join(" - "));
  if (subs) parts.push("ESubs");

  return `Fɪʟᴇɴᴀᴍᴇ : @backup2k24 ${parts.join(" ")} | Full Movie - Mov4kHub${ext}`;
}

function languageList(n) {
  const map = {
    HINDI: "Hindi",
    ENG: "English",
    ENGLISH: "English",
    KOR: "Korean",
    KOREAN: "Korean",
    TAMIL: "Tamil",
    TELUGU: "Telugu",
    MALAYALAM: "Malayalam",
    BENGALI: "Bengali",
    JAPANESE: "Japanese",
    CHINESE: "Chinese",
    FRENCH: "French",
    SPANISH: "Spanish",
    ARABIC: "Arabic"
  };

  const match = String(n).match(
    /\b(?:HINDI|ENG|ENGLISH|KOR|KOREAN|TAMIL|TELUGU|MALAYALAM|BENGALI|JAPANESE|CHINESE|FRENCH|SPANISH|ARABIC)(?:[-+&](?:HINDI|ENG|ENGLISH|KOR|KOREAN|TAMIL|TELUGU|MALAYALAM|BENGALI|JAPANESE|CHINESE|FRENCH|SPANISH|ARABIC))+\b/i
  );

  if (!match) return [];

  return match[0]
    .toUpperCase()
    .split(/[-+&]/)
    .map(x => map[x.trim()])
    .filter(Boolean);
}

function take(s, re) {
  return String(s).match(re)?.[1] || "";
}

function all(s, re) {
  return [...String(s).matchAll(re)]
    .map(x => normSource(x[1]))
    .filter((x, i, a) => a.indexOf(x) === i);
}

function normSource(value) {
  const map = {
    WEBRIP: "WEBRip",
    "WEB-DL": "WEB-DL",
    WEBDL: "WEB-DL",
    BLURAY: "BluRay",
    BRRIP: "BRRip",
    HDRIP: "HDRip",
    DVDRIP: "DVDRip",
    AMZN: "AMZN",
    NF: "NF",
    DSNP: "DSNP",
    MAX: "MAX",
    ATVP: "ATVP",
    CR: "CR",
    HMAX: "HMAX"
  };

  return map[String(value).toUpperCase()] || value;
}

async function sendMessage(token, chatId, text) {
  return telegram(token, "sendMessage", {
    chat_id: chatId,
    text
  });
}

async function editMessageCaption(token, chatId, messageId, caption) {
  return telegram(token, "editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "HTML"
  });
}

async function telegram(token, method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      data.description || `Telegram HTTP ${response.status}`
    );
  }

  return data.result;
}

function normalizeHtml(value) {
  return String(value || "").trim();
}

function same(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
