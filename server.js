import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

/* ================== BOOT ================== */

console.log("🟢 Server booting…");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================== ENV ================== */

const {
  SUPABASE_URL,
  SUPABASE_API_KEY,
  SUPABASE_TABLE,
  YT_DATA_API_V3,
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  TOOL_USED,
  CRON_SECRET,
  CRON_SECRET_DC_KEEP_ALIVE
} = process.env;

console.log("🧩 ENV loaded:", {
  SUPABASE_URL: !!SUPABASE_URL,
  SUPABASE_KEY: !!SUPABASE_API_KEY,
  YT_API: !!YT_DATA_API_V3,
  DISCORD: !!DISCORD_BOT_TOKEN
});

/* ================== HELPERS ================== */

const sbHeaders = {
  apikey: SUPABASE_API_KEY,
  Authorization: `Bearer ${SUPABASE_API_KEY}`,
  "Content-Type": "application/json"
};

const isPlaceholder = v => {
  const r = ["$(user)", "$(chatid)", "$(channelid)", "$(querystring)"].includes(String(v));
  console.log("🔍 isPlaceholder", v, r);
  return r;
};

const isValidChatId = id => {
  const r = typeof id === "string" && id.length >= 22;
  console.log("🔍 isValidChatId", id, r);
  return r;
};

const isValidChannelId = id => {
  const r = /^UC[a-zA-Z0-9_-]{22}$/.test(id);
  console.log("🔍 isValidChannelId", id, r);
  return r;
};

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

  console.log("⏱ timestamp result:", ts);
  return ts;
};

const tsToSeconds = ts => {
  const p = ts.split(":").map(Number);
  const sec = p.length === 2 ? p[0]*60+p[1] : p[0]*3600+p[1]*60+p[2];
  console.log("🔢 tsToSeconds", ts, sec);
  return sec;
};

/* ================== YOUTUBE ================== */

const getLiveStreamInfoFromYT = async channelId => {
  console.log("🎥 getLiveStreamInfoFromYT()", channelId);

  try {
    const search = await axios.get(
      "https://www.googleapis.com/youtube/v3/search",
      {
        params: {
          part: "snippet",
          channelId,
          eventType: "live",
          type: "video",
          maxResults: 1,
          key: YT_DATA_API_V3
        }
      }
    );

    const item = search.data.items?.[0];
    if (!item) {
      console.warn("⚠️ No live stream found");
      return {};
    }

    const videoId = item.id.videoId;
    const title = item.snippet.title;

    console.log("🎬 Live video found:", { videoId, title });

    const video = await axios.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "liveStreamingDetails",
          id: videoId,
          key: YT_DATA_API_V3
        }
      }
    );

    const details = video.data.items?.[0]?.liveStreamingDetails;
    const streamStartTime =
      details?.actualStartTime ||
      details?.scheduledStartTime ||
      null;

    console.log("🕒 streamStartTime:", streamStartTime);

    return {
      video_id: videoId,
      title,
      stream_start_time: streamStartTime
    };

  } catch (e) {
    console.error("❌ YouTube live fetch failed", {
      status: e?.response?.status,
      data: e?.response?.data,
      msg: e.message
    });
    return {};
  }
};

/* ================== DISCORD ================== */

const sendDiscord = async (dcId, videoId, title, msg, user, ts) => {
  console.log("📨 sendDiscord()", {
    dcId, videoId, title, msg, user, ts
  });

  if (!dcId || !videoId || !ts) {
    console.warn("⚠️ Discord skipped (missing data)");
    return;
  }

  try {
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
        }
      }
    );

    console.log("✅ Discord sent successfully");

  } catch (e) {
    console.error("❌ Discord send failed", {
      status: e?.response?.status,
      data: e?.response?.data,
      msg: e.message,
      error: e?.response?.data?.errors?.channel_id?._errors
    });
  }
};

/* ================== ROUTES ================== */

app.all("/api/clip", async (req, res) => {
  console.log("🚨 /api/clip HIT", { body: req.body, query: req.query });

  const user = req.body.user || req.query.user;
  const channelId = req.body.channelid || req.query.channelid;
  const chatId = req.body.chatId || req.query.chatId;
  const msg = req.body.msg || req.query.msg || "";
  const delay = Number(req.body.delay || req.query.delay);

  console.log("🧾 Parsed params:", {
    user, channelId, chatId, msg, delay
  });

  if (!user || !channelId || !chatId || Number.isNaN(delay))
    return res.status(400).send("Missing parameters");

  if (
    isPlaceholder(user) ||
    isPlaceholder(channelId) ||
    isPlaceholder(chatId)
  ) return res.status(400).send("Nightbot variables unresolved");

  if (!isValidChatId(chatId) || !isValidChannelId(channelId))
    return res.status(400).send("Invalid IDs");

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

  const live = await getLiveStreamInfoFromYT(channelId);
  console.log("🎯 Live info:", live);

  if (DISCORD_CHANNEL_ID && live.video_id && live.stream_start_time) {
    const ts = formatTimestamp(live.stream_start_time, now, delay);
    await sendDiscord(
      DISCORD_CHANNEL_ID,
      live.video_id,
      live.title,
      msg,
      user.replace("@",""),
      ts
    );
  } else {
    console.warn("⚠️ Discord not sent (live data missing)");
  }

  return res.send(
    `Timestamped (with -${delay}s delay) by ${user}. Tool used: ${TOOL_USED}`
  );
});

/* ================== CRON ================== */

app.all("/api/monitor-streams", (req, res) => {
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (secret !== CRON_SECRET)
    return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true });
});

app.all("/api/dc-keepalive", async (req, res) => {
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (secret !== CRON_SECRET_DC_KEEP_ALIVE)
    return res.status(401).json({ error: "Unauthorized" });

  const r = await axios.get("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  });

  res.json({ status: "ok", bot: r.data.username });
});

app.get("/health", (_, res) =>
  res.json({ status: "healthy", time: new Date().toISOString() })
);

/* ================== START ================== */

app.listen(3000, () =>
  console.log("🚀 Server running on port 3000")
);
