import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { google } from "googleapis";

dotenv.config();

/* ================== BOOT ================== */

console.log("🟢 Server booting...");
console.log("🧩 ENV loaded:", {
  SUPABASE_URL: !!process.env.SUPABASE_URL,
  YT_API: !!process.env.YT_DATA_API_V3,
  DISCORD: !!process.env.DISCORD_BOT_TOKEN
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================== ENV ================== */

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

const isPlaceholder = v =>
  ["$(user)", "$(chatid)", "$(channelid)", "$(querystring)"].includes(String(v));

const isValidChatId = id => typeof id === "string" && id.length >= 22;
const isValidChannelId = id => /^UC[a-zA-Z0-9_-]{22}$/.test(id);

const formatTimestamp = (start, user, delay) => {
  console.log("⏱ formatTimestamp()", { start, user, delay });
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
  console.log("⏱ formatted TS =", ts);
  return ts;
};

const tsToSeconds = ts => {
  console.log("🔢 tsToSeconds()", ts);
  const p = ts.split(":").map(Number);
  const seconds =
    p.length === 2 ? p[0]*60+p[1] : p[0]*3600+p[1]*60+p[2];
  console.log("🔢 seconds =", seconds);
  return seconds;
};

/* ================== SUPABASE ================== */

const chatIdExists = async chatId => {
  console.log("🔍 chatIdExists()", chatId);
  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_TABLE}?chat_id=eq.${chatId}&limit=1`,
    { headers: sbHeaders }
  );
  console.log("📦 chatIdExists result:", r.data);
  return r.data.length > 0;
};

const getDiscordChannelId = async channelId => {
  console.log("🔍 getDiscordChannelId()", channelId);
  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_CHANNEL_TABLE}?channel_id=eq.${channelId}&select=dc_channel_id`,
    { headers: sbHeaders }
  );
  console.log("📦 Discord channel lookup:", r.data);
  return r.data?.[0]?.dc_channel_id || null;
};

const getLiveStreamInfo = async channelId => {
  console.log("🎥 getLiveStreamInfo()", channelId);
  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_TABLE}?channel_id=eq.${channelId}&status=eq.live&limit=1`,
    { headers: sbHeaders }
  );

  console.log("📦 Live rows:", r.data);

  if (!r.data.length) {
    console.warn("⚠️ No live stream found");
    return {};
  }

  const live = r.data[0];
  console.log("🎬 Live stream row:", live);

  if (live.stream_start_time) {
    console.log("✅ Stream start time already present");
    return live;
  }

  console.log("🔥 Hydrating stream start time from YouTube API");
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

    console.log("📡 YouTube details:", yt.data);

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
      console.log("✅ Supabase stream_start_time updated");
      return { ...live, stream_start_time: startTime };
    }
  } catch (e) {
    console.error("❌ Failed to hydrate stream start time", {
      video: live.video_id,
      error: e?.response?.data || e.message
    });
  }

  return live;
};

/* ================== DISCORD ================== */

const sendDiscord = async (dcId, videoId, title, msg, user, ts) => {
  console.log("📨 sendDiscord()", {
    dcId,
    videoId,
    title,
    msg,
    user,
    ts
  });

  if (!dcId || !videoId || !ts) {
    console.warn("⚠️ Discord send skipped — missing params");
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
          image: {
            url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
          },
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
    console.log(`✅ Discord sent in ${Date.now() - start}ms`);
  } catch (err) {
    console.error("❌ Discord send failed", {
      status: err?.response?.status,
      data: err?.response?.data,
      msg: err.message
    });
  }
};

/* ================== ROUTE ================== */

app.all("/api/clip", async (req, res) => {
  console.log("🚨 /api/clip HIT", {
    body: req.body,
    query: req.query
  });

  try {
    const user = req.body.user || req.query.user;
    const channelId = req.body.channelid || req.query.channelid;
    const chatId = req.body.chatId || req.query.chatId;
    const msg = req.body.msg || req.query.msg || "";
    const delay = Number(req.body.delay || req.query.delay);

    console.log("🧾 Parsed params:", {
      user,
      channelId,
      chatId,
      msg,
      delay
    });

    if (!user || !channelId || !chatId || Number.isNaN(delay)) {
      console.warn("❌ Missing params");
      return res.status(400).send("Missing parameters");
    }

    if (isPlaceholder(user) || isPlaceholder(channelId) || isPlaceholder(chatId)) {
      console.warn("❌ Nightbot placeholders unresolved");
      return res.status(400).send("Nightbot variables unresolved");
    }

    if (!isValidChatId(chatId) || !isValidChannelId(channelId)) {
      console.warn("❌ Invalid IDs");
      return res.status(400).send("Invalid IDs");
    }

    const now = new Date().toISOString();
    console.log("🕒 User timestamp:", now);

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
    console.log("✅ Clip stored in Supabase");

    const live = await getLiveStreamInfo(channelId);
    console.log("🎯 Live info resolved:", live);

    if (live.video_id && live.stream_start_time) {
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
  } catch (e) {
    console.error("💥 /api/clip fatal error", {
      error: e?.response?.data || e.message
    });
    return res.status(500).send("Internal error");
  }
});

/* ================== START ================== */

app.listen(3000, () =>
  console.log("🚀 Server running on http://localhost:3000")
);
