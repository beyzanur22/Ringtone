require("dotenv").config();

const axios = require("axios");
const http = require("http");
const https = require("https");
const express = require("express");
const ytdlp = require("yt-dlp-exec");
const cors = require("cors");
const fs = require("fs");
const rateLimit = require("express-rate-limit"); //botu azaltır. CPU korunur . 

const PQueue = require("p-queue").default;
const proxies = [
  "http://jtsuuwtv:rk9mmw64wz5r@45.39.73.169:5584",
  "http://jtsuuwtv:rk9mmw64wz5r@82.26.238.125:6432",
  "http://jtsuuwtv:rk9mmw64wz5r@82.22.223.45:6396",
  "http://jtsuuwtv:rk9mmw64wz5r@82.24.224.6:5362",
  "http://jtsuuwtv:rk9mmw64wz5r@92.112.82.222:5457"
];
const { HttpsProxyAgent } = require("https-proxy-agent");
function getProxy() {
  return proxies[Math.floor(Math.random() * proxies.length)];
}
const queue = new PQueue({
  concurrency: 1,      // aynı anda max 2 işlem
  interval: 1000,      // 1 saniyede
  intervalCap: 1       // max 3 request
});
const axiosClient = axios.create({
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true })
});

const app = express();
app.set("trust proxy", 1); 

app.use(cors());
app.use(express.json());

/* =========================
   AUTH MIDDLEWARE
========================= */
app.use((req, res, next) => {
    const appKey = req.headers['x-app-key'];
    // Health ve Config açık kalabilir, diğerleri korumalı
   if (
req.path === "/health" ||
req.path === "/config" ||
req.path.startsWith("/stream") ||
req.path.startsWith("/download")
) return next();

    if (appKey === "RINGTONE_MASTER_V2_SECRET_2026") {
        next();
    } else {
        console.warn(`Yetkisiz erişim denemesi: ${req.ip}`);
        res.status(403).json({ error: "Unauthorized access" });
    }
});

/* =========================
   FILES & CONFIG
========================= */
const CONFIG_FILE = "config.json";
const DATA_FILE = "blockedChannels.json";

if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        global: { enabled: true, mode: "youtube" },
        countries: {}
    }, null, 2));
}

if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([]));
}

/* =========================
   RATE LIMITS
========================= */
app.use(rateLimit({
    windowMs: 60 * 1000, //bot saldırı azaltma
    max: 20
}));

const searchLimiter = rateLimit({ //spam search engellemek için.
    windowMs: 60 * 1000,
    max: 20
});

/* =========================
   YOUTUBE API SETUP
========================= */
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
let top50Cache = null;
let top50CacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000;
/* =========================
   STREAM CACHE
========================= */
const streamCache = new Map();
const STREAM_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 saat

/* =========================
   ENDPOINTS
========================= */

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/config", (req, res) => {
    const data = fs.readFileSync(CONFIG_FILE);
    res.json(JSON.parse(data));
});

app.post("/config", (req, res) => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(req.body, null, 2));
    res.json({ message: "Config updated successfully" });
});

// TOP 50

app.get("/top50", async (req, res) => {
    const now = Date.now();
    try {
        if (top50Cache && (now - top50CacheTime < CACHE_DURATION)) {
            return res.json({ source: "cache", data: top50Cache });
        }
        const response = await axiosClient.get("https://www.googleapis.com/youtube/v3/videos", {
            params: {
                part: "snippet,contentDetails,statistics",
                chart: "mostPopular",
                regionCode: "US",
                maxResults: 50,
                videoCategoryId: 10,
                key: YOUTUBE_API_KEY
            }
        });
        top50Cache = response.data.items;
        top50CacheTime = now;
        res.json({ source: "youtube", data: top50Cache });
    } catch (error) {
        res.status(500).json({ error: "YouTube API error" });
    }
});

// SEARCH
let searchCache = new Map();
app.get("/search", searchLimiter, async (req, res) => {
    try {
        const query = req.query.q?.toLowerCase().trim();
        if (!query) return res.status(400).json({ error: "Query required" });

        const pageToken = req.query.pageToken || "";
        const cacheKey = query + "_" + pageToken;
        
        if (searchCache.has(cacheKey)) {
            const cached = searchCache.get(cacheKey);
            if (Date.now() - cached.time < (60 * 60 * 1000)) return res.json(cached.data);
        }

        const response = await axiosClient.get("https://www.googleapis.com/youtube/v3/search", {
            params: {
                part: "snippet",
                q: query,
                type: "video",
                maxResults: 20,
                pageToken: pageToken,
                key: YOUTUBE_API_KEY
            }
        });

        const result = { nextPageToken: response.data.nextPageToken, data: response.data.items };
        searchCache.set(cacheKey, { data: result, time: Date.now() });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: "Search failed" });
    }
});

// STREAM (Direct Pipe)
// STREAM 
app.get("/stream", async (req, res) => {
  try {

   const proxy = getProxy();
    
    const { videoId } = req.query;

    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    let streamUrl;

    // CACHE VAR MI
    if (streamCache.has(videoId)) {

      const cached = streamCache.get(videoId);

      if (Date.now() < cached.expire) {

        streamUrl = cached.url;

        console.log("STREAM CACHE HIT:", videoId);

      } else {

        streamCache.delete(videoId);

      }

    }

    // CACHE YOKSA YT-DLP ÇALIŞTIR
    if (!streamUrl) {

     try {

streamUrl = await ytdlp(
  `https://www.youtube.com/watch?v=${videoId}`,
  {
    format: "bestaudio[ext=m4a]/bestaudio",
    getUrl: true,
    socketTimeout: 15000,

    proxy: proxy, // 🔥 EKLE

    extractorArgs: "youtube:player_client=web",

    addHeader: [
      "referer:https://www.youtube.com/",
      "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    ]
  }
);

  streamUrl = streamUrl.toString().trim();

} catch (e) {

  console.log("YT-DLP BLOCKED:", videoId);

  return res.status(500).json({
    error: "YTDLP_BLOCKED"
  });

}
// CACHE ŞİŞMESİN
if (streamCache.size > 5000) {
  streamCache.clear();
  console.log("CACHE RESET");
}
       
      // CACHE'E KOY
      streamCache.set(videoId, {
        url: streamUrl,
        expire: Date.now() + STREAM_CACHE_DURATION
      });

      console.log("STREAM CACHE SAVE:", videoId);

    }

const agent = new HttpsProxyAgent(proxy);

const response = await axios({
  method: "GET",
  url: streamUrl,
  responseType: "stream",
  httpAgent: agent,
  httpsAgent: agent,
  headers: {
    "User-Agent": "Mozilla/5.0",
    "referer": "https://www.youtube.com/"
  }
});
console.log("PROXY:", proxy);
    res.setHeader("Content-Type", response.headers["content-type"]);

    response.data.pipe(res);

  } catch (err) {

    console.error("STREAM ERROR:", err);

    res.status(500).json({
      error: "Streaming failed",
      message: err.message
    });

  }
});

// VIDEO STREAM (MP4)
app.get("/stream/video", async (req, res) => {

  try {
const proxy = getProxy();

    const { videoId } = req.query;

    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const cacheKey = "video_" + videoId;

    let streamUrl;

    // CACHE VAR MI
    if (streamCache.has(cacheKey)) {

      const cached = streamCache.get(cacheKey);

      if (Date.now() < cached.expire) {

        streamUrl = cached.url;

        console.log("VIDEO CACHE HIT:", videoId);

      } else {

        streamCache.delete(cacheKey);

      }

    }

    // CACHE YOKSA YT-DLP ÇALIŞTIR
    if (!streamUrl) {

streamUrl = await ytdlp(
  `https://www.youtube.com/watch?v=${videoId}`,
  {
    format: "best[ext=mp4]/best",
    getUrl: true,
    socketTimeout: 15000,

    proxy: proxy, // 🔥 EKLE

    extractorArgs: "youtube:player_client=web",

    addHeader: [
      "referer:https://www.youtube.com/",
      "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    ]
  }
);

      streamUrl = streamUrl.toString().trim();

      if (streamCache.size > 5000) {
      streamCache.clear();
      console.log("CACHE RESET");
    }
      streamCache.set(cacheKey, {
        url: streamUrl,
        expire: Date.now() + STREAM_CACHE_DURATION
      });

      console.log("VIDEO CACHE SAVE:", videoId);

    }

const agent = new HttpsProxyAgent(proxy);

const response = await axios({
  method: "GET",
  url: streamUrl,
  responseType: "stream",
  httpAgent: agent,
  httpsAgent: agent,
  headers: {
    "User-Agent": "Mozilla/5.0",
    "referer": "https://www.youtube.com/"
  }
});
console.log("VIDEO PROXY:", proxy);

    res.setHeader("Content-Type", response.headers["content-type"]);

    response.data.pipe(res);

  } catch (err) {

    console.error("VIDEO STREAM ERROR:", err);

    res.status(500).json({
      error: "Video streaming failed"
    });

  }

});

/* =========================
   WARMUP & START
========================= */

async function warmTop50() {
    try {
        const response = await axiosClient.get("https://www.googleapis.com/youtube/v3/videos", {
            params: {
                part: "snippet,contentDetails,statistics",
                chart: "mostPopular",
                regionCode: "US",
                maxResults: 50,
                videoCategoryId: 10,
                key: YOUTUBE_API_KEY
            }
        });
        top50Cache = response.data.items;
        top50CacheTime = Date.now();
        console.log("Top50 cache hazır");
    } catch (e) { console.log("Warmup başarısız"); }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Backend running on port ${PORT}`);
    await warmTop50();
});

//mp3 
app.get("/download/mp3", async (req, res) => {
  try {
    const { videoId } = req.query;
    const proxy = getProxy();

    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=audio.m4a");

  const streamUrl = await queue.add(() => {
  console.log("MP3 YTDLP PROXY:", proxy);

  return ytdlp(url, {
    format: "bestaudio[ext=m4a]/bestaudio",
    getUrl: true,

    proxy: proxy, // 🔥 EKLE

    extractorArgs: "youtube:player_client=web",
    addHeader: [
      "referer:https://www.youtube.com/",
      "user-agent:Mozilla/5.0"
    ]
  });
});

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }
const agent = new HttpsProxyAgent(proxy);
const response = await axios({
  method: "GET",
  url: streamUrl.toString().trim(),
  responseType: "stream",
  timeout: 20000,
  httpAgent: agent,
  httpsAgent: agent,
  headers: {
    "User-Agent": "Mozilla/5.0",
    "referer": "https://www.youtube.com/"
  }
});
console.log("MP3 PROXY:", proxy);
    response.data.pipe(res);

  } catch (err) {
    console.error("MP3 ERROR:", err.message);
    res.status(500).json({ error: "Audio download failed" });
  }
});
 
//mp4 
app.get("/download/mp4", async (req, res) => {
  try {
    const { videoId } = req.query;
    const proxy = getProxy();

    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=video.mp4");

const streamUrl = await queue.add(() => {
  console.log("MP4 YTDLP PROXY:", proxy);

  return ytdlp(url, {
    format: "best[ext=mp4]/best",
    getUrl: true,

    proxy: proxy, // 🔥 EKLE

    extractorArgs: "youtube:player_client=web",
    addHeader: [
      "referer:https://www.youtube.com/",
      "user-agent:Mozilla/5.0"
    ]
  });
});

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }
const agent = new HttpsProxyAgent(proxy);
 const response = await axios({
  method: "GET",
  url: streamUrl.toString().trim(),
  responseType: "stream",
  timeout: 20000,
  httpAgent: agent,
  httpsAgent: agent,
  headers: {
    "User-Agent": "Mozilla/5.0",
    "referer": "https://www.youtube.com/"
  }
});
console.log("MP4 PROXY:", proxy);
    response.data.pipe(res);

  } catch (err) {
    console.error("MP4 ERROR:", err.message);
    res.status(500).json({ error: "MP4 download failed" });
  }
});