require("dotenv").config();

const axios = require("axios");
const http = require("http");
const https = require("https");
const express = require("express");
const ytdlp = require("yt-dlp-exec");
const cors = require("cors");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const Redis = require("ioredis");

const PQueue = require("p-queue").default;

const queue = new PQueue({
  concurrency: 2,      // aynı anda max 2 işlem
  interval: 1000,      // 1 saniyede
  intervalCap: 3       // max 3 request
});

/* =========================
   ERROR LOGGING & CIRCUIT BREAKER
========================= */
const path = require("path");

function logError(type, videoId, errorMessage) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] - [${type}] - VideoID: ${videoId || "N/A"} - Error: ${errorMessage}\n`;
    console.error(logLine.trim());
    try {
        fs.appendFileSync(path.join(__dirname, "error.log"), logLine);
    } catch(e) { /* ignore */ }
}

let ytDlpFailCount = 0;
let ytDlpCircuitBreakerUntil = 0;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_TIMEOUT = 5 * 60 * 1000; // 5 mins
let youtubeApiStatus = "ok";

/* =========================
   REDIS CACHE (fallback: in-memory)
========================= */
let redis = null;
const memoryCache = new Map(); // Redis yoksa fallback

try {
  redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => {
      if (times > 2) {
        return null; // retry durduruluyor
      }
      return Math.min(times * 500, 2000);
    },
    lazyConnect: true,
    enableOfflineQueue: false
  });

  // Unhandled error event'leri yakala
  redis.on("error", (err) => {
    if (redis) {
      console.warn("[Redis] Bağlantı hatası, in-memory cache'e geçiliyor");
      redis.disconnect();
      redis = null;
    }
  });

  redis.connect().then(() => {
    console.log("[Redis] Bağlantı başarılı");
  }).catch(() => {
    console.warn("[Redis] Bağlantı başarısız, in-memory cache aktif");
    redis.disconnect();
    redis = null;
  });
} catch (e) {
  console.warn("[Redis] Init hatası, in-memory cache aktif");
  redis = null;
}

// Cache helper fonksiyonları
async function cacheGet(key) {
  try {
    if (redis) {
      const val = await redis.get(key);
      return val ? JSON.parse(val) : null;
    }
  } catch (e) { /* Redis hata, fallback */ }
  // In-memory fallback
  const cached = memoryCache.get(key);
  if (cached && Date.now() < cached.expire) return cached.data;
  if (cached) memoryCache.delete(key);
  return null;
}

async function cacheSet(key, data, ttlSeconds) {
  try {
    if (redis) {
      await redis.set(key, JSON.stringify(data), "EX", ttlSeconds);
      return;
    }
  } catch (e) { /* Redis hata, fallback */ }
  // In-memory fallback
  memoryCache.set(key, { data, expire: Date.now() + (ttlSeconds * 1000) });
}

// Bots & Jitter
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0"
];
function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
const randomJitter = async () => {
    // 500ms ile 1500ms arası rastgele gecikme ekler
    const ms = Math.floor(Math.random() * 1000) + 500;
    await new Promise(resolve => setTimeout(resolve, ms));
};

// Fallback player client stratejisi: web → ios → default
const PLAYER_CLIENTS = ["web", "ios", "default"];

async function resolveStreamUrl(videoUrl, format, ua, countryClient = null) {
  if (Date.now() < ytDlpCircuitBreakerUntil) {
    throw new Error("yt-dlp has been temporarily disabled due to consecutive failures. Try again later.");
  }

  let lastError = null;

  let clientsToTry = PLAYER_CLIENTS;
  if (countryClient && countryClient !== "default") {
    clientsToTry = [countryClient, ...PLAYER_CLIENTS.filter(c => c !== countryClient)];
  }

  for (const client of clientsToTry) {
    try {
      const opts = {
        format: format,
        getUrl: true,
        addHeader: [
          "referer:youtube.com",
          `user-agent:${ua}`
        ]
      };

      // cookies.txt varsa ve USE_COOKIES=false değilse ekle
      const useCookies = process.env.USE_COOKIES !== "false";
      if (useCookies && fs.existsSync("cookies.txt")) {
        opts.cookies = "cookies.txt";
      }

      // "default" = yt-dlp kendi seçsin
      if (client !== "default") {
        opts.extractorArgs = `youtube:player_client=${client}`;
      }

      console.log(`[yt-dlp] Deneniyor: client=${client}, format=${format}`);
      const result = await ytdlp(videoUrl, opts);
      const url = result.toString().trim();

      if (url && url.startsWith("http")) {
        console.log(`[yt-dlp] Başarılı: client=${client}`);
        ytDlpFailCount = 0; // reset on success
        return url;
      }
    } catch (err) {
      console.warn(`[yt-dlp] client=${client} başarısız:`, err.stderr || err.message);
      lastError = err;
    }
  }

  ytDlpFailCount++;
  if (ytDlpFailCount >= CIRCUIT_BREAKER_THRESHOLD) {
    const videoIdMatch = videoUrl.match(/v=([^&]+)/);
    const vId = videoIdMatch ? videoIdMatch[1] : videoUrl;
    logError("CIRCUIT_BREAKER", vId, `yt-dlp failed ${ytDlpFailCount} times. Circuit open for 5 mins.`);
    ytDlpCircuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_TIMEOUT;
  }

  throw lastError || new Error("Tüm player client'lar başarısız oldu");
}
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

    const expectedKey = process.env.APP_KEY || "RINGTONE_MASTER_V2_SECRET_2026";
    if (appKey === expectedKey) {
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
const CACHE_DURATION = 60 * 60; // 1 saat (saniye cinsinden)
const STREAM_CACHE_DURATION = 6 * 60 * 60; // 6 saat (saniye cinsinden)
const SEARCH_CACHE_DURATION = parseInt(process.env.SEARCH_CACHE_TTL || "3600"); // config'den yönetilebilir

/* =========================
   BLOCKED CHANNELS
========================= */
function getBlockedChannels() {
  try {
    const data = fs.readFileSync(DATA_FILE, "utf-8");
    return JSON.parse(data);
  } catch (e) { return []; }
}

function filterBlockedChannels(items) {
  const blocked = getBlockedChannels();
  if (!blocked.length) return items;
  return items.filter(item => {
    const channelId = item.snippet?.channelId;
    const channelTitle = item.snippet?.channelTitle?.toLowerCase();
    return !blocked.some(b =>
      b.id === channelId ||
      (b.name && channelTitle && channelTitle.includes(b.name.toLowerCase()))
    );
  });
}

function getPlayerClientForCountry(countryCode) {
    try {
        const data = fs.readFileSync(CONFIG_FILE, "utf-8");
        const configData = JSON.parse(data);
        if (configData.countries && configData.countries[countryCode]) {
            return configData.countries[countryCode];
        }
    } catch (e) { /* ignore */ }
    return "default";
}

/* =========================
   ENDPOINTS
========================= */

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        redis: redis ? "connected" : "disconnected",
        ytDlp: Date.now() < ytDlpCircuitBreakerUntil ? "circuit_breaker_open" : "ok",
        youtubeApi: youtubeApiStatus
    });
});

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
    try {
        // Redis cache kontrol
        const cached = await cacheGet("top50");
        if (cached) {
            return res.json({ source: "cache", data: cached });
        }

        let items;
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
            items = filterBlockedChannels(response.data.items);
            youtubeApiStatus = "ok";
        } catch (apiError) {
            if (apiError.response && (apiError.response.status === 403 || apiError.response.status === 429)) {
                logError("API_FALLBACK", null, "YouTube API Quota exceeded or forbidden. Using Piped API fallback config for top50.");
                youtubeApiStatus = "quota_exceeded";
                const pipedRes = await axiosClient.get("https://pipedapi.kavin.rocks/trending?region=US");
                const pipedItems = pipedRes.data.map(item => ({
                    id: (item.url || "").split("?v=")[1],
                    snippet: {
                        title: item.title,
                        channelTitle: item.uploaderName,
                        channelId: (item.uploaderUrl || "").split("/channel/")[1] || ""
                    }
                }));
                items = filterBlockedChannels(pipedItems);
            } else {
                throw apiError;
            }
        }

        await cacheSet("top50", items, CACHE_DURATION);
        res.setHeader("Cache-Control", `public, max-age=${CACHE_DURATION}`);
        res.json({ source: "youtube", data: items });
    } catch (error) {
        logError("TOP50", null, error.message);
        console.error("TOP50 ERROR:", error.message);
        res.status(500).json({ error: "API error" });
    }
});

// SEARCH
app.get("/search", searchLimiter, async (req, res) => {
    try {
        const query = req.query.q?.toLowerCase().trim();
        if (!query) return res.status(400).json({ error: "Query required" });

        const pageToken = req.query.pageToken || "";
        const cacheKey = `search:${query}_${pageToken}`;

        // Redis cache kontrol
        const cached = await cacheGet(cacheKey);
        if (cached) return res.json(cached);

        let resultData, nextToken = "";
        try {
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
            resultData = filterBlockedChannels(response.data.items);
            nextToken = response.data.nextPageToken;
            youtubeApiStatus = "ok";
        } catch (apiError) {
            if (apiError.response && (apiError.response.status === 403 || apiError.response.status === 429)) {
                logError("API_FALLBACK", null, `YouTube API Quota exceeded or forbidden. Using Piped API fallback config for search: ${query}`);
                youtubeApiStatus = "quota_exceeded";
                const pipedRes = await axiosClient.get(`https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(query)}&filter=videos`);
                const pipedItems = pipedRes.data.map(item => ({
                    id: { videoId: (item.url || "").split("?v=")[1] },
                    snippet: {
                        title: item.title,
                        channelTitle: item.uploaderName,
                        channelId: (item.uploaderUrl || "").split("/channel/")[1] || ""
                    }
                }));
                resultData = filterBlockedChannels(pipedItems);
                nextToken = ""; // Piped basic API may not always have next page cursor matching easily
            } else {
                throw apiError;
            }
        }

        const result = { nextPageToken: nextToken, data: resultData };
        await cacheSet(cacheKey, result, SEARCH_CACHE_DURATION);
        res.setHeader("Cache-Control", `public, max-age=${SEARCH_CACHE_DURATION}`);
        res.json(result);
    } catch (error) {
        logError("SEARCH", null, error.message);
        console.error("SEARCH ERROR:", error.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// STREAM (Direct Pipe)
// STREAM 

app.get("/stream", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    const cacheKey = `stream:audio:${videoId}`;
    let streamUrl = await cacheGet(cacheKey);
    const ua = getRandomUA();

    if (streamUrl) {
      console.log("AUDIO CACHE HIT:", videoId);
    } else {
      // Queue ile sıralı çalıştır
      streamUrl = await queue.add(async () => {
        await randomJitter();
        return resolveStreamUrl(
          `https://www.youtube.com/watch?v=${videoId}`,
          "bestaudio",
          ua,
          countryClient
        );
      });
      await cacheSet(cacheKey, streamUrl, STREAM_CACHE_DURATION);
      console.log("AUDIO CACHE SAVE:", videoId);
    }

    const response = await axiosClient({
      method: "GET",
      url: streamUrl,
      responseType: "stream",
      headers: { "User-Agent": ua }
    });
    res.setHeader("Content-Type", response.headers["content-type"]);
    response.data.pipe(res);
  } catch (err) {
    logError("STREAM", req.query.videoId, err.message);
    console.error("STREAM ERROR:", err.message);
    res.status(500).json({
      error: "Streaming failed",
      message: err.message
    });
  }
});


// VIDEO STREAM (MP4)
app.get("/stream/video", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    const cacheKey = `stream:video:${videoId}`;
    let streamUrl = await cacheGet(cacheKey);
    const ua = getRandomUA();

    if (streamUrl) {
      console.log("VIDEO CACHE HIT:", videoId);
    } else {
      // Queue ile sıralı çalıştır
      streamUrl = await queue.add(async () => {
        await randomJitter();
        return resolveStreamUrl(
          `https://www.youtube.com/watch?v=${videoId}`,
          "best[ext=mp4]/best",
          ua,
          countryClient
        );
      });
      await cacheSet(cacheKey, streamUrl, STREAM_CACHE_DURATION);
      console.log("VIDEO CACHE SAVE:", videoId);
    }

    const response = await axiosClient({
      method: "GET",
      url: streamUrl,
      responseType: "stream",
      headers: { "User-Agent": ua }
    });
    res.setHeader("Content-Type", response.headers["content-type"]);
    response.data.pipe(res);
  } catch (err) {
    logError("STREAM_VIDEO", req.query.videoId, err.message);
    console.error("VIDEO STREAM ERROR:", err.message);
    res.status(500).json({ error: "Video streaming failed" });
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
        const items = filterBlockedChannels(response.data.items);
        await cacheSet("top50", items, CACHE_DURATION);
        console.log("Top50 cache hazır (Redis)");
    } catch (e) { console.log("Warmup başarısız:", e.message); }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Backend running on port ${PORT}`);
    console.log(`Redis: ${redis ? "bağlı" : "in-memory fallback"}`);
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

    const ua = getRandomUA();
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    await randomJitter();
    const streamUrl = await queue.add(() =>
      resolveStreamUrl(url, "bestaudio", ua, countryClient)
    );

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }

    const response = await axios({
      method: "GET",
      url: streamUrl.toString().trim(),
      responseType: "stream",
      timeout: 20000,
      headers: { "User-Agent": ua }
    });

    response.data.pipe(res);

  } catch (err) {
    logError("DOWNLOAD_MP3", req.query.videoId, err.message);
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

    const ua = getRandomUA();
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    await randomJitter();
    const streamUrl = await queue.add(() =>
      resolveStreamUrl(url, "best[ext=mp4]/best", ua, countryClient)
    );

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }

    const response = await axios({
      method: "GET",
      url: streamUrl.toString().trim(),
      responseType: "stream",
      timeout: 20000,
      headers: { "User-Agent": ua }
    });

    response.data.pipe(res);

  } catch (err) {
    logError("DOWNLOAD_MP4", req.query.videoId, err.message);
    console.error("MP4 ERROR:", err.message);
    res.status(500).json({ error: "MP4 download failed" });
  }
});
