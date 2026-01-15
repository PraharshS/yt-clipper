import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { google } from "googleapis";

dotenv.config();
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
  const s = new Date(start);
  const u = new Date(new Date(user).getTime() - delay * 1000);
  let d = Math.max(0, Math.floor((u - s) / 1000));
  const h = Math.floor(d / 3600);
  d %= 3600;
  const m = Math.floor(d / 60);
  const sec = d % 60;
  return h
    ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
    : `${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
};

const tsToSeconds = ts => {
  const p = ts.split(":").map(Number);
  return p.length === 2 ? p[0]*60+p[1] : p[0]*3600+p[1]*60+p[2];
};

/* ================== SUPABASE ================== */

const chatIdExists = async chatId => {
  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_TABLE}?chat_id=eq.${chatId}&limit=1`,
    { headers: sbHeaders }
  );
  return r.data.length > 0;
};


const getDiscordChannelId = async channelId => {
  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_CHANNEL_TABLE}?channel_id=eq.${channelId}&select=dc_channel_id`,
    { headers: sbHeaders }
  );
  console.log(r)
  return r.data?.[0]?.dc_channel_id || null;
};

const getLiveStreamInfo = async channelId => {
  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_TABLE}?channel_id=eq.${channelId}&status=eq.live&limit=1`,
    { headers: sbHeaders }
  );

  if (!r.data.length) return {};

  const live = r.data[0];

  // ✅ If stream_start_time already exists, return as-is
  if (live.stream_start_time) {
    return live;
  }

  // 🔥 NEW: hydrate stream start time from YouTube API
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

    const details = yt.data.items?.[0]?.liveStreamingDetails;
    const startTime =
      details?.actualStartTime ||
      details?.scheduledStartTime ||
      null;

    if (startTime) {
      // Update Supabase (fire-and-forget safe update)
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/${SUPABASE_YT_TABLE}?id=eq.${live.id}`,
        { stream_start_time: startTime },
        { headers: sbHeaders }
      );

      // Return enriched object
      return {
        ...live,
        stream_start_time: startTime
      };
    }
  } catch (e) {
    console.warn(
      "[getLiveStreamInfo] Failed to hydrate stream_start_time",
      live.video_id
    );
  }

  // Fallback: return original row (still null)
  return live;
};


/* ================== DISCORD ================== */

const sendDiscord = async (dcId, videoId, title, msg, user, ts) => {
  console.log(dcId, videoId, title, msg, user, ts)
  try {
    if (!dcId || !videoId || !ts) {
      console.warn("[Discord] Missing required params", {
        dcId,
        videoId,
        ts
      });
      return;
    }

    await axios.post(
      `https://discord.com/api/v10/channels/${dcId}/messages`,
      {
        embeds: [
          {
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
          }
        ]
      },
      {
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 10_000
      }
    );

    console.log("✅ Discord clip sent successfully");

  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;

    console.error("❌ Discord send failed", {
      status,
      error: data || err.message
    });

    /**
     * Common Discord errors:
     * 401 → Invalid bot token
     * 403 → Missing permissions
     * 404 → Channel not found / bot not in server
     * 429 → Rate limited
     */
  }
};


/* ================== YOUTUBE PROCESSOR ================== */

let ytQueue = [];
let ytRunning = false;

const processYT = async (chatId, channelId) => {
  const blacklist = await axios.get(
    `${SUPABASE_URL}/rest/v1/${blacklist_yt_channel}?channel_id=eq.${channelId}&limit=1`,
    { headers: sbHeaders }
  );
  if (blacklist.data.length) return;

  const search = await axios.get("https://www.googleapis.com/youtube/v3/search", {
    params: {
      part: "snippet",
      channelId,
      type: "video",
      eventType: "live",
      key: YT_DATA_API_V3
    }
  });

  for (const v of search.data.items || []) {
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

// setInterval(async () => {
//   if (ytRunning || !ytQueue.length) return;
//   ytRunning = true;
//   const { chatId, channelId } = ytQueue.shift();
//   try { await processYT(chatId, channelId); }
//   catch {}
//   ytRunning = false;
// }, 1000);

/* ================== YOUTUBE COMMENT POST ================== */

const ytAuth = new google.auth.OAuth2(
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET
);
ytAuth.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
const yt = google.youtube({ version: "v3", auth: ytAuth });

const insertClip = clip => {
  try {
    axios.post(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, clip, {
    headers: sbHeaders
    });
  } catch (error) {
    console.log("insertClipError");
  }
}
const fetchStreamStartTime = async videoId => {
  try {
    const r = await axios.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "liveStreamingDetails",
          id: videoId,
          key: YT_DATA_API_V3
        }
      }
    );

    const details = r.data.items?.[0]?.liveStreamingDetails;
    return (
      details?.actualStartTime ||
      details?.scheduledStartTime ||
      null
    );
  } catch (e) {
    console.warn("Failed to fetch stream start time", videoId);
    return null;
  }
};

/* ================== ROUTES ================== */

app.all("/api/clip", async (req, res) => {
  const user = req.body.user || req.query.user;
  const channelId = req.body.channelid || req.query.channelid;
  const chatId = req.body.chatId || req.query.chatId;
  const msg = req.body.msg || req.query.msg || "";
  const delay = Number(req.body.delay || req.query.delay);

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

  await insertClip({
    channel_id: channelId,
    chat_id: chatId,
    delay,
    message: msg,
    user_name: user,
    user_timestamp: now
  });

  if (!(await chatIdExists(chatId)))
    ytQueue.push({ chatId, channelId });

  const dcId = DISCORD_CHANNEL_ID;
  const live = await getLiveStreamInfo(channelId);
  console.log(dcId, live.video_id, live.stream_start_time, live.created_at);
  
  if (dcId && live.video_id && live.stream_start_time) {
    const ts = formatTimestamp(live.stream_start_time, now, delay);
    await sendDiscord(dcId, live.video_id, live.title, msg, user.replace("@",""), ts);
  }

  return res.send(
    `Timestamped (with -${delay}s delay) by ${user}. Tool used: ${TOOL_USED}`
  );
});

/* ================== CRON ================== */

app.all("/api/monitor-streams", async (req, res) => {
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (secret !== CRON_SECRET) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ ok: true });
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
  console.log("🚀 Single-file server running on port 3000")
);
