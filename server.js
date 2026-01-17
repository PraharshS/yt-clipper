import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { google } from "googleapis";

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
  CRON_SECRET_YT_TIMESTAMPS,
  CRON_SECRET_DC_KEEP_ALIVE,
  CURRENT_CHANNEL_ID
} = process.env;

console.log("🧩 ENV loaded:", {
  SUPABASE_URL: !!SUPABASE_URL,
  SUPABASE_KEY: !!SUPABASE_API_KEY,
  YT_API: !!YT_DATA_API_V3,
  DISCORD: !!DISCORD_BOT_TOKEN
});

/* ================== YOUTUBE OAUTH ================== */

const {
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REFRESH_TOKEN
} = process.env;

if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
  console.error("❌ Missing YouTube OAuth env vars");
  process.exit(1);
}

const ytAuth = new google.auth.OAuth2(
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET
);

// Use refresh token (auto-refreshes access token)
ytAuth.setCredentials({
  refresh_token: YOUTUBE_REFRESH_TOKEN
});

// 🔑 THIS is what fixes `yt is not defined`
const yt = google.youtube({
  version: "v3",
  auth: ytAuth
});

console.log("✅ YouTube OAuth client initialized");

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
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;

  console.log("⏱ timestamp result:", ts);
  return ts;
};

const tsToSeconds = ts => {
  const p = ts.split(":").map(Number);
  const sec = p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
  console.log("🔢 tsToSeconds", ts, sec);
  return sec;
};

/* ================== TOP CHATTERS ================== */

const getTopChattersFromLastBroadcast = async (channelId, limit = 10) => {
  console.log("🏆 Fetching top chatters for last broadcast", channelId);

  try {
    // 1️⃣ Get last completed broadcast
    const broadcast = await getMostRecentPastBroadcastFromYT(channelId);
    if (!broadcast.video_id) {
      console.warn("⚠️ No broadcast found");
      return [];
    }

    // 2️⃣ Get liveChatId
    const videoRes = await axios.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "liveStreamingDetails",
          id: broadcast.video_id,
          key: YT_DATA_API_V3
        }
      }
    );
    console.log(videoRes.data.items , "videoRes");
    
    const liveChatId =
      videoRes.data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;

    if (!liveChatId) {
      console.warn("⚠️ No liveChatId found");
      return [];
    }

    console.log("💬 liveChatId:", liveChatId);

    // 3️⃣ Fetch ALL chat messages (pagination)
    let nextPageToken = null;
    const counts = {};

    do {
      const chatRes = await axios.get(
        "https://www.googleapis.com/youtube/v3/liveChatMessages",
        {
          params: {
            part: "snippet,authorDetails",
            liveChatId,
            maxResults: 200,
            pageToken: nextPageToken,
            key: YT_DATA_API_V3
          }
        }
      );

      for (const item of chatRes.data.items || []) {
        const name = item.authorDetails?.displayName;
        if (!name) continue;

        counts[name] = (counts[name] || 0) + 1;
      }

      nextPageToken = chatRes.data.nextPageToken;
    } while (nextPageToken);

    // 4️⃣ Sort & return top N
    const leaderboard = Object.entries(counts)
      .map(([user, messages]) => ({ user, messages }))
      .sort((a, b) => b.messages - a.messages)
      .slice(0, limit);

    console.log("🏆 Top chatters:", leaderboard);

    return leaderboard;

  } catch (e) {
    console.error("❌ Failed to fetch top chatters", {
      msg: e.message,
      status: e?.response?.status,
      data: e?.response?.data
    });
    return [];
  }
};


/* ================== YOUTUBE ================== */

const postStreamTimestampsToYouTube = async (channelId) => {
  console.log("⏰ [CRON] Posting stream timestamps");

  // 1️⃣ Get last live / recent stream
  const live = await getMostRecentPastBroadcastFromYT(channelId);

  if (!live.video_id || !live.stream_start_time) {
    console.warn("⚠️ No stream found, skipping cron");
    return { skipped: true };
  }

  console.log("🎬 Stream resolved:", live.video_id);

  // 2️⃣ Fetch all clips AFTER stream start
  const clipsRes = await axios.get(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`,
    {
      params: {
        channel_id: `eq.${channelId}`,
        user_timestamp: `gte.${live.stream_start_time}`,
        order: "user_timestamp.asc"
      },
      headers: sbHeaders
    }
  );

  const clips = clipsRes.data;

  if (!clips.length) {
    console.warn("⚠️ No clips found for stream");
    return { empty: true };
  }

  console.log(`📎 ${clips.length} clips found`);

  // 3️⃣ Build timestamp comment
  let comment = "🔥 Stream Highlights\n\n";

  for (const clip of clips) {
    const ts = formatTimestamp(
      live.stream_start_time,
      clip.user_timestamp,
      clip.delay
    );

    const safeMsg = (clip.message || "Clip")
      .replace(/\n/g, " ")
      .slice(0, 80);

    comment += `${ts} – ${safeMsg}\n`;
  }

  console.log("📝 Comment built");

  // 4️⃣ Post comment to YouTube
  await yt.commentThreads.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        videoId: live.video_id,
        topLevelComment: {
          snippet: {
            textOriginal: comment
          }
        }
      }
    }
  });

  console.log("✅ Timestamp comment posted");

  return { posted: true, count: clips.length };
};

app.get("/api/top-chatters", async (req, res) => {
  const { channelId, limit = 10 } = req.query;

  if (!channelId)
    return res.status(400).json({ error: "Missing channelId" });

  try {
    const data = await getTopChattersFromLastBroadcast(
      channelId,
      Number(limit)
    );
    res.json({ ok: true, topChatters: data });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch top chatters" });
  }
});


app.all("/api/cron/post-timestamps", async (req, res) => {
  const secret = req.query.secret || req.headers["x-cron-secret"];

  if (secret !== CRON_SECRET_YT_TIMESTAMPS)
    return res.status(401).json({ error: "Unauthorized" });

  // 👇 YOUR CHANNEL ID (hardcode or env)
  const CHANNEL_ID = CURRENT_CHANNEL_ID;

  if (!CHANNEL_ID)
    return res.status(400).json({ error: "Missing channelId" });

  try {
    const result = await postStreamTimestampsToYouTube(CHANNEL_ID);
    res.json({ ok: true, result });
  } catch (e) {
    console.error("❌ Cron failed", e.message);
    res.status(500).json({ error: "Cron failed" });
  }
});

const getMostRecentPastBroadcastFromYT = async (channelId) => {
  console.log("🎥 Fetching most recent past broadcast");

  try {
    // 1️⃣ Find last completed livestream
    const search = await axios.get(
      "https://www.googleapis.com/youtube/v3/search",
      {
        params: {
          part: "snippet",
          channelId,
          eventType: "completed", // 🔑 KEY CHANGE
          type: "video",
          order: "date",
          maxResults: 1,
          key: YT_DATA_API_V3
        }
      }
    );

    const item = search.data.items?.[0];
    if (!item) {
      console.warn("⚠️ No past livestream found");
      return {};
    }

    const videoId = item.id.videoId;
    const title = item.snippet.title;

    console.log("🎬 Past broadcast found:", { videoId, title });

    // 2️⃣ Fetch start & end time
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

    const streamStartTime = details?.actualStartTime || null;
    const streamEndTime = details?.actualEndTime || null;

    if (!streamStartTime || !streamEndTime) {
      console.warn("⚠️ Broadcast missing start/end time");
      return {};
    }

    console.log("🕒 Stream window:", {
      start: streamStartTime,
      end: streamEndTime
    });

    return {
      video_id: videoId,
      title,
      stream_start_time: streamStartTime,
      stream_end_time: streamEndTime
    };

  } catch (e) {
    console.error("❌ Failed to fetch past broadcast", {
      status: e?.response?.status,
      data: e?.response?.data,
      msg: e.message
    });
    return {};
  }
};


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
      user.replace("@", ""),
      ts
    );
  } else {
    console.warn("⚠️ Discord not sent (live data missing)");
  }
  /* ================== CHAT RESPONSE LOGIC ================== */

  const lowerMsg = msg.toLowerCase();

  const aceResponses = [
    `🔥 ACE CONFIRMED! ${user} just witnessed greatness.`,
    `🎯 Clean ACE clipped by ${user}. This one deserved a clip.`,
    `💀 ACE moment secured by ${user}. Unreal.`,
    `🚨 ACE ALERT 🚨 ${user} said “clip that”.`
  ];

  const whiffResponses = [
    `😬 WHIFF DETECTED. ${user} had to clip this.`,
    `🎯❌ That aim… ${user} clipped the pain.`,
    `😂 Even pros miss sometimes. Thanks ${user}.`,
    `💀 Whiff so bad ${user} clipped it instantly.`
  ];

  const gyanResponses = [
    `🤓 Educational content by ${user}. Take notes, chat.`,
    `📚 GYAN MODE ON. ${user} clipped some knowledge.`,
    `🧠 Big brain moment detected. Thanks ${user}.`,
    `📖 Game ka Gyan 101 — clipped by ${user}.`
  ];
  const funnyResponses = [
    `😂 Comedy gold detected. Thanks for the clip ${user}.`,
    `🤣 This moment had NO BUSINESS being this funny. Clipped by ${user}`,
    `🎭 Absolute cinema. ${user} clipped the chaos.`,
    `💀 Chat, we’re never letting this go. Clipped by ${user}`,
    `🤣 Certified funny moment — archived by ${user}.`
  ];


  const defaultResponses = [
    `🎬 Clip secured by ${user} — Zittu Ka Bot did the rest 😎`,
    `🚨 CLIP ALERT 🚨 ${user} just exposed this moment.`,
    `📎 ${user} clipped it. Discord has been notified.`,
    `😈 No escape now. ${user} clipped this.`,
    `🔥 Legendary moment locked in by ${user}.`
  ];

  let responsePool = defaultResponses;

  if (lowerMsg.includes("ace")) {
    responsePool = aceResponses;
  } else if (lowerMsg.includes("whiff")) {
    responsePool = whiffResponses;
  } else if (lowerMsg.includes("gyan")) {
    responsePool = gyanResponses;
  } else if (lowerMsg.includes("funny")) {
    responsePool = funnyResponses;
  }

  const randomMessage =
    responsePool[Math.floor(Math.random() * responsePool.length)];

  return res.send(randomMessage);

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
