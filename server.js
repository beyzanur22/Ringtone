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
const playdl = require("play-dl");

// CRITICAL: Catch unhandled rejections globally to prevent server crashes
// play-dl sometimes throws outside of promise chains
process.on('unhandledRejection', (reason, promise) => {
  console.error('[GLOBAL] Yakalanmamiş rejection (sunucu devam ediyor):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[GLOBAL] Yakalanmamiş exception (sunucu devam ediyor):', err.message);
});

const PQueue = require("p-queue").default;

const queue = new PQueue({
  concurrency: 2,      // aynı anda max 2 işlem
  interval: 1000,      // 1 saniyede
  intervalCap: 3       // max 3 request
});

/* =========================
   PHASE 6: DISK CACHING
========================= */
const path = require("path");
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
const MAX_CACHE_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB limit
const downloadingFiles = new Set();

const MIN_AUDIO_SIZE = 50 * 1024;   // 50 KB altı ses dosyası bozuktur
const MIN_VIDEO_SIZE = 500 * 1024;  // 500 KB altı video dosyası bozuktur

async function downloadToCache(videoId, type, streamUrl) {
  const ext = type === "audio" ? "m4a" : "mp4";
  const fileName = `${type}_${videoId}.${ext}`;
  const filePath = path.join(CACHE_DIR, fileName);
  const tempPath = filePath + ".tmp";

  if (fs.existsSync(filePath)) {
    // Varsa boyut kontrolü yap, bozuksa sil
    const size = fs.statSync(filePath).size;
    const minSize = type === "audio" ? MIN_AUDIO_SIZE : MIN_VIDEO_SIZE;
    if (size >= minSize) return; // Sağlam dosya, atla
    console.log(`[DISK_CACHE] Bozuk dosya siliniyor (${size} bytes): ${fileName}`);
    fs.unlinkSync(filePath);
  }
  if (downloadingFiles.has(fileName)) return;

  downloadingFiles.add(fileName);
  try {
    const response = await axios({
      method: 'GET',
      url: streamUrl,
      responseType: 'stream',
      timeout: 120000,
      headers: {
        'User-Agent': getRandomUA(),
        'Referer': 'https://www.youtube.com/'
      },
      validateStatus: (status) => status >= 200 && status < 400
    });

    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // İndirilen dosyanın boyutunu kontrol et
    const fileSize = fs.statSync(tempPath).size;
    const minSize = type === "audio" ? MIN_AUDIO_SIZE : MIN_VIDEO_SIZE;
    if (fileSize < minSize) {
      console.log(`[DISK_CACHE_ERR] ${fileName} çok küçük (${fileSize} bytes), bozuk dosya siliniyor.`);
      fs.unlinkSync(tempPath);
      return;
    }

    fs.renameSync(tempPath, filePath);
    console.log(`[DISK_CACHE] Kaydedildi: ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    console.log(`[DISK_CACHE_ERR] ${fileName} indirilemedi: ${err.message}`);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  } finally {
    downloadingFiles.delete(fileName);
  }
}

setInterval(() => {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => !f.endsWith('.tmp'));
    let totalSize = 0;
    const fileStats = [];

    for (const f of files) {
      const p = path.join(CACHE_DIR, f);
      const s = fs.statSync(p);
      totalSize += s.size;
      fileStats.push({ path: p, size: s.size, mtime: s.mtime.getTime() });
    }

    if (totalSize > MAX_CACHE_SIZE) {
      console.log(`[DISK_MANAGER] Kapasite aşıldı! Toplam Boyut: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB. Eski dosyalar siliniyor...`);
      fileStats.sort((a, b) => a.mtime - b.mtime);
      for (const fsObj of fileStats) {
        fs.unlinkSync(fsObj.path);
        totalSize -= fsObj.size;
        console.log(`[DISK_MANAGER] Silindi: ${path.basename(fsObj.path)}`);
        if (totalSize < MAX_CACHE_SIZE * 0.9) break; // Clean down to 9 GB
      }
    }
  } catch (e) { }
}, 3600 * 1000);

/* =========================
   ERROR LOGGING & CIRCUIT BREAKER
========================= */

function logError(type, videoId, errorMessage) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] - [${type}] - VideoID: ${videoId || "N/A"} - Error: ${errorMessage}\n`;
  console.error(logLine.trim());
  try {
    fs.appendFileSync(path.join(__dirname, "error.log"), logLine);
  } catch (e) { /* ignore */ }
}

let ytDlpFailCount = 0;
let ytDlpCircuitBreakerUntil = 0;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_TIMEOUT = 5 * 60 * 1000; // 5 mins
let youtubeApiStatus = "ok";

// Analytics & Stats
const stats = {
  ytDlpSuccess: 0,
  ytDlpFail: 0,
  proxyFallbackSuccess: 0,
  proxyFallbackFail: 0,
  youtubeApiQuotaExceeded: 0,
  rateLimitHits: 0,
  totalRequests: 0
};

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

// Railway/VPS'de çalışan, sign-in gerektirmeyen güvenilir clientlar:
// web_embedded = sonuç verir ama IP banliysa yine de başarısız
// Bu sıra yt-dlp-exec'in bu versiyonunda desteklenen clientları dener
const PLAYER_CLIENTS = ["web_embedded", "tv", "mweb", "ios", "web"];

// cookies.txt (Netscape formatı) → HTTP header formatı ( key=val; key=val )
// play-dl Netscape formatı değil, HTTP cookie header şeklinde cookies ister!
function parseCookiesToHeader(cookiePath) {
  try {
    const raw = fs.readFileSync(cookiePath, "utf8")
      .replace(/^\uFEFF/, "") // BOM'u sil
      .replace(/\r/g, "");
    const lines = raw.split("\n");
    const pairs = [];
    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      if (parts.length >= 7) {
        const name = parts[5];
        const value = parts[6].trim();
        if (name) pairs.push(`${name}=${value}`);
      }
    }
    return pairs.join("; ");
  } catch (e) {
    return null;
  }
}

// play-dl token'unu sunucu başlangıcında ayarla (cookie header ile)
function initPlayDlCookies() {
  const useCookies = process.env.USE_COOKIES !== "false";
  if (useCookies && fs.existsSync("cookies.txt")) {
    const cookieHeader = parseCookiesToHeader("cookies.txt");
    if (cookieHeader && cookieHeader.length > 10) {
      playdl.setToken({ youtube: { cookie: cookieHeader } });
      console.log("[play-dl] Cookies yüklendi (", cookieHeader.length, " karakter)");
    } else {
      console.warn("[play-dl] Cookie parse başarısız veya boş");
    }
  }
}
initPlayDlCookies();

async function resolveStreamUrl(videoUrl, format, ua, countryClient = null) {
  // == 1. ADIM: play-dl (EN HIZLI - Cookies ile YouTube'a doğrudan) ==
  // yt-dlp Railway IP'sinden hiçbir şekilde çalışmıyor.
  // play-dl cookie header formatıyla Bearer gibi çalışıyor.
  try {
    console.log(`[play-dl] Deneniyor...`);
    const yt_info = await playdl.video_info(videoUrl);
    if (yt_info && yt_info.format && yt_info.format.length > 0) {
      // Audio: codec=opus/webm, Video: mp4
      const isAudio = format.includes("audio") || format === "bestaudio";
      const formats = yt_info.format;
      let chosen = null;
      if (isAudio) {
        // En yüksek kaliteli audio formatı seç
        chosen = formats
          .filter(f => f.mimeType && f.mimeType.startsWith("audio"))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      } else {
        // mp4 video seç (360p veya daha yüksek)
        chosen = formats
          .filter(f => f.mimeType && f.mimeType.includes("video/mp4"))
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (!chosen) chosen = formats[0];
      }
      if (chosen && chosen.url && chosen.url.startsWith("http")) {
        console.log(`[play-dl] BAŞARILI! format=${chosen.mimeType}`);
        return chosen.url;
      }
    }
  } catch (pdlErr) {
    console.warn(`[play-dl] Başarısız:`, pdlErr.message?.slice(0, 150));
  }

  // == 2. ADIM: yt-dlp (Sadece circuit breaker açıksa) ==
  if (Date.now() >= ytDlpCircuitBreakerUntil) {
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
            "referer:https://www.youtube.com/",
            `user-agent:${ua}`
          ]
        };
        const useCookies = process.env.USE_COOKIES !== "false";
        if (useCookies && fs.existsSync("cookies.txt")) {
          opts.cookies = "cookies.txt";
        }
        if (client !== "default") {
          opts.extractorArgs = `youtube:player_client=${client};player_skip=webpage`;
        }
        console.log(`[yt-dlp] Deneniyor: client=${client}, format=${format}`);
        const result = await ytdlp(videoUrl, opts);
        const url = result.toString().trim();
        if (url && url.startsWith("http")) {
          console.log(`[yt-dlp] Başarılı: client=${client}`);
          ytDlpFailCount = 0;
          stats.ytDlpSuccess++;
          return url;
        }
      } catch (err) {
        console.warn(`[yt-dlp] client=${client} başarısız:`, err.stderr?.slice(0, 100) || err.message?.slice(0, 100));
        lastError = err;
      }
    }
    ytDlpFailCount++;
    if (ytDlpFailCount >= CIRCUIT_BREAKER_THRESHOLD) {
      ytDlpCircuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_DURATION;
      console.error(`[CIRCUIT_BREAKER] yt-dlp devre dışı bırakıldı.`);
    }
  } else {
    console.warn(`[yt-dlp] Circuit breaker aktif, atlanıyor.`);
  }

  stats.ytDlpFail++;
  throw lastError || new Error("Tüm player client'lar ve play-dl başarısız oldu");
}
const PIPED_INSTANCES = [
  "https://pipedapi.aeong.one",
  "https://pipedapi.in.projectsegfau.lt",
  "https://pipedapi.us.projectsegfau.lt",
  "https://api.piped.projectsegfau.lt",
  "https://pipedapi.tokhmi.xyz",
  "https://pipedapi.smnz.de",
  "https://pipedapi.kavin.rocks"
];

const INVIDIOUS_INSTANCES = [
  "https://invidious.fdn.fr",
  "https://invidious.projectsegfau.lt",
  "https://yewtu.be",
  "https://invidious.privacyredirect.com",
  "https://inv.us.projectsegfau.lt",
  "https://invidious.nerdvpn.de",
  "https://invidious.io",
  "https://invidious.slipfox.xyz"
];

async function fetchFromPiped(endpointPath) {
  let lastError = null;
  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await axiosClient.get(`${instance}${endpointPath}`, { timeout: 6000 });
      if (res && res.data) {
        if (res.data.error) throw new Error(`API Error: ${res.data.error}`);
        if (!res.data.audioStreams && endpointPath.includes("/streams/")) throw new Error("API returned no valid streams.");
        return res;
      }
    } catch (err) {
      lastError = err;
      logError("PIPED_INSTANCE_ERR", null, `Instance ${instance} error: ${err.message}`);
    }
  }
  throw lastError || new Error("Tüm Piped API instance'ları başarısız oldu.");
}

async function tryInvidiousFallback(videoId, type) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const res = await axiosClient.get(`${instance}/api/v1/videos/${videoId}`, { timeout: 6000 });
      if (res && res.data) {
        if (res.data.error) throw new Error(res.data.error);
        if (type === "audio") {
          const streams = res.data.adaptiveFormats;
          if (streams && Array.isArray(streams)) {
            const m4a = streams.find(s => (s.type && s.type.includes("audio/mp4")) || s.container === "m4a") || streams.find(s => s.type && s.type.includes("audio"));
            if (m4a && m4a.url) return m4a.url;
          }
        } else {
          const streams = res.data.formatStreams;
          if (streams && Array.isArray(streams)) {
            const mp4 = streams.find(s => (s.type && s.type.includes("video/mp4") && s.qualityLabel === "720p")) ||
              streams.find(s => s.type && s.type.includes("video/mp4")) ||
              streams[0];
            if (mp4 && mp4.url) return mp4.url;
          }
        }
        throw new Error("No valid streams in Invidious instance payload.");
      }
    } catch (err) {
      logError("INVIDIOUS_INSTANCE_ERR", videoId, `Instance ${instance} failed: ${err.message}`);
    }
  }
  throw new Error("All Invidious instances failed.");
}

async function resolveStreamUrlWithFallback(videoId, type, ua, countryClient) {
  try {
    const format = type === "audio" ? "bestaudio" : "best[ext=mp4]/best";
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    return await resolveStreamUrl(url, format, ua, countryClient);
  } catch (err) {
    logError("YTDLP_FATAL_FALLBACK", videoId, `yt-dlp failed: ${err.message}. Trying Ultimate Proxy Ring (Piped + Invidious)...`);

    // First line of defense: Piped APIs
    try {
      const pipedRes = await fetchFromPiped(`/streams/${videoId}`);
      if (type === "audio") {
        const streams = pipedRes.data.audioStreams;
        if (!streams || !Array.isArray(streams) || streams.length === 0) {
          throw new Error("No valid audioStreams array found");
        }
        const best = streams.find(s => (s.mimeType && s.mimeType.includes("mp4a")) || s.format === "M4A") || streams[0];
        if (best && best.url) {
          logError("PROXY_FALLBACK_SUCCESS", videoId, `Piped API Fallback successful for audio.`);
          stats.proxyFallbackSuccess++;
          return best.url;
        }
      } else {
        const streams = pipedRes.data.videoStreams;
        if (!streams || !Array.isArray(streams) || streams.length === 0) {
          throw new Error("No valid videoStreams array found");
        }
        const best = streams.find(s => s.videoOnly === false && s.format === "MPEG_4" && s.quality === "720p") ||
          streams.find(s => s.videoOnly === false && s.format === "MPEG_4") ||
          streams[0];
        if (best && best.url) {
          logError("PROXY_FALLBACK_SUCCESS", videoId, `Piped API Fallback successful for video.`);
          stats.proxyFallbackSuccess++;
          return best.url;
        }
      }
    } catch (pipedErr) {
      logError("PIPED_FALLBACK_ERR", videoId, pipedErr.message);
    }

    // Second line of defense: Invidious APIs
    try {
      const invidiousUrl = await tryInvidiousFallback(videoId, type);
      if (invidiousUrl) {
        logError("PROXY_FALLBACK_SUCCESS", videoId, `Invidious API Fallback successful for ${type}.`);
        stats.proxyFallbackSuccess++;
        return invidiousUrl;
      }
    } catch (invidiousErr) {
      logError("INVIDIOUS_FALLBACK_ERR", videoId, invidiousErr.message);
    }

    stats.proxyFallbackFail++;
    throw new Error("Tüm proxy ağları başarısız oldu.");
  }
}

const axiosClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true })
});

const app = express();
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  stats.totalRequests++;
  const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
  console.log(`[REQ] ${new Date().toISOString()} | ${req.method} ${req.originalUrl} | IP: ${req.ip} | Country: ${country}`);
  next();
});

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
  max: 40,
  handler: (req, res, next, options) => {
    stats.rateLimitHits++;
    logError("RATE_LIMIT", null, `IP ${req.ip} rate limit aştı (Global)`);
    res.status(options.statusCode).send(options.message);
  }
}));

const searchLimiter = rateLimit({ //spam search engellemek için.
  windowMs: 60 * 1000,
  max: 20,
  handler: (req, res, next, options) => {
    stats.rateLimitHits++;
    logError("RATE_LIMIT", null, `IP ${req.ip} rate limit aştı (Search)`);
    res.status(options.statusCode).send(options.message);
  }
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
    uptimeSeconds: Math.floor(process.uptime()),
    memoryRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    redis: redis ? "connected" : "disconnected",
    ytDlp: Date.now() < ytDlpCircuitBreakerUntil ? "circuit_breaker_open" : "ok",
    youtubeApi: youtubeApiStatus
  });
});

app.get("/admin/stats", (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    stats: stats
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
        stats.youtubeApiQuotaExceeded++;
        const pipedRes = await fetchFromPiped("/trending?region=US");
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
        stats.youtubeApiQuotaExceeded++;
        const pipedRes = await fetchFromPiped(`/search?q=${encodeURIComponent(query)}&filter=videos`);
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

    const typeStr = req.path.includes("video") || req.path.includes("mp4") ? "video" : "audio";
    const extStr = typeStr === "audio" ? "m4a" : "mp4";
    const localFile = path.join(CACHE_DIR, `${typeStr}_${videoId}.${extStr}`);

    if (fs.existsSync(localFile)) {
      console.log(`[DISK_CACHE_HIT] Serving local ${typeStr} for`, videoId);

      if (req.path.includes("download")) {
        res.setHeader("Content-Disposition", `attachment; filename=${typeStr}_${videoId}.${extStr}`);
      }
      return res.sendFile(localFile);
    }

    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    const cacheKey = `stream:audio:${videoId}`;
    const cachedData = await cacheGet(cacheKey);
    let streamUrl, ua;

    if (cachedData && cachedData.url) {
      streamUrl = cachedData.url;
      ua = cachedData.ua || getRandomUA();
      console.log("AUDIO CACHE HIT:", videoId);
    } else {
      ua = getRandomUA();
      // Queue ile sıralı çalıştır
      streamUrl = await queue.add(async () => {
        await randomJitter();
        return resolveStreamUrlWithFallback(videoId, "audio", ua, countryClient);
      });
      // URL'ler genelde daha kısa sürede expire olur
      await cacheSet(cacheKey, { url: streamUrl, ua }, 3600);
      console.log("AUDIO CACHE SAVE:", videoId);
    }

    let response;
    try {
      const headersOptions = {
        "User-Agent": ua,
        "Referer": "https://www.youtube.com/"
      };
      if (req.headers.range) headersOptions["Range"] = req.headers.range;

      response = await axiosClient({
        method: "GET",
        url: streamUrl,
        responseType: "stream",
        headers: headersOptions,
        validateStatus: (status) => status < 400
      });
    } catch (fetchErr) {
      if (fetchErr.response && fetchErr.response.status === 403) {
        // Cache URL expire olmuş veya banlanmış, temizle
        if (redis) redis.del(cacheKey);
        memoryCache.delete(cacheKey);
      }
      throw fetchErr;
    }

    res.status(response.status);
    if (response.headers["content-type"]) res.setHeader("Content-Type", response.headers["content-type"]);
    if (response.headers["content-length"]) res.setHeader("Content-Length", response.headers["content-length"]);
    if (response.headers["content-range"]) res.setHeader("Content-Range", response.headers["content-range"]);
    if (response.headers["accept-ranges"]) res.setHeader("Accept-Ranges", response.headers["accept-ranges"]);

    response.data.pipe(res);

    if (typeof streamUrl !== 'undefined') {
      downloadToCache(videoId, typeStr, streamUrl).catch(e => { });
    }
  } catch (err) {
    logError("STREAM", req.query.videoId, err.message);
    console.error("STREAM ERROR:", err.message);
    res.status(500).json({
      error: "Streaming failed",
      message: err.message
    });
  }
});


// VIDEO STREAM (MP4) — Önce hızlı proxy, arka planda cache
app.get("/stream/video", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const localFile = path.join(CACHE_DIR, `video_${videoId}.mp4`);

    // 1. Diskten sağlam dosya varsa direkt serve et
    if (fs.existsSync(localFile) && fs.statSync(localFile).size > MIN_VIDEO_SIZE) {
      console.log(`[DISK_CACHE_HIT] Serving local video for`, videoId);
      const stat = fs.statSync(localFile);
      const fileSize = stat.size;

      // Range header desteği (ExoPlayer seek için)
      if (req.headers.range) {
        const parts = req.headers.range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": "video/mp4"
        });
        fs.createReadStream(localFile, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": fileSize,
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes"
        });
        fs.createReadStream(localFile).pipe(res);
      }
      return;
    }

    // Bozuk/küçük dosya varsa sil
    if (fs.existsSync(localFile)) {
      fs.unlinkSync(localFile);
    }

    // 2. HIZLI YOL: Stream URL çözüp anında proxy yap (yt-dlp beklemeden!)
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);
    const ua = getRandomUA();

    let streamUrl;
    try {
      streamUrl = await queue.add(async () => {
        await randomJitter();
        return resolveStreamUrlWithFallback(videoId, "video", ua, countryClient);
      });
    } catch (resolveErr) {
      console.error(`[STREAM_VIDEO] URL resolve başarısız, yt-dlp fallback: ${resolveErr.message}`);

      // 3. YAVAŞ FALLBACK: yt-dlp ile indir, sonra serve et
      const tempFile = localFile + ".tmp";
      const opts = {
        format: 'best[ext=mp4]/best',
        output: tempFile,
        addHeader: [
          'referer:https://www.youtube.com/',
          `user-agent:${ua}`
        ]
      };
      const useCookies = process.env.USE_COOKIES !== "false";
      if (useCookies && fs.existsSync("cookies.txt")) {
        opts.cookies = "cookies.txt";
      }

      await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, opts);

      if (!fs.existsSync(tempFile) || fs.statSync(tempFile).size < MIN_VIDEO_SIZE) {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        throw new Error("yt-dlp downloaded a corrupted/empty file");
      }

      fs.renameSync(tempFile, localFile);
      console.log(`[yt-dlp] Video kaydedildi: video_${videoId}.mp4 (${(fs.statSync(localFile).size / 1024 / 1024).toFixed(1)} MB)`);
      res.setHeader("Content-Type", "video/mp4");
      return res.sendFile(localFile);
    }

    // Stream URL başarıyla çözüldü → anında proxy yap
    console.log(`[PROXY] Video streaming: ${videoId}`);
    const headersOptions = {
      "User-Agent": ua,
      "Referer": "https://www.youtube.com/"
    };
    if (req.headers.range) headersOptions["Range"] = req.headers.range;

    const response = await axiosClient({
      method: "GET",
      url: streamUrl,
      responseType: "stream",
      headers: headersOptions,
      validateStatus: (status) => status < 400
    });

    res.status(response.status);
    if (response.headers["content-type"]) res.setHeader("Content-Type", response.headers["content-type"]);
    if (response.headers["content-length"]) res.setHeader("Content-Length", response.headers["content-length"]);
    if (response.headers["content-range"]) res.setHeader("Content-Range", response.headers["content-range"]);
    if (response.headers["accept-ranges"]) res.setHeader("Accept-Ranges", response.headers["accept-ranges"]);
    response.data.pipe(res);

    // Arka planda cache'e kaydet (kullanıcıyı bekletmeden)
    downloadToCache(videoId, "video", streamUrl).catch(() => { });

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
    console.log("Top50 cache hazır (Redis).");
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

    const typeStr = req.path.includes("video") || req.path.includes("mp4") ? "video" : "audio";
    const extStr = typeStr === "audio" ? "m4a" : "mp4";
    const localFile = path.join(CACHE_DIR, `${typeStr}_${videoId}.${extStr}`);

    if (fs.existsSync(localFile)) {
      console.log(`[DISK_CACHE_HIT] Serving local ${typeStr} for`, videoId);

      if (req.path.includes("download")) {
        res.setHeader("Content-Disposition", `attachment; filename=${typeStr}_${videoId}.${extStr}`);
      }
      return res.sendFile(localFile);
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=audio.m4a");

    const ua = getRandomUA();
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    await randomJitter();
    const streamUrl = await queue.add(() =>
      resolveStreamUrlWithFallback(videoId, "audio", ua, countryClient)
    );

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }

    const response = await axios({
      method: "GET",
      url: streamUrl.toString().trim(),
      responseType: "stream",
      timeout: 20000,
      headers: {
        "User-Agent": ua,
        "Referer": "https://www.youtube.com/"
      }
    });

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);

    if (typeof streamUrl !== 'undefined') {
      downloadToCache(videoId, typeStr, streamUrl).catch(e => { });
    }

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

    const typeStr = req.path.includes("video") || req.path.includes("mp4") ? "video" : "audio";
    const extStr = typeStr === "audio" ? "m4a" : "mp4";
    const localFile = path.join(CACHE_DIR, `${typeStr}_${videoId}.${extStr}`);

    if (fs.existsSync(localFile)) {
      console.log(`[DISK_CACHE_HIT] Serving local ${typeStr} for`, videoId);

      if (req.path.includes("download")) {
        res.setHeader("Content-Disposition", `attachment; filename=${typeStr}_${videoId}.${extStr}`);
      }
      return res.sendFile(localFile);
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=video.mp4");

    const ua = getRandomUA();
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    await randomJitter();
    const streamUrl = await queue.add(() =>
      resolveStreamUrlWithFallback(videoId, "video", ua, countryClient)
    );

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }

    const response = await axios({
      method: "GET",
      url: streamUrl.toString().trim(),
      responseType: "stream",
      timeout: 20000,
      headers: {
        "User-Agent": ua,
        "Referer": "https://www.youtube.com/"
      }
    });

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);

    if (typeof streamUrl !== 'undefined') {
      downloadToCache(videoId, typeStr, streamUrl).catch(e => { });
    }

  } catch (err) {
    logError("DOWNLOAD_MP4", req.query.videoId, err.message);
    console.error("MP4 ERROR:", err.message);
    res.status(500).json({ error: "MP4 download failed" });
  }
});
