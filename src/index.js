import { DurableObject } from "cloudflare:workers";

export class ThumbStore extends DurableObject {
  async getData() {
    const data = await this.ctx.storage.get("data");
    return data || { thumbFileId: null, mode: "idle" };
  }

  async setData(data) {
    await this.ctx.storage.put("data", data);
    return true;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running", { status: 200 });
    }

    if (env.WEBHOOK_SECRET) {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK");
  },
};

function getThumbStub(env, chatId) {
  const id = env.THUMB_STORE.idFromName(String(chatId));
  return env.THUMB_STORE.get(id);
}

async function tgApiJson(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function tgApiForm(env, method, formData) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

async function getFilePath(env, fileId) {
  const data = await tgApiJson(env, "getFile", { file_id: fileId });
  if (!data.ok) throw new Error("getFile failed: " + JSON.stringify(data));
  return data.result.file_path;
}

async function downloadTelegramFile(env, filePath) {
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
  if (!res.ok) throw new Error("File download failed: " + res.status);
  return await res.blob();
}

async function sendVideoWithThumb(env, chatId, video, thumbFileId, caption) {
  const filePath = await getFilePath(env, thumbFileId);
  const blob = await downloadTelegramFile(env, filePath);

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("video", video.file_id);
  form.append("thumbnail", blob, "thumb.jpg");
  if (video.duration) form.append("duration", String(video.duration));
  if (video.width) form.append("width", String(video.width));
  if (video.height) form.append("height", String(video.height));
  if (caption) form.append("caption", caption);

  return tgApiForm(env, "sendVideo", form);
}

const MAIN_KEYBOARD = {
  keyboard: [[{ text: "Add Thumbnail" }, { text: "Edit Thumbnail" }]],
  resize_keyboard: true,
  is_persistent: true,
};

const START_MESSAGE =
  "Hi \u{1F44B}\n" +
  "This bot lets you add or edit thumbnails on your Telegram videos.\n\n" +
  "\u{1F4CC} Add Thumbnail - set a custom thumbnail on a video\n" +
  "\u{1F4CC} Edit Thumbnail - split a video and its existing thumbnail into two separate files\n\n" +
  "Choose an option below to get started.";

function extractVideo(msg) {
  return (
    msg.video ||
    (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("video/")
      ? msg.document
      : null)
  );
}

async function handleUpdate(update, env) {
  try {
    const msg = update.message;
    if (!msg) return;

    const chatId = msg.chat.id;
    const stub = getThumbStub(env, chatId);

    if (msg.text === "/start") {
      const data = await stub.getData();
      data.mode = "idle";
      data.thumbFileId = null;
      await stub.setData(data);
      await tgApiJson(env, "sendMessage", {
        chat_id: chatId,
        text: START_MESSAGE,
        reply_markup: MAIN_KEYBOARD,
      });
      return;
    }

    if (msg.text === "Add Thumbnail") {
      const data = await stub.getData();
      data.mode = "awaiting_photo_add";
      data.thumbFileId = null;
      await stub.setData(data);
      await tgApiJson(env, "sendMessage", {
        chat_id: chatId,
        text: "Send the photo you want to use as the thumbnail.",
      });
      return;
    }

    if (msg.text === "Edit Thumbnail") {
      const data = await stub.getData();
      data.mode = "awaiting_video_edit";
      data.thumbFileId = null;
      await stub.setData(data);
      await tgApiJson(env, "sendMessage", {
        chat_id: chatId,
        text: "Send the video that already has a thumbnail set on it.",
      });
      return;
    }

    if (msg.photo && msg.photo.length) {
      const data = await stub.getData();

      if (data.mode !== "awaiting_photo_add") {
        await tgApiJson(env, "sendMessage", {
          chat_id: chatId,
          text: "Tap \"Add Thumbnail\" first, then send a photo.",
          reply_markup: MAIN_KEYBOARD,
        });
        return;
      }

      const smallest = msg.photo[0];
      data.thumbFileId = smallest.file_id;
      data.mode = "awaiting_video_add";
      await stub.setData(data);
      await tgApiJson(env, "sendMessage", { chat_id: chatId, text: "Thumb saved. Now send your video \u{1F3AC}" });
      return;
    }

    const video = extractVideo(msg);
    if (video) {
      const data = await stub.getData();

      if (data.mode === "awaiting_video_add" && data.thumbFileId) {
        await tgApiJson(env, "sendMessage", { chat_id: chatId, text: "Setting thumbnail..." });
        const result = await sendVideoWithThumb(env, chatId, video, data.thumbFileId, msg.caption);
        data.mode = "idle";
        data.thumbFileId = null;
        await stub.setData(data);
        if (!result.ok) {
          await tgApiJson(env, "sendMessage", {
            chat_id: chatId,
            text: "Failed to set thumbnail: " + (result.description || "Unknown error"),
            reply_markup: MAIN_KEYBOARD,
          });
        }
        return;
      }

      if (data.mode === "awaiting_video_edit") {
        data.mode = "idle";
        await stub.setData(data);

        if (video.thumb && video.thumb.file_id) {
          await tgApiJson(env, "sendPhoto", {
            chat_id: chatId,
            photo: video.thumb.file_id,
            caption: "Extracted thumbnail",
          });
          await tgApiJson(env, "sendVideo", {
            chat_id: chatId,
            video: video.file_id,
            caption: msg.caption || undefined,
          });
        } else {
          await tgApiJson(env, "sendMessage", {
            chat_id: chatId,
            text: "This video has no existing thumbnail set on it.",
            reply_markup: MAIN_KEYBOARD,
          });
        }
        return;
      }

      await tgApiJson(env, "sendMessage", {
        chat_id: chatId,
        text: "Please choose an option first.",
        reply_markup: MAIN_KEYBOARD,
      });
      return;
    }

    await tgApiJson(env, "sendMessage", {
      chat_id: chatId,
      text: "Choose an option below to get started.",
      reply_markup: MAIN_KEYBOARD,
    });
  } catch (err) {
    console.error("handleUpdate error:", err);
  }
}
