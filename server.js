import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { google } from "googleapis";

dotenv.config();

console.log("🟢 Server boot starting…");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================== ENV ================== */

console.log("🧩 ENV check:", {
  SUPABASE_URL: !!process.env.SUPABASE_URL,
  SUPABASE_KEY: !!process.env.SUPABASE_API_KEY,
  YT_API: !!process.env.YT_DATA_API_V3,
  DISCORD: !!process.env.DISCORD_BOT_TOKEN
});

const {
  SUPABASE_URL,
  SUPABASE_API_KEY,
  SUPABASE_TABLE,
  SUPABASE_YT_TABLE,
  SUPABASE_YT_CHANNEL_TABLE,
  blacklist_yt_channel,
  YT_DATA_API_V3,
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REFRESH_TOKEN,
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  TOOL_USED,
  CRON_SECRET,
  CRON_SECRET_DC_KEEP_ALIVE
} = process.env;

/* ================== HELPERS ================== */

const sbHeaders = {
  apikey: SUPABASE_API_KEY,
  Authorization: `Bearer ${SUPABASE_API_KEY}`,
  "Content-Type": "application/json"
};

const isPlaceholder = v => {
  const result = ["$(user)", "$(chatid)", "$(channelid)", "$(querystring)"].includes(String(v));
  console.log("🔍 isPlaceholder:", v, "=>", result);
  return result;
};

const isValidChatId = id => {
  const ok = typeof id === "string" && id.length >= 22;
  console.log("🔍 isValidChatId:", id, ok);
  return ok;
};

const isValidChannelId = id => {
  const ok = /^UC[a-zA-Z0-9_-]{22}$/.test(id);
  console.log("🔍 isValidChannelId:", id, ok);
  return ok;
};

const formatTimestamp = (start, user, delay) => {
  console.log("⏱ formatTimestamp IN:", { start, user, delay });
  const s = new Date(start);
  const u = new Date(new Date(user).getTime() - delay * 1000);
  let d = Math.max(0, Math.floor((u - s) / 1000));
  const h = Math.floor(d / 3600);
  d %= 3600;
  const m = Math.floor(d / 60);
  const sec = d % 60;
  const ts = h
    ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
    : `${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  console.log("⏱ formatTimestamp OUT:", ts);
  return ts;
};

const tsToSeconds = ts => {
  console.log("🔢 tsToSeconds:", ts);
  const p = ts.split(":").map(Number);
  const sec = p.length === 2 ? p[0]*60+p[1] : p[0]*3600+p[1]*60+p[2];
  console.log("🔢 seconds:", sec);
  return sec;
};

/* ================== SUPABASE ================== */

const chatIdExists = async chatId => {
  console.log("📦 chatIdExists()", chatId);
  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_TABLE}?chat_id=eq.${chatId}&limit=1`,
    { headers: sbHeaders }
  );
  console.log("📦 chatIdExists result:", r.data);
  return r.data.length > 0;
};

const getDiscordChannelId = async channelId => {
  console.log("📦 getDiscordChannelId()", channelId);
  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_CHANNEL_TABLE}?channel_id=eq.${channelId}&select=dc_channel_id`,
    { headers: sbHeaders }
  );
  console.log("📦 Discord channel response:", r.data);
  return r.data?.[0]?.dc_channel_id || null;
};

const getLiveStreamInfo = async channelId => {
  console.log("🎥 getLiveStreamInfo()", channelId);

  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_TABLE}?channel_id=eq.${channelId}&status=eq.live&limit=1`,
    { headers: sbHeaders }
  );

  console.log("🎥 Supabase live rows:", r.data);

  if (!r.data.length) {
    console.warn("⚠️ No live stream row found");
    return {};
  }

  const live = r.data[0];
  console.log("🎬 Live row:", live);

  if (live.stream_start_time) {
    console.log("✅ stream_start_time already present");
    return live;
  }

  console.log("🔥 Hydrating start time from YouTube");

  try {
    const yt = await axios.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "liveStreamingDetails",
          id: live.video_id,
          key: YT_DATA_API_V3
        }
      }
    );

    console.log("📡 YT video details:", yt.data);

    const details = yt.data.items?.[0]?.liveStreamingDetails;
    const startTime =
      details?.actualStartTime ||
      details?.scheduledStartTime ||
      null;

    console.log("🕒 Derived startTime:", startTime);

    if (startTime) {
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_TABLE}?id=eq.${live.id}`,
        { stream_start_time: startTime },
        { headers: sbHeaders }
      );
      console.log("✅ stream_start_time updated in Supabase");
      return { ...live, stream_start_time: startTime };
    }
  } catch (e) {
    console.error("❌ Hydration failed:", {
      video: live.video_id,
      error: e?.response?.data || e.message
    });
  }

  return live;
};

/* ================== DISCORD ================== */

const sendDiscord = async (dcId, videoId, title, msg, user, ts) => {
  console.log("📨 sendDiscord()", {
    dcId, videoId, title, msg, user, ts
  });

  if (!dcId || !videoId || !ts) {
    console.warn("⚠️ Discord send skipped (missing params)");
    return;
  }

  try {
    const start = Date.now();

    await axios.post(
      `https://discord.com/api/v10/channels/${dcId}/messages`,
      {
        embeds: [{
          title: msg || "📎 New Clip",
          url: `https://youtube.com/watch?v=${videoId}&t=${tsToSeconds(ts)}s`,
          image: { url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` },
          fields: [
            { name: "🎬 Stream", value: title || "Unknown" },
            { name: "👤 By", value: user || "Unknown", inline: true },
            { name: "⏰ Time", value: ts, inline: true }
          ]
        }]
      },
      {
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 10_000
      }
    );

    console.log(`✅ Discord sent (${Date.now() - start}ms)`);

  } catch (err) {
    console.error("❌ Discord error:", {
      status: err?.response?.status,
      data: err?.response?.data,
      message: err.message
    });
  }
};

/* ================== YT QUEUE ================== */

let ytQueue = [];
let ytRunning = false;

const processYT = async (chatId, channelId) => {
  console.log("🧵 processYT()", { chatId, channelId });

  const blacklist = await axios.get(
    `${SUPABASE_URL}/rest/v1/${blacklist_yt_channel}?channel_id=eq.${channelId}&limit=1`,
    { headers: sbHeaders }
  );

  if (blacklist.data.length) {
    console.warn("🚫 Channel blacklisted:", channelId);
    return;
  }

  const search = await axios.get(
    "https://www.googleapis.com/youtube/v3/search",
    {
      params: {
        part: "snippet",
        channelId,
        type: "video",
        eventType: "live",
        key: YT_DATA_API_V3
      }
    }
  );

  console.log("📡 YT search items:", search.data.items?.length);

  for (const v of search.data.items || []) {
    console.log("➕ Inserting live video:", v.id.videoId);
    await axios.post(
      `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_TABLE}`,
      {
        chat_id: chatId,
        video_id: v.id.videoId,
        title: v.snippet.title,
        channel_id: channelId,
        status: "live",
        marked: false
      },
      { headers: sbHeaders }
    );
  }
};

setInterval(async () => {
  if (ytRunning || !ytQueue.length) return;
  ytRunning = true;
  const job = ytQueue.shift();
  console.log("🧵 YT worker job:", job);
  try { await processYT(job.chatId, job.channelId); }
  catch (e) { console.error("❌ processYT failed", e.message); }
  ytRunning = false;
}, 1000);

/* ================== ROUTES ================== */

app.all("/api/clip", async (req, res) => {
  console.log("🚨 /api/clip HIT", { body: req.body, query: req.query });

  const user = req.body.user || req.query.user;
  const channelId = req.body.channelid || req.query.channelid;
  const chatId = req.body.chatId || req.query.chatId;
  const msg = req.body.msg || req.query.msg || "";
  const delay = Number(req.body.delay || req.query.delay);

  console.log("🧾 Parsed params:", { user, channelId, chatId, msg, delay });

  if (!user || !channelId || !chatId || Number.isNaN(delay))
    return res.status(400).send("Missing parameters");

  if (isPlaceholder(user) || isPlaceholder(channelId) || isPlaceholder(chatId))
    return res.status(400).send("Nightbot variables unresolved");

  if (!isValidChatId(chatId) || !isValidChannelId(channelId))
    return res.status(400).send("Invalid IDs");

  const now = new Date().toISOString();
  console.log("🕒 now:", now);

  await axios.post(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`,
    {
      channel_id: channelId,
      chat_id: chatId,
      delay,
      message: msg,
      user_name: user,
      user_timestamp: now
    },
    { headers: sbHeaders }
  );

  console.log("✅ Clip inserted");

  if (!(await chatIdExists(chatId))) {
    console.log("➕ Adding to YT queue");
    ytQueue.push({ chatId, channelId });
  }

  const live = await getLiveStreamInfo(channelId);
  console.log("🎯 Live resolved:", live);

  if (DISCORD_CHANNEL_ID && live.video_id && live.stream_start_time) {
    const ts = formatTimestamp(live.stream_start_time, now, delay);
    await sendDiscord(
      DISCORD_CHANNEL_ID,
      live.video_id,
      live.title,
      msg,
      user.replace("@", ""),
      ts
    );
  }

  return res.send(
    `Timestamped (with -${delay}s delay) by ${user}. Tool used: ${TOOL_USED}`
  );
});

/* ================== START ================== */

app.listen(3000, () =>
  console.log("🚀 Server running on port 3000")
);
