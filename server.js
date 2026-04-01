require("dotenv").config();

const axios = require("axios");
const http = require("http");
const https = require("https");
const express = require("express");
const ytdlp = require("yt-dlp-exec");
// PoToken: sistem yt-dlp binary'sini kullan (Docker'dan gelir)
const YT_DLP_PATH = process.env.YT_DLP_PATH || "/usr/local/bin/yt-dlp";
const cors = require("cors");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const Redis = require("ioredis");

const PQueue = require("p-queue").default;
const { Innertube, UniversalCache } = require("youtubei.js");

/* =========================
   YOUTUBEI.JS OAUTH2 SETUP
========================= */
let yt = null;
async function initYoutubei() {
  try {
    const cache = new UniversalCache(false);
    yt = await Innertube.create({ 
      cache, 
      generate_session_locally: true,
      client_type: 'WEB'
    });
    
    let creds = null;
    if (process.env.YT_OAUTH_JSON) {
      creds = JSON.parse(process.env.YT_OAUTH_JSON);
      console.log("[YOUTUBEI] OAuth2 Girişi Başarılı! (Env Var)");
    } else if (fs.existsSync('oauth_credentials.json')) {
      creds = JSON.parse(fs.readFileSync('oauth_credentials.json', 'utf-8'));
      console.log("[YOUTUBEI] OAuth2 Girişi Başarılı! (File)");
    }

    if (creds) {
      // Token süresi kontrolü — expired token ile istek atma, direkt anonim moda geç
      if (creds.expiry_date && new Date(creds.expiry_date) < new Date()) {
        console.warn("[YOUTUBEI] ⚠️ OAuth2 token süresi dolmuş! Anonim modda devam ediliyor.");
        console.warn("[YOUTUBEI] Yenilemek için: node generate_token.js");
      } else {
        await yt.session.signIn(creds);
      }
    } else {
      console.warn("[YOUTUBEI] OAuth kimlik bilgisi bulunamadı, anonim modda çalışıyor.");
    }
  } catch (err) {
    console.error("[YOUTUBEI] Başlatma Hatası:", err.message);
  }
}
initYoutubei();

const queue = new PQueue({
  concurrency: 4,      // aynı anda max 4 işlem
  interval: 1000,      // 1 saniyede
  intervalCap: 6       // max 6 request
});

/* =========================
   PHASE 6: DISK CACHING
========================= */
const path = require("path");
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
const MAX_CACHE_SIZE = parseInt(process.env.CACHE_SIZE_MB || "500") * 1024 * 1024; // Railway: 500MB default

function checkDiskSpaceAndCleanup() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR).map(f => {
      const p = path.join(CACHE_DIR, f);
      return { path: p, stat: fs.statSync(p) };
    });

    const totalSize = files.reduce((acc, f) => acc + f.stat.size, 0);
    if (totalSize > MAX_CACHE_SIZE) {
      console.log(`[DISK_CLEANUP] Disk doluyor (${(totalSize / 1024 / 1024).toFixed(1)} MB). Temizleniyor...`);
      files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
      let deletedSize = 0;
      const targetToDelete = totalSize - (MAX_CACHE_SIZE * 0.7);
      for (const file of files) {
        if (deletedSize >= targetToDelete) break;
        try { fs.unlinkSync(file.path); deletedSize += file.stat.size; } catch (e) {}
      }
      console.log(`[DISK_CLEANUP] ${(deletedSize / 1024 / 1024).toFixed(1)} MB yer açıldı.`);
    }
  } catch (err) { console.error(`[DISK_CLEANUP] Hata: ${err.message}`); }
}
setInterval(checkDiskSpaceAndCleanup, 5 * 60 * 1000); // 5 dakikada bir kontrol
const downloadingFiles = new Set();

async function downloadToCache(videoId, type, streamUrl, ua = null) {
  const ext = type === "audio" ? "m4a" : "mp4";
  const fileName = `${type}_${videoId}.${ext}`;
  const filePath = path.join(CACHE_DIR, fileName);
  const tempPath = filePath + ".tmp";

  if (fs.existsSync(filePath) || downloadingFiles.has(fileName)) return;

  downloadingFiles.add(fileName);
  try {
    const headers = {
      "Referer": "https://www.youtube.com/"
    };
    if (ua) headers["User-Agent"] = ua;

    const response = await axios({
      method: 'GET',
      url: streamUrl,
      responseType: 'stream',
      timeout: 120000,
      headers: headers,
      validateStatus: (status) => status >= 200 && status < 400
    });

    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    fs.renameSync(tempPath, filePath);
    
    // Final kontrol: Eğer dosya çok küçükse kaydetme, sil!
    const stats = fs.statSync(filePath);
    const minSize = type === "video" ? 1024 * 1024 : 100 * 1024;
    if (stats.size < minSize) {
      fs.unlinkSync(filePath);
      throw new Error(`Download successful but file too small (${(stats.size/1024).toFixed(1)} KB) - likely bot detection.`);
    }
    
    console.log(`[DISK_CACHE] Kaydedildi: ${fileName} (${(stats.size/1024/1024).toFixed(2)} MB)`);
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
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0"
];
function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
const randomJitter = async () => {
  // 100ms ile 400ms arası rastgele gecikme (hızlı ama doğal)
  const ms = Math.floor(Math.random() * 300) + 100;
  await new Promise(resolve => setTimeout(resolve, ms));
};

// Fallback player client stratejisi: default → android → mweb → web → ios
const PLAYER_CLIENTS = ["default", "android", "mweb", "web", "ios"];

async function resolveWithYoutubei(videoId, type) {
  if (!yt) throw new Error("Youtubei initialized değil");
  
  console.log(`[YOUTUBEI] Çözümleniyor: ${videoId} (${type})`);
  const info = await yt.getBasicInfo(videoId);
  const format = info.chooseFormat({ 
    type: type === "audio" ? "audio" : "video", 
    quality: "best",
    format: "mp4"
  });
  
  if (format && format.url) {
    console.log(`[YOUTUBEI] Başarılı!`);
    return format.url;
  }
  throw new Error("Youtubei uygun format bulamadı");
}

const { execFile, spawn } = require("child_process");

function ytdlpStream(videoId, type, req, res) {
  return new Promise((resolve, reject) => {
    const ext = type === "audio" ? "m4a" : "mp4";
    const format = type === "audio" ? "bestaudio[ext=m4a]/bestaudio" : "best[ext=mp4]/best";
    const outputFile = path.join(CACHE_DIR, `${type}_${videoId}.${ext}`);
    const tempFile = outputFile + ".pipe.tmp";

    const ytdlpBin = fs.existsSync("/usr/local/bin/yt-dlp") ? "/usr/local/bin/yt-dlp" : 
                      fs.existsSync("/app/node_modules/yt-dlp-exec/bin/yt-dlp") ? "/app/node_modules/yt-dlp-exec/bin/yt-dlp" : "yt-dlp";

    const args = [
      `https://www.youtube.com/watch?v=${videoId}`,
      "-f", format,
      "-o", "-", 
      "--no-playlist",
      "--no-part",
      "--no-mtime",
      "--concurrent-fragments", "1",
      "--quiet", "--no-warnings"
    ];

    if (process.env.USE_COOKIES !== "false" && fs.existsSync("cookies.txt")) {
      args.push("--cookies", "cookies.txt");
    }
    if (process.env.PROXY_URL) {
      args.push("--proxy", process.env.PROXY_URL);
    }

    console.log(`[YTDL_STREAM] Başlatılıyor: ${videoId} (${type})`);
    
    const ytdlpProc = spawn(ytdlpBin, args);

    res.setHeader("Content-Type", type === "video" ? "video/mp4" : "audio/m4a");
    if (type === "video") res.setHeader("Accept-Ranges", "bytes");

    ytdlpProc.stdout.pipe(res);

    const cacheWriter = fs.createWriteStream(tempFile);
    ytdlpProc.stdout.pipe(cacheWriter);

    ytdlpProc.stderr.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("ERROR")) console.error(`[YTDL_STREAM] Hata: ${msg}`);
    });

    ytdlpProc.on("close", (code) => {
      cacheWriter.end();
      if (code === 0) {
        console.log(`[YTDL_STREAM] Başarıyla tamamlandı: ${videoId}`);
        if (fs.existsSync(tempFile)) {
          const stats = fs.statSync(tempFile);
          if (stats.size > (type === "video" ? 1024*1024 : 100*1024)) {
            fs.renameSync(tempFile, outputFile);
          } else {
            fs.unlinkSync(tempFile);
          }
        }
        resolve();
      } else {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        if (!res.headersSent) res.status(500).send("Streaming failed");
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });

    req.on("close", () => {
      if (ytdlpProc) ytdlpProc.kill();
      cacheWriter.end();
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    });
  });
}

function ytdlpDirectDownload(videoId, type) {
  return new Promise((resolve, reject) => {
    const ext = type === "audio" ? "m4a" : "mp4";
    const format = type === "audio" ? "bestaudio[ext=m4a]/bestaudio" : "best[ext=mp4]/best";
    const outputFile = path.join(CACHE_DIR, `${type}_${videoId}.${ext}`);
    const tempFile = outputFile + ".ytdl";
    
    if (fs.existsSync(outputFile)) {
      const stats = fs.statSync(outputFile);
      const minSize = type === "video" ? 1024 * 1024 : 100 * 1024;
      if (stats.size >= minSize) {
        console.log(`[YTDL_DIRECT] Cache hit: ${outputFile}`);
        return resolve(outputFile);
      }
      fs.unlinkSync(outputFile);
    }

    const ytdlpBin = fs.existsSync("/usr/local/bin/yt-dlp") ? "/usr/local/bin/yt-dlp" : 
                      fs.existsSync("/app/node_modules/yt-dlp-exec/bin/yt-dlp") ? "/app/node_modules/yt-dlp-exec/bin/yt-dlp" : "yt-dlp";

    const args = [
      `https://www.youtube.com/watch?v=${videoId}`,
      "-f", format,
      "-o", tempFile,
      "--no-playlist",
      "--no-part",
      "--no-mtime",
      "--concurrent-fragments", "1",
      "--retries", "3",
      "--socket-timeout", "30"
    ];

    // Cookies ekle
    if (process.env.USE_COOKIES !== "false" && fs.existsSync("cookies.txt")) {
      args.push("--cookies", "cookies.txt");
    }

    // Proxy ekle
    if (process.env.PROXY_URL) {
      args.push("--proxy", process.env.PROXY_URL);
    }

    console.log(`[YTDL_DIRECT] İndiriliyor: ${videoId} (${type})`);
    
    const proc = execFile(ytdlpBin, args, { 
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[YTDL_DIRECT] Hata: ${stderr || error.message}`);
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return reject(new Error(`yt-dlp direct download failed: ${error.message}`));
      }

      // Dosya boyutu kontrolü
      if (!fs.existsSync(tempFile)) {
        return reject(new Error("yt-dlp dosya oluşturamadı"));
      }
      
      const stats = fs.statSync(tempFile);
      const minSize = type === "video" ? 500 * 1024 : 50 * 1024; // 500KB video, 50KB audio min
      
      if (stats.size < minSize) {
        fs.unlinkSync(tempFile);
        return reject(new Error(`İndirilen dosya çok küçük (${(stats.size/1024).toFixed(1)} KB) - bot detection`));
      }

      // Başarılı! Temp'ten asıl dosyaya taşı
      fs.renameSync(tempFile, outputFile);
      console.log(`[YTDL_DIRECT] Başarılı: ${outputFile} (${(stats.size/1024/1024).toFixed(2)} MB)`);
      resolve(outputFile);
    });
  });
}

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
          "referer:https://www.youtube.com/",
          `user-agent:${ua}`
        ]
      };

      // cookies.txt varsa ve USE_COOKIES=false değilse ekle
      const useCookies = process.env.USE_COOKIES !== "false";
      if (useCookies && fs.existsSync("cookies.txt")) {
        opts.cookies = "cookies.txt";
      }

      // Proxy desteği
      if (process.env.PROXY_URL) {
        opts.proxy = process.env.PROXY_URL;
      }

      // "default" = yt-dlp kendi seçsin
      if (client !== "default") {
        opts.extractorArgs = `youtube:player_client=${client}`;
      }

      console.log(`[yt-dlp] Deneniyor: client=${client}, format=${format}`);
      const result = await ytdlp(videoUrl, opts, { env: { ...process.env, PATH: '/usr/local/bin:' + (process.env.PATH || '') } });
      const url = result.toString().trim();

      if (url && url.startsWith("http")) {
        console.log(`[yt-dlp] Başarılı: client=${client}`);
        ytDlpFailCount = 0; // reset on success
        stats.ytDlpSuccess++;
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

  stats.ytDlpFail++;
  throw lastError || new Error("Tüm player client'lar başarısız oldu");
}

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://api.piped.yt",
  "https://piped-api.lunar.icu",
  "https://pipedapi.syncpundit.io",
  "https://api.piped.projectsegfau.lt",
  "https://pipedapi.smnz.de",
  "https://pipedapi.tokhmi.xyz",
  "https://pipedapi.us.projectsegfau.lt",
  "https://pi.ped.yt",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.astartes.nl"
];

const INVIDIOUS_INSTANCES = [
  "https://yewtu.be",
  "https://vid.puffyan.us",
  "https://inv.rvere.com",
  "https://invidious.nerdvpn.de",
  "https://invidious.lunar.icu",
  "https://invidious.flokinet.to",
  "https://invidious.privacyredirect.com",
  "https://invidious.weblibre.org",
  "https://yt.artemislena.eu",
  "https://invidious.jing.rocks"
];

async function fetchFromPiped(endpointPath) {
  let lastError = null;
  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await axiosClient.get(`${instance}${endpointPath}`, { timeout: 3000 });
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
      const res = await axiosClient.get(`${instance}/api/v1/videos/${videoId}`, { timeout: 3000 });
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
  // FIRST ATTEMPT: YouTube OAuth2 (Smart TV Session)
  try {
    const oauthUrl = await resolveWithYoutubei(videoId, type);
    if (oauthUrl) {
      console.log(`[AUTH_SUCCESS] ${videoId} çözümlendi (OAuth2)`);
      return oauthUrl;
    }
  } catch (oauthErr) {
    console.warn(`[AUTH_FALLBACK] OAuth2 başarısız: ${oauthErr.message}`);
  }

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

// Deduplication: Aynı videoId için eşzamanlı resolve isteklerini birleştir
const pendingResolves = new Map();
async function deduplicatedResolve(videoId, type, ua, countryClient) {
  const key = `${videoId}_${type}`;
  if (pendingResolves.has(key)) {
    console.log(`[DEDUP] ${videoId} (${type}) zaten çözümleniyor, bekleniyor...`);
    return pendingResolves.get(key);
  }
  const promise = resolveStreamUrlWithFallback(videoId, type, ua, countryClient);
  pendingResolves.set(key, promise);
  try { return await promise; } finally { pendingResolves.delete(key); }
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
  // health, config ve stream açık (ExoPlayer custom header gönderemiyor)
  // /download korumalı kalır (abuse engeli)
  if (
    req.path === "/health" ||
    req.path === "/config" ||
    req.path.startsWith("/stream")
  ) return next();

  const expectedKey = process.env.APP_KEY || "RINGTONE_MASTER_V2_SECRET_2026";
  if (appKey === expectedKey) {
    next();
  } else {
    console.warn(`[AUTH] Yetkisiz erişim: ${req.ip} → ${req.path}`);
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
      const stats = fs.statSync(localFile);
      const minSize = typeStr === "video" ? 1024 * 1024 : 200 * 1024;
      if (stats.size < minSize) {
        console.warn(`[DISK_CACHE_ERR] Bozuk dosya (çok küçük), siliniyor: ${localFile}`);
        fs.unlinkSync(localFile);
      } else {
        console.log(`[DISK_CACHE_HIT] Serving local ${typeStr} for`, videoId);
        if (req.path.includes("download")) {
        res.setHeader("Content-Disposition", `attachment; filename=${typeStr}_${videoId}.${extStr}`);
      }
        res.setHeader("Content-Type", typeStr === "video" ? "video/mp4" : "audio/m4a");
        return res.sendFile(localFile);
      }
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
        return deduplicatedResolve(videoId, "audio", ua, countryClient);
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
      downloadToCache(videoId, typeStr, streamUrl, ua).catch(e => { });
    }
  } catch (err) {
    logError("STREAM", req.query.videoId, err.message);
    console.error("STREAM ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Streaming failed",
        message: err.message
      });
    } else {
      res.end();
    }
  }
});


// VIDEO STREAM (MP4) - yt-dlp direct download öncelikli
app.get("/stream/video", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const typeStr = "video";
    const extStr = "mp4";
    const localFile = path.join(CACHE_DIR, `${typeStr}_${videoId}.${extStr}`);

    // 1. Disk cache kontrolü
    if (fs.existsSync(localFile)) {
      const stats = fs.statSync(localFile);
      if (stats.size < 1024 * 1024) {
        console.warn(`[DISK_CACHE_ERR] Bozuk dosya, siliniyor: ${localFile}`);
        fs.unlinkSync(localFile);
      } else {
        console.log(`[DISK_CACHE_HIT] Serving local video for`, videoId);
        res.setHeader("Content-Type", "video/mp4");
        return res.sendFile(localFile);
      }
    }

    // 2. yt-dlp STREAM (INSTANT PLAY)
    try {
      console.log(`[STREAM_VIDEO] Instant streaming başlatılıyor: ${videoId}`);
      return await queue.add(() => ytdlpStream(videoId, "video", req, res));
    } catch (streamErr) {
      console.warn(`[STREAM_VIDEO] Instant streaming başarısız, fallback deneniyor: ${streamErr.message}`);
      if (res.headersSent) throw streamErr;
    }

    // 3. Fallback: Direct Download (Eğer streaming bir şekilde fail olursa)
    try {
      const downloadedFile = await queue.add(() => ytdlpDirectDownload(videoId, "video"));
      
      if (downloadedFile && fs.existsSync(downloadedFile)) {
        console.log(`[STREAM_VIDEO] Direct download başarılı, sunuluyor: ${videoId}`);
        res.setHeader("Content-Type", "video/mp4");
        return res.sendFile(downloadedFile);
      }
    } catch (directErr) {
      console.warn(`[STREAM_VIDEO] Direct download başarısız: ${directErr.message}`);
    }

    // 3. Eski yöntem fallback (URL çıkar + axios ile indir)
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);
    const ua = getRandomUA();

    const streamUrl = await queue.add(async () => {
      await randomJitter();
      return deduplicatedResolve(videoId, "video", ua, countryClient);
    });

    let response;
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

    res.status(response.status);
    if (response.headers["content-type"]) res.setHeader("Content-Type", response.headers["content-type"]);
    if (response.headers["content-length"]) res.setHeader("Content-Length", response.headers["content-length"]);
    if (response.headers["content-range"]) res.setHeader("Content-Range", response.headers["content-range"]);
    if (response.headers["accept-ranges"]) res.setHeader("Accept-Ranges", response.headers["accept-ranges"]);

    response.data.pipe(res);

  } catch (err) {
    logError("STREAM_VIDEO", req.query.videoId, err.message);
    console.error("VIDEO STREAM ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Video streaming failed" });
    } else {
      res.end();
    }
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
      const stats = fs.statSync(localFile);
      const minSize = typeStr === "video" ? 1024 * 1024 : 200 * 1024;
      if (stats.size < minSize) {
        console.warn(`[DISK_CACHE_ERR] Bozuk dosya (çok küçük), siliniyor: ${localFile}`);
        fs.unlinkSync(localFile);
      } else {
        console.log(`[DISK_CACHE_HIT] Serving local ${typeStr} for`, videoId);
        if (req.path.includes("download")) {
        res.setHeader("Content-Disposition", `attachment; filename=${typeStr}_${videoId}.${extStr}`);
      }
        res.setHeader("Content-Type", typeStr === "video" ? "video/mp4" : "audio/m4a");
        return res.sendFile(localFile);
      }
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=audio.m4a");

    const ua = getRandomUA();
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    await randomJitter();
    const streamUrl = await queue.add(() =>
      deduplicatedResolve(videoId, "audio", ua, countryClient)
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
      downloadToCache(videoId, typeStr, streamUrl, ua).catch(e => { });
    }

  } catch (err) {
    logError("DOWNLOAD_MP3", req.query.videoId, err.message);
    console.error("MP3 ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Audio download failed" });
    } else {
      res.end();
    }
  }
});

//mp4 - yt-dlp direct download öncelikli
app.get("/download/mp4", async (req, res) => {
  try {
    const { videoId } = req.query;

    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const typeStr = "video";
    const extStr = "mp4";
    const localFile = path.join(CACHE_DIR, `${typeStr}_${videoId}.${extStr}`);

    // 1. Disk cache kontrolü
    if (fs.existsSync(localFile)) {
      const stats = fs.statSync(localFile);
      if (stats.size < 1024 * 1024) {
        console.warn(`[DISK_CACHE_ERR] Bozuk dosya, siliniyor: ${localFile}`);
        fs.unlinkSync(localFile);
      } else {
        console.log(`[DISK_CACHE_HIT] Serving local video for`, videoId);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
        return res.sendFile(localFile);
      }
    }

    // 2. yt-dlp STREAM (INSTANT DOWNLOAD)
    try {
      console.log(`[DOWNLOAD_MP4] Instant streaming (download) başlatılıyor: ${videoId}`);
      res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
      return await queue.add(() => ytdlpStream(videoId, "video", req, res));
    } catch (streamErr) {
      console.warn(`[DOWNLOAD_MP4] Instant streaming başarısız, fallback deneniyor: ${streamErr.message}`);
      if (res.headersSent) throw streamErr;
    }

    // 3. Fallback: Direct Download
    try {
      const downloadedFile = await queue.add(() => ytdlpDirectDownload(videoId, "video"));
      
      if (downloadedFile && fs.existsSync(downloadedFile)) {
        console.log(`[DOWNLOAD_MP4] Direct download başarılı: ${videoId}`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
        return res.sendFile(downloadedFile);
      }
    } catch (directErr) {
      console.warn(`[DOWNLOAD_MP4] Direct download başarısız: ${directErr.message}`);
    }

    // 3. Eski yöntem fallback
    const ua = getRandomUA();
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    await randomJitter();
    const streamUrl = await queue.add(() =>
      deduplicatedResolve(videoId, "video", ua, countryClient)
    );

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);

    const response = await axios({
      method: "GET",
      url: streamUrl.toString().trim(),
      responseType: "stream",
      timeout: 60000,
      headers: {
        "User-Agent": ua,
        "Referer": "https://www.youtube.com/"
      }
    });

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);

  } catch (err) {
    logError("DOWNLOAD_MP4", req.query.videoId, err.message);
    console.error("MP4 ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "MP4 download failed" });
    } else {
      res.end();
    }
  }
});

// ---------------- DISK MANAGER (10GB Limit) ----------------
// Önbelleği (cache) yönetir, 10GB'ı aşarsa en eski dosyaları siler.
async function manageDiskSpace() {
  try {
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(CACHE_DIR)) return;

    const files = fs.readdirSync(CACHE_DIR);
    let totalSize = 0;
    const fileList = [];

    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
      fileList.push({ path: filePath, size: stats.size, atime: stats.atime });
    }

    const maxSizeBytes = MAX_CACHE_SIZE; // Merkezi limit kullan
    const targetSizeBytes = Math.floor(MAX_CACHE_SIZE * 0.8); // %80'e düşür

    if (totalSize > maxSizeBytes) {
      console.log(`[DISK_MANAGER] Limit asildi: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB. Temizlik basliyor...`);
      fileList.sort((a, b) => a.atime - b.atime);

      for (const fileObj of fileList) {
        if (totalSize <= targetSizeBytes) break;
        try {
          fs.unlinkSync(fileObj.path);
          totalSize -= fileObj.size;
          console.log(`[DISK_MANAGER] Silindi: ${path.basename(fileObj.path)}`);
        } catch (e) { }
      }
      console.log(`[DISK_MANAGER] Temizlik tamamlandi. Yeni boyut: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB.`);
    }
  } catch (err) {
    console.error("[DISK_MANAGER_ERR]", err.message);
  }
}

setInterval(manageDiskSpace, 15 * 60 * 1000); // 15 dk
setTimeout(manageDiskSpace, 5000);
