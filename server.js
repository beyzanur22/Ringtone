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
const { HttpsProxyAgent } = require("https-proxy-agent");

function parseProxy(proxyUrl) {
  const url = new URL(proxyUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port),
    auth: {
      username: url.username,
      password: url.password
    }
  };
}
// =========================
// PROXY SYSTEM
// =========================

const proxies = [
  "http://jtsuuwtv:rk9mmw64wz5r@45.39.20.121:5550",
  "http://jtsuuwtv:rk9mmw64wz5r@198.37.98.175:5705",
  "http://jtsuuwtv:rk9mmw64wz5r@45.95.13.69:5754",
  "http://jtsuuwtv:rk9mmw64wz5r@82.29.230.44:6885",
  "http://jtsuuwtv:rk9mmw64wz5r@89.40.222.57:6433",
  "http://jtsuuwtv:rk9mmw64wz5r@92.112.85.248:5983",
  "http://jtsuuwtv:rk9mmw64wz5r@45.39.73.169:5584",
  "http://jtsuuwtv:rk9mmw64wz5r@82.26.238.125:6432",
  "http://jtsuuwtv:rk9mmw64wz5r@82.22.223.45:6396",
  "http://jtsuuwtv:rk9mmw64wz5r@82.24.224.6:5362",
  "http://jtsuuwtv:rk9mmw64wz5r@92.112.82.222:5457",
  "http://jtsuuwtv:rk9mmw64wz5r@104.252.196.249:6157",
  "http://jtsuuwtv:rk9mmw64wz5r@2.57.31.208:6784",
  "http://jtsuuwtv:rk9mmw64wz5r@104.143.244.234:6182",
  "http://jtsuuwtv:rk9mmw64wz5r@216.173.111.28:6738",
  "http://jtsuuwtv:rk9mmw64wz5r@46.203.202.41:5987",
  "http://jtsuuwtv:rk9mmw64wz5r@172.121.139.96:5275",
  "http://jtsuuwtv:rk9mmw64wz5r@82.25.216.188:7030",
  "http://jtsuuwtv:rk9mmw64wz5r@172.120.106.81:6236",
  "http://jtsuuwtv:rk9mmw64wz5r@82.21.226.184:7497",
  "http://jtsuuwtv:rk9mmw64wz5r@172.121.235.132:8287",
  "http://jtsuuwtv:rk9mmw64wz5r@31.57.85.175:5831",
  "http://jtsuuwtv:rk9mmw64wz5r@45.43.95.84:6833",
  "http://jtsuuwtv:rk9mmw64wz5r@82.23.206.240:6046",
  "http://jtsuuwtv:rk9mmw64wz5r@80.96.70.129:6119",
  "http://jtsuuwtv:rk9mmw64wz5r@46.202.79.246:7256",
  "http://jtsuuwtv:rk9mmw64wz5r@104.232.211.243:5856",
  "http://jtsuuwtv:rk9mmw64wz5r@104.239.35.195:5877",
  "http://jtsuuwtv:rk9mmw64wz5r@184.174.56.226:5238",
  "http://jtsuuwtv:rk9mmw64wz5r@82.26.246.176:8000",
  "http://jtsuuwtv:rk9mmw64wz5r@89.45.125.92:5818",
  "http://jtsuuwtv:rk9mmw64wz5r@188.68.1.135:6004",
  "http://jtsuuwtv:rk9mmw64wz5r@64.137.49.124:6665",
  "http://jtsuuwtv:rk9mmw64wz5r@64.137.93.189:6649",
  "http://jtsuuwtv:rk9mmw64wz5r@108.165.63.87:5824",
  "http://jtsuuwtv:rk9mmw64wz5r@46.203.157.47:6990",
  "http://jtsuuwtv:rk9mmw64wz5r@92.112.175.235:6508",
  "http://jtsuuwtv:rk9mmw64wz5r@148.135.179.20:6079",
  "http://jtsuuwtv:rk9mmw64wz5r@45.249.59.148:6124",
  "http://jtsuuwtv:rk9mmw64wz5r@82.27.216.6:5337",
  "http://jtsuuwtv:rk9mmw64wz5r@174.140.200.13:6293",
  "http://jtsuuwtv:rk9mmw64wz5r@31.58.16.226:6193",
  "http://jtsuuwtv:rk9mmw64wz5r@107.174.136.172:6114",
  "http://jtsuuwtv:rk9mmw64wz5r@166.88.58.108:5833",
  "http://jtsuuwtv:rk9mmw64wz5r@84.33.236.111:6754",
  "http://jtsuuwtv:rk9mmw64wz5r@104.253.81.150:5578",
  "http://jtsuuwtv:rk9mmw64wz5r@45.131.92.44:6655",
  "http://jtsuuwtv:rk9mmw64wz5r@152.232.15.69:8237",
  "http://jtsuuwtv:rk9mmw64wz5r@154.30.1.225:5541",
  "http://jtsuuwtv:rk9mmw64wz5r@195.40.186.218:5900",
  "http://jtsuuwtv:rk9mmw64wz5r@45.61.97.41:6567",
  "http://jtsuuwtv:rk9mmw64wz5r@31.59.13.21:6291",
  "http://jtsuuwtv:rk9mmw64wz5r@82.25.215.66:5417",
  "http://jtsuuwtv:rk9mmw64wz5r@172.102.223.65:5576",
  "http://jtsuuwtv:rk9mmw64wz5r@107.173.36.110:5565",
  "http://jtsuuwtv:rk9mmw64wz5r@191.96.104.48:5785",
  "http://jtsuuwtv:rk9mmw64wz5r@45.41.176.207:6505",
  "http://jtsuuwtv:rk9mmw64wz5r@166.88.58.170:5895",
  "http://jtsuuwtv:rk9mmw64wz5r@67.227.14.112:6704",
  "http://jtsuuwtv:rk9mmw64wz5r@216.173.120.36:6328",
  "http://jtsuuwtv:rk9mmw64wz5r@45.150.176.35:5908",
  "http://jtsuuwtv:rk9mmw64wz5r@104.239.39.241:6170",
  "http://jtsuuwtv:rk9mmw64wz5r@194.38.18.199:7261",
  "http://jtsuuwtv:rk9mmw64wz5r@31.59.13.165:6435",
  "http://jtsuuwtv:rk9mmw64wz5r@82.23.215.49:7376",
  "http://jtsuuwtv:rk9mmw64wz5r@104.168.118.146:6102",
  "http://jtsuuwtv:rk9mmw64wz5r@145.223.59.26:6060",
  "http://jtsuuwtv:rk9mmw64wz5r@172.121.139.177:5356",
  "http://jtsuuwtv:rk9mmw64wz5r@92.112.217.145:5917",
  "http://jtsuuwtv:rk9mmw64wz5r@45.83.57.44:6561",
  "http://jtsuuwtv:rk9mmw64wz5r@148.135.188.156:7188",
  "http://jtsuuwtv:rk9mmw64wz5r@209.127.127.254:7352",
  "http://jtsuuwtv:rk9mmw64wz5r@136.0.108.141:5817",
  "http://jtsuuwtv:rk9mmw64wz5r@103.251.223.151:6130",
  "http://jtsuuwtv:rk9mmw64wz5r@136.0.184.29:6450",
  "http://jtsuuwtv:rk9mmw64wz5r@198.144.190.84:5931",
  "http://jtsuuwtv:rk9mmw64wz5r@217.69.127.236:6857",
  "http://jtsuuwtv:rk9mmw64wz5r@45.93.45.166:6351",
  "http://jtsuuwtv:rk9mmw64wz5r@82.26.246.214:8038",
  "http://jtsuuwtv:rk9mmw64wz5r@82.21.245.18:6342",
  "http://jtsuuwtv:rk9mmw64wz5r@104.238.37.145:6702",
  "http://jtsuuwtv:rk9mmw64wz5r@104.253.81.195:5623",
  "http://jtsuuwtv:rk9mmw64wz5r@185.135.10.19:5533",
  "http://jtsuuwtv:rk9mmw64wz5r@46.202.224.146:5698",
  "http://jtsuuwtv:rk9mmw64wz5r@192.241.104.237:8331",
  "http://jtsuuwtv:rk9mmw64wz5r@104.252.109.222:7155",
  "http://jtsuuwtv:rk9mmw64wz5r@198.37.118.254:5713",
  "http://jtsuuwtv:rk9mmw64wz5r@45.39.7.140:5571",
  "http://jtsuuwtv:rk9mmw64wz5r@82.24.212.123:5429",
  "http://jtsuuwtv:rk9mmw64wz5r@155.254.34.15:5995",
  "http://jtsuuwtv:rk9mmw64wz5r@50.114.117.189:7172",
  "http://jtsuuwtv:rk9mmw64wz5r@31.59.18.45:6626",
  "http://jtsuuwtv:rk9mmw64wz5r@45.93.45.62:6247",
  "http://jtsuuwtv:rk9mmw64wz5r@104.238.37.83:6640",
  "http://jtsuuwtv:rk9mmw64wz5r@107.175.119.92:6620",
  "http://jtsuuwtv:rk9mmw64wz5r@151.245.205.10:5205",
 "http://jtsuuwtv:rk9mmw64wz5r@152.232.100.29:9123",
 "http://jtsuuwtv:rk9mmw64wz5r@154.6.121.33:6000",
 "http://jtsuuwtv:rk9mmw64wz5r@161.123.154.139:6669",
 "http://jtsuuwtv:rk9mmw64wz5r@209.127.127.193:7291"

  //  buraya 100 proxy full ekledim.
];

function getRandomProxy() {
  return proxies[Math.floor(Math.random() * proxies.length)];
}
const queue = new PQueue({
  concurrency: 2,      // aynı anda max 2 işlem
  interval: 1000,      // 1 saniyede
  intervalCap: 3       // max 3 request
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
    max: 40
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
const STREAM_CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 saat

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
    const proxy = getRandomProxy();

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
     
      streamUrl = await ytdlp(
        `https://www.youtube.com/watch?v=${videoId}`,
        {                                                                
          format: "bestaudio[ext=m4a]/bestaudio",                                                                
          getUrl: true,
          proxy: proxy                                                                 
        }
      );

      streamUrl = streamUrl.toString().trim();

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
  httpsAgent: agent,
  httpAgent: agent,
  proxy: false,
  headers: {
    "User-Agent": "Mozilla/5.0"
  }
});

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
const proxy = getRandomProxy();
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
       proxy: proxy
    }
    );

      streamUrl = streamUrl.toString().trim();

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
  httpsAgent: agent,
  httpAgent: agent,
  proxy: false,
  headers: {
    "User-Agent": "Mozilla/5.0"
  }
});

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

    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=audio.m4a");

    const proxy = getRandomProxy();
    const streamUrl = await queue.add(() =>
      ytdlp(url, {
        format: "bestaudio[ext=m4a]/bestaudio",
        getUrl: true,
        proxy: proxy,
        extractorArgs: "youtube:player_client=android",
        addHeader: [
          "referer:youtube.com",
          "user-agent:Mozilla/5.0"
        ]
      })
    );

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }

    const agent = new HttpsProxyAgent(proxy);

const response = await axios({
  method: "GET",
  url: streamUrl.toString().trim(),
  responseType: "stream",
  timeout: 20000,
  httpsAgent: agent,
  httpAgent: agent,
  proxy: false,
  headers: { "User-Agent": "Mozilla/5.0" }
});

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

    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=video.mp4");

    const proxy = getRandomProxy();

const streamUrl = await queue.add(() =>
  ytdlp(url, {
    format: "best[ext=mp4]/best",
    getUrl: true,
    proxy: proxy,
    extractorArgs: "youtube:player_client=android",
    addHeader: [
      "referer:youtube.com",
      "user-agent:Mozilla/5.0"
    ]
  })
);

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }

const agent = new HttpsProxyAgent(proxy);

const response = await axios({
  method: "GET",
  url: streamUrl,
  responseType: "stream",
  httpsAgent: agent,
  httpAgent: agent,
  proxy: false,
  headers: {
    "User-Agent": "Mozilla/5.0"
  }
});

    response.data.pipe(res);

  } catch (err) {
    console.error("MP4 ERROR:", err.message);
    res.status(500).json({ error: "MP4 download failed" });
  }
});  

async function ytdlpWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const proxy = getRandomProxy();
      return await ytdlp(url, { ...options, proxy });
    } catch (err) {
      console.log("Proxy patladı, retry...");
    }
  }
  throw new Error("Tüm proxyler patladı");
}