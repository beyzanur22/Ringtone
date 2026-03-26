require("dotenv").config();

const axios = require("axios");
const http = require("http");
const https = require("https");
const express = require("express");
const ytdlp_exec = require("yt-dlp-exec");
const ytdlp = ytdlp_exec.create('yt-dlp');
const cors = require("cors");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const Redis = require("ioredis");
// play-dl kaldırıldı — YouTube tarafından tamamen engellendi
const { Innertube, UniversalCache } = require("youtubei.js");
const path = require("path");

// ============================================================
// FIX COOKIES.TXT BOM FOR YT-DLP
// ============================================================
if (fs.existsSync("cookies.txt")) {
  try {
    let cookieContent = fs.readFileSync("cookies.txt", "utf8");
    if (cookieContent.charCodeAt(0) === 0xFEFF) {
      fs.writeFileSync("cookies.txt", cookieContent.slice(1), "utf8");
      console.log("[INIT] Removed UTF-8 BOM from cookies.txt");
    }
  } catch (err) {
    console.warn("Could not sanitize cookies.txt:", err.message);
  }
}

// ============================================================
// GLOBAL ERROR HANDLERS — sunucu asla crash olmasın
// ============================================================
process.on('unhandledRejection', (reason, promise) => {
  console.error('[GLOBAL] Yakalanmamış rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[GLOBAL] Yakalanmamış exception:', err.message);
});

const PQueue = require("p-queue").default;

// Queue — eşzamanlılık proxy sayısına göre ayarlanacak
let queue = new PQueue({
  concurrency: 3,
  interval: 1000,
  intervalCap: 4
});

// ============================================================
// PHASE 1: DISK CACHING
// ============================================================
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
const MAX_CACHE_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB limit
const downloadingFiles = new Set();

const MIN_AUDIO_SIZE = 50 * 1024;   // 50 KB altı bozuk
const MIN_VIDEO_SIZE = 500 * 1024;  // 500 KB altı bozuk

async function downloadToCache(videoId, type, streamUrl) {
  const ext = type === "audio" ? "m4a" : "mp4";
  const fileName = `${type}_${videoId}.${ext}`;
  const filePath = path.join(CACHE_DIR, fileName);
  const tempPath = filePath + ".tmp";

  if (fs.existsSync(filePath)) {
    const size = fs.statSync(filePath).size;
    const minSize = type === "audio" ? MIN_AUDIO_SIZE : MIN_VIDEO_SIZE;
    if (size >= minSize) return;
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

    const fileSize = fs.statSync(tempPath).size;
    const minSize = type === "audio" ? MIN_AUDIO_SIZE : MIN_VIDEO_SIZE;
    if (fileSize < minSize) {
      console.log(`[DISK_CACHE_ERR] ${fileName} çok küçük (${fileSize} bytes), siliniyor.`);
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

// Disk cache temizleyici — her saat
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
      console.log(`[DISK_MANAGER] Kapasite aşıldı: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB. Eski dosyalar siliniyor...`);
      fileStats.sort((a, b) => a.mtime - b.mtime);
      for (const fsObj of fileStats) {
        fs.unlinkSync(fsObj.path);
        totalSize -= fsObj.size;
        console.log(`[DISK_MANAGER] Silindi: ${path.basename(fsObj.path)}`);
        if (totalSize < MAX_CACHE_SIZE * 0.9) break;
      }
    }
  } catch (e) { }
}, 3600 * 1000);

// ============================================================
// ERROR LOGGING & CIRCUIT BREAKER
// ============================================================
function logError(type, videoId, errorMessage) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] - [${type}] - VideoID: ${videoId || "N/A"} - Error: ${errorMessage}\n`;
  console.error(logLine.trim());
  try {
    fs.appendFileSync(path.join(__dirname, "error.log"), logLine);
  } catch (e) { }
}

let ytDlpFailCount = 0;
let ytDlpCircuitBreakerUntil = 0;
const CIRCUIT_BREAKER_THRESHOLD = 8; // Daha yüksek eşik — proxy rotasyonu ile daha fazla şans
const CIRCUIT_BREAKER_TIMEOUT = 3 * 60 * 1000; // 3 dakika (eskisi 5'ti)
let youtubeApiStatus = "ok";

// Analytics
const stats = {
  ytDlpSuccess: 0,
  ytDlpFail: 0,
  innertubeSuccess: 0,
  innertubeFail: 0,
  cobaltSuccess: 0,
  cobaltFail: 0,
  invidiousSuccess: 0,
  invidiousFail: 0,
  proxyFallbackSuccess: 0,
  proxyFallbackFail: 0,
  youtubeApiQuotaExceeded: 0,
  rateLimitHits: 0,
  totalRequests: 0,
  cacheHits: 0
};

// ============================================================
// REDIS CACHE (fallback: in-memory)
// ============================================================
let redis = null;
const memoryCache = new Map();

try {
  redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => {
      if (times > 2) return null;
      return Math.min(times * 500, 2000);
    },
    lazyConnect: true,
    enableOfflineQueue: false
  });

  redis.on("error", (err) => {
    if (redis) {
      console.warn("[Redis] Bağlantı hatası, in-memory cache'e geçiliyor");
      try { redis.disconnect(); } catch (e) { }
      redis = null;
    }
  });

  redis.connect().then(() => {
    console.log("[Redis] Bağlantı başarılı");
  }).catch(() => {
    console.warn("[Redis] Bağlantı başarısız, in-memory cache aktif");
    try { if (redis) redis.disconnect(); } catch (e) { }
    redis = null;
  });
} catch (e) {
  console.warn("[Redis] Init hatası, in-memory cache aktif");
  redis = null;
}

async function cacheGet(key) {
  try {
    if (redis) {
      const val = await redis.get(key);
      return val ? JSON.parse(val) : null;
    }
  } catch (e) { }
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
  } catch (e) { }
  memoryCache.set(key, { data, expire: Date.now() + (ttlSeconds * 1000) });
}

// In-memory cache temizleyici (memory leak önleme)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of memoryCache) {
    if (now >= val.expire) memoryCache.delete(key);
  }
}, 5 * 60 * 1000);

// ============================================================
// USER AGENTS — 2026 güncel tarayıcı sürümleri
// ============================================================
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15"
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const randomJitter = async (min = 300, max = 1200) => {
  const ms = Math.floor(Math.random() * (max - min)) + min;
  await new Promise(resolve => setTimeout(resolve, ms));
};

// ============================================================
// YT-DLP CLIENT SIRALAMASI
// ============================================================
// web_creator ve mweb datacenter IP'lerde PoToken gerektirir
// tv_embedded ve android_vr PoToken GEREKTİRMEZ — önce bunları dene
const PLAYER_CLIENTS = ["tv_embedded", "android_vr", "ios", "web_creator", "mweb", "web"];

// ============================================================
// COOKIE YÖNETİMİ
// ============================================================
function parseCookiesToHeader(cookiePath) {
  try {
    const raw = fs.readFileSync(cookiePath, "utf8")
      .replace(/^\uFEFF/, "")
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

// ============================================================
// COBALT — Self-hosted instance birincil motor
// ============================================================
// Railway'de kendi Cobalt instance'ınızı deploy edin:
// https://railway.com/template/cobalt
// Sonra COBALT_API_URL env variable'ını ayarlayın
const SELF_HOSTED_COBALT = process.env.COBALT_API_URL || null;
let cobaltInstances = [];
const cobaltBlockedInstances = new Set(); // auth gerektiren veya bozuk instance'lar

// Self-hosted instance'ı her zaman ilk sıraya koy
if (SELF_HOSTED_COBALT) {
  cobaltInstances.unshift(SELF_HOSTED_COBALT);
  console.log(`[COBALT] Self-hosted instance: ${SELF_HOSTED_COBALT}`);
}

async function refreshCobaltInstances() {
  const discovered = [];
  
  // Kaynak 1: instances.cobalt.best (en güncel)
  try {
    const res = await axios.get("https://instances.cobalt.best/api/instances", { timeout: 10000 });
    const data = res.data;
    // Bu API bazen array, bazen {instances: []} döndürür
    const list = Array.isArray(data) ? data : (data?.instances || data?.data || []);
    for (const inst of list) {
      const apiUrl = inst.api_url || inst.api || inst.url;
      if (!apiUrl) continue;
      const url = apiUrl.startsWith('http') ? apiUrl : `https://${apiUrl}`;
      // Trailing slash temizle
      const clean = url.replace(/\/+$/, '');
      if (inst.api_online !== false && !cobaltBlockedInstances.has(clean)) {
        discovered.push(clean);
      }
    }
    if (discovered.length > 0) {
      console.log(`[COBALT] instances.cobalt.best'den ${discovered.length} instance bulundu`);
    }
  } catch (e) {
    console.warn(`[COBALT] instances.cobalt.best başarısız: ${e.message}`);
  }

  // Kaynak 2: Hardcoded güvenilir instance'lar
  const hardcoded = [
    "https://api.cobalt.tools",
    "https://cobalt-api.kwiatekmiki.com",
    "https://cobalt.canine.tools",
    "https://co.eepy.today"
  ];
  
  for (const h of hardcoded) {
    if (!discovered.includes(h) && !cobaltBlockedInstances.has(h)) {
      discovered.push(h);
    }
  }

  if (discovered.length > 0) {
    // Self-hosted varsa başa koy
    if (SELF_HOSTED_COBALT) {
      cobaltInstances = [SELF_HOSTED_COBALT, ...discovered.filter(d => d !== SELF_HOSTED_COBALT)];
    } else {
      cobaltInstances = discovered;
    }
    console.log(`[COBALT] Toplam ${cobaltInstances.length} aktif instance`);
  } else {
    console.warn("[COBALT] Hiç instance bulunamadı, mevcut liste korunuyor");
  }
}

async function resolveViaCobalt(videoId, type) {
  const isAudio = type === "audio";
  // Blocked olmayanları filtrele ve shuffle et
  const available = cobaltInstances.filter(i => !cobaltBlockedInstances.has(i));
  const shuffled = [...available].sort(() => Math.random() - 0.5);

  for (const instance of shuffled.slice(0, 6)) {
    try {
      const payload = {
        url: `https://www.youtube.com/watch?v=${videoId}`,
        downloadMode: isAudio ? "audio" : "auto",
        audioFormat: isAudio ? "best" : "mp3",
        youtubeVideoCodec: "h264",
        videoQuality: "720",
        youtubeHLS: false
      };

      const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": getRandomUA()
      };

      const res = await axios.post(`${instance}/`, payload, {
        headers,
        timeout: 20000,
        validateStatus: (s) => s < 500 // 4xx'leri de yakala
      });

      // Auth gerekli — bu instance'ı blokla
      if (res.status === 401 || res.status === 403) {
        const errCode = res.data?.error?.code || '';
        if (errCode.includes('auth') || res.status === 401) {
          console.warn(`[COBALT] ${instance} auth gerektiriyor, bloklandı`);
          cobaltBlockedInstances.add(instance);
          continue;
        }
      }

      // 400 hatası — payload sorunu olabilir, atla
      if (res.status === 400 || res.status === 405) {
        console.warn(`[COBALT] ${instance} → ${res.status}: ${JSON.stringify(res.data?.error || res.data).slice(0, 100)}`);
        continue;
      }

      // Başarılı response
      const data = res.data;
      if (data && (data.status === "tunnel" || data.status === "redirect" || data.status === "local-processing") && data.url) {
        console.log(`[COBALT] BAŞARILI ✓ instance=${instance} status=${data.status}`);
        stats.cobaltSuccess++;
        return data.url;
      }
      // Bazı eski instance'lar status olmadan url döndürür
      if (data && data.url && !data.error) {
        console.log(`[COBALT] BAŞARILI ✓ instance=${instance}`);
        stats.cobaltSuccess++;
        return data.url;
      }
      // Picker response (birden fazla format)
      if (data && data.status === "picker" && data.picker && data.picker.length > 0) {
        const pick = isAudio 
          ? data.picker.find(p => p.type === 'audio') || data.picker[0]
          : data.picker.find(p => p.type === 'video') || data.picker[0];
        if (pick && pick.url) {
          console.log(`[COBALT] BAŞARILI (picker) ✓ instance=${instance}`);
          stats.cobaltSuccess++;
          return pick.url;
        }
      }
    } catch (e) {
      const msg = e.response?.data?.error?.code || e.message || '';
      console.warn(`[COBALT] ${instance} başarısız:`, msg.slice(0, 120));
      // SSL hatası veya network hatası — geçici sorun, bloklama
      if (msg.includes('self-signed') || msg.includes('certificate')) {
        cobaltBlockedInstances.add(instance);
      }
    }
  }
  stats.cobaltFail++;
  return null;
}

// ============================================================
// RESIDENTIAL PROXY YÖNETİMİ + SAĞLIK KONTROLÜ
// ============================================================
let proxyList = [];
let healthyProxies = [];
const proxyHealth = new Map(); // proxy -> { fails: 0, lastFail: 0, cooldownUntil: 0 }

const PROXY_USER = process.env.PROXY_USER || "jtsuuwtv";
const PROXY_PASS = process.env.PROXY_PASS || "rk9mmw64wz5r";
const PROXY_COOLDOWN = 10 * 60 * 1000; // 10 dakika soğuma süresi

function loadProxies() {
  // Kaynak 1: proxies.txt dosyası
  try {
    if (fs.existsSync("proxies.txt")) {
      const data = fs.readFileSync("proxies.txt", "utf-8");
      const fileProxies = data.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 5 && !line.startsWith('#'));
      if (fileProxies.length > 0) {
        proxyList = fileProxies;
        console.log(`[PROXY_POOL] proxies.txt'den ${proxyList.length} proxy yüklendi`);
      }
    }
  } catch (e) {
    console.warn(`[PROXY_POOL] proxies.txt okunamadı: ${e.message}`);
  }

  // Kaynak 2: PROXY_LIST environment variable (virgülle ayrılmış)
  if (proxyList.length === 0 && process.env.PROXY_LIST) {
    proxyList = process.env.PROXY_LIST.split(',')
      .map(p => p.trim())
      .filter(p => p.length > 5);
    console.log(`[PROXY_POOL] PROXY_LIST env'den ${proxyList.length} proxy yüklendi`);
  }

  // Kaynak 3: Tek PROXY_URL environment variable
  if (proxyList.length === 0 && process.env.PROXY_URL) {
    proxyList.push(process.env.PROXY_URL);
    console.log(`[PROXY_POOL] PROXY_URL env'den fallback proxy ayarlandı`);
  }

  if (proxyList.length === 0) {
    console.warn(`[PROXY_POOL] Hiç proxy bulunamadı — otomatik keşif denenecek`);
  }

  // Health map başlat
  healthyProxies = [...proxyList];
  proxyList.forEach(p => {
    if (!proxyHealth.has(p)) {
      proxyHealth.set(p, { fails: 0, lastFail: 0, cooldownUntil: 0 });
    }
  });
}
loadProxies();

// Otomatik ücretsiz proxy keşfi
async function autoFetchProxies() {
  if (proxyList.length >= 3) return; // Yeterli proxy varsa atla
  
  const { SocksProxyAgent } = await import('socks-proxy-agent');
  
  const sources = [
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt",
    "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt",
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt"
  ];
  
  const discovered = [];
  
  for (const source of sources) {
    try {
      const res = await axios.get(source, { timeout: 8000 });
      const lines = res.data.split('\n')
        .map(l => l.trim())
        .filter(l => l.match(/^\d+\.\d+\.\d+\.\d+:\d+$/));
      
      // Rastgele 15 tane seç (çok hızlı banlanabilirler)
      const shuffled = lines.sort(() => Math.random() - 0.5).slice(0, 15);
      
      for (const proxy of shuffled) {
        try {
          const proxyUrl = `socks5://${proxy}`;
          const httpsAgent = new SocksProxyAgent(proxyUrl);
          
          // Hızlı ping testi — YouTube'a bağlanabiliyor mu?
          const check = await axios.get("https://www.youtube.com/", {
            httpsAgent,
            timeout: 5000,
            validateStatus: () => true,
            headers: { 'User-Agent': getRandomUA() }
          });
          
          if (check.status === 200 || check.status === 302) {
            discovered.push(proxyUrl);
            if (discovered.length >= 3) break; // 3 çalışan proxy yeterli
          }
        } catch (e) {
          // Bu proxy çalışmıyor, sonrakini dene
        }
      }
      
      if (discovered.length >= 3) break;
    } catch (e) {
      // Bu kaynak başarısız, sonrakini dene
    }
  }
  
  if (discovered.length > 0) {
    for (const p of discovered) {
      if (!proxyList.includes(p)) {
        proxyList.push(p);
        proxyHealth.set(p, { fails: 0, lastFail: 0, cooldownUntil: 0 });
      }
    }
    healthyProxies = [...proxyList];
    console.log(`[PROXY_POOL] Otomatik keşif: ${discovered.length} SOCKS5 proxy eklendi (toplam: ${proxyList.length})`);
  } else {
    console.warn(`[PROXY_POOL] Otomatik keşif başarısız — proxy'siz devam ediliyor`);
  }
}
// İlk yüklemede proxy yoksa otomatik keşfet
if (proxyList.length === 0) {
  autoFetchProxies().catch(() => {});
}
// Her 20 dakikada proxy havuzunu yenile
setInterval(() => {
  if (proxyList.length < 3) autoFetchProxies().catch(() => {});
}, 20 * 60 * 1000);

function formatProxyUrl(target) {
  if (target.startsWith('http')) return target;
  return `http://${PROXY_USER}:${PROXY_PASS}@${target}`;
}

function getRandomProxyUrl() {
  const now = Date.now();
  
  // Cooldown'u geçmiş proxy'leri tekrar aktifleştir
  healthyProxies = proxyList.filter(p => {
    const h = proxyHealth.get(p);
    if (!h) return true;
    if (h.cooldownUntil > now) return false; // Hâlâ soğuyor
    if (h.fails >= 5) {
      // Soğuma bitti, sıfırla
      h.fails = 0;
      h.cooldownUntil = 0;
    }
    return true;
  });

  if (healthyProxies.length === 0) {
    // Tüm proxy'ler soğuyor, env'deki fallback'i dene
    return process.env.PROXY_URL || null;
  }

  const target = healthyProxies[Math.floor(Math.random() * healthyProxies.length)];
  return formatProxyUrl(target);
}

function markProxyFailed(proxyUrl) {
  if (!proxyUrl) return;
  // proxyUrl'den IP:port çıkar
  const match = proxyUrl.match(/@(.+)$/);
  const key = match ? match[1] : proxyUrl;
  
  const target = proxyList.find(p => key.includes(p) || proxyUrl.includes(p));
  if (!target) return;

  const h = proxyHealth.get(target) || { fails: 0, lastFail: 0, cooldownUntil: 0 };
  h.fails++;
  h.lastFail = Date.now();
  
  if (h.fails >= 3) {
    h.cooldownUntil = Date.now() + PROXY_COOLDOWN;
    console.log(`[PROXY_HEALTH] ${target} → ${h.fails} başarısız, 10dk soğumaya alındı`);
  }
  
  proxyHealth.set(target, h);
}

function markProxySuccess(proxyUrl) {
  if (!proxyUrl) return;
  const match = proxyUrl.match(/@(.+)$/);
  const key = match ? match[1] : proxyUrl;
  
  const target = proxyList.find(p => key.includes(p) || proxyUrl.includes(p));
  if (!target) return;

  proxyHealth.set(target, { fails: 0, lastFail: 0, cooldownUntil: 0 });
}

// Proxy sağlık istatistiklerini logla
setInterval(() => {
  const now = Date.now();
  const active = proxyList.filter(p => {
    const h = proxyHealth.get(p);
    return !h || h.cooldownUntil <= now;
  });
  console.log(`[PROXY_HEALTH] Aktif: ${active.length}/${proxyList.length}`);
}, 5 * 60 * 1000);

// ============================================================
// INVIDIOUS / PIPED FALLBACK
// ============================================================
let invidiousInstances = [];
let pipedInstances = [];

async function refreshAlternativeInstances() {
  // Invidious instances — health filtresini düşür, daha fazla instance bul
  try {
    const inv = await axios.get("https://api.invidious.io/instances.json?sort_by=health", { timeout: 10000 });
    invidiousInstances = inv.data
      .filter(i => i[1] && i[1].type === "https")
      .map(i => i[1].uri)
      .filter(Boolean)
      .slice(0, 20);
    console.log(`[INVIDIOUS] ${invidiousInstances.length} instance bulundu`);
  } catch (e) {
    console.warn("[INVIDIOUS] Instance listesi alınamadı:", e.message);
    // Hardcoded fallback instances
    if (invidiousInstances.length === 0) {
      invidiousInstances = [
        "https://yewtu.be",
        "https://vid.puffyan.us",
        "https://invidious.snopyta.org",
        "https://inv.nadeko.net",
        "https://invidious.nerdvpn.de"
      ];
      console.log(`[INVIDIOUS] Hardcoded ${invidiousInstances.length} instance kullanılıyor`);
    }
  }

  // Piped instances
  try {
    const piped = await axios.get("https://piped-instances.kavin.rocks/", { timeout: 10000 });
    if (piped.data && Array.isArray(piped.data)) {
      pipedInstances = piped.data
        .filter(i => i.api_url)
        .map(i => i.api_url)
        .slice(0, 15);
    }
    console.log(`[PIPED] ${pipedInstances.length} instance bulundu`);
  } catch (e) {
    console.warn("[PIPED] Instance listesi alınamadı:", e.message);
    // Hardcoded fallback
    if (pipedInstances.length === 0) {
      pipedInstances = [
        "https://pipedapi.kavin.rocks",
        "https://pipedapi.tokhmi.xyz",
        "https://pipedapi.moomoo.me",
        "https://pipedapi.syncpundit.io"
      ];
      console.log(`[PIPED] Hardcoded ${pipedInstances.length} instance kullanılıyor`);
    }
  }
}

async function resolveViaInvidious(videoId, type) {
  const isAudio = type === "audio";
  
  // Shuffle instances
  const shuffled = [...invidiousInstances].sort(() => Math.random() - 0.5);
  
  for (const instance of shuffled.slice(0, 7)) {
    try {
      // Yöntem 1: Proxy/tunnel URL kullan (doğrudan YouTube URL'si yerine)
      // Bu URL instance üzerinden proxy yapılır — YouTube IP engellemesi bypass edilir
      const itag = isAudio ? "140" : "18"; // 140=m4a audio, 18=mp4 360p
      const proxyUrl = `${instance}/latest_version?id=${videoId}&itag=${itag}&local=true`;
      
      // Önce URL'nin çalışıp çalışmadığını HEAD ile kontrol et
      try {
        const headResp = await axios.head(proxyUrl, {
          timeout: 8000,
          headers: { 'User-Agent': getRandomUA() },
          maxRedirects: 3,
          validateStatus: (s) => s < 400
        });
        
        if (headResp.status === 200 || headResp.status === 206 || headResp.status === 302) {
          console.log(`[INVIDIOUS] BAŞARILI (proxy URL) ✓ ${instance}`);
          stats.invidiousSuccess++;
          return proxyUrl;
        }
      } catch (headErr) {
        // HEAD başarısız — API yöntemini dene
      }

      // Yöntem 2: API'den format listesi al, ama yine proxy URL oluştur
      const resp = await axios.get(`${instance}/api/v1/videos/${videoId}`, {
        timeout: 10000,
        headers: { 'User-Agent': getRandomUA() }
      });
      
      const formats = resp.data.adaptiveFormats || [];
      let chosen;
      
      if (isAudio) {
        chosen = formats
          .filter(f => f.type && f.type.startsWith("audio"))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      } else {
        chosen = formats
          .filter(f => f.type && f.type.includes("video/mp4"))
          .sort((a, b) => (b.height || 0) - (a.height || 0))
          .find(f => (f.height || 0) <= 720) || formats[0];
      }
      
      if (chosen) {
        // Ham YouTube URL'si yerine instance proxy URL'si kullan
        const chosenItag = chosen.itag || itag;
        const tunnelUrl = `${instance}/latest_version?id=${videoId}&itag=${chosenItag}&local=true`;
        console.log(`[INVIDIOUS] BAŞARILI (API→proxy) ✓ ${instance} → itag=${chosenItag}`);
        stats.invidiousSuccess++;
        return tunnelUrl;
      }
    } catch (e) {
      console.warn(`[INVIDIOUS] ${instance} başarısız:`, e.message?.slice(0, 120));
    }
  }
  
  stats.invidiousFail++;
  return null;
}

async function resolveViaPiped(videoId, type) {
  const isAudio = type === "audio";
  const shuffled = [...pipedInstances].sort(() => Math.random() - 0.5);
  
  for (const instance of shuffled.slice(0, 5)) {
    try {
      const resp = await axios.get(`${instance}/streams/${videoId}`, {
        timeout: 8000,
        headers: { 'User-Agent': getRandomUA() }
      });
      
      const streams = isAudio ? (resp.data.audioStreams || []) : (resp.data.videoStreams || []);
      let chosen;
      
      if (isAudio) {
        chosen = streams
          .filter(s => s.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      } else {
        chosen = streams
          .filter(s => s.url && s.videoOnly === false)
          .sort((a, b) => (b.height || 0) - (a.height || 0))
          .find(s => (s.height || 0) <= 720) || streams.find(s => s.url);
      }
      
      if (chosen && chosen.url) {
        console.log(`[PIPED] BAŞARILI: ${instance}`);
        return chosen.url;
      }
    } catch (e) {
      console.warn(`[PIPED] ${instance} başarısız:`, e.message?.slice(0, 120));
    }
  }
  
  return null;
}

// ============================================================
// YOUTUBEI.JS — OAuth ile başlat
// ============================================================
let ytInnertube = null;

async function initInnertube() {
  try {
    ytInnertube = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true
    });

    // OAuth ile giriş yap — TV_EMBEDDED yerine tam yetki
    if (fs.existsSync('oauth_credentials.json')) {
      try {
        const creds = JSON.parse(fs.readFileSync('oauth_credentials.json', 'utf8'));
        await ytInnertube.session.signIn(creds);
        
        // Token yenilendiğinde kaydet
        ytInnertube.session.on('update-credentials', (newCreds) => {
          try {
            fs.writeFileSync('oauth_credentials.json', JSON.stringify(newCreds));
            console.log("[youtubei.js] OAuth token yenilendi ve kaydedildi");
          } catch (e) { }
        });
        
        console.log("[youtubei.js] OAuth ile başarıyla giriş yapıldı ✓");
      } catch (oauthErr) {
        console.warn("[youtubei.js] OAuth girişi başarısız:", oauthErr.message);
        console.warn("[youtubei.js] Anonim modda devam ediliyor");
      }
    } else {
      console.warn("[youtubei.js] oauth_credentials.json bulunamadı, anonim modda başlatılıyor");
    }
  } catch (err) {
    console.error("[youtubei.js] Başlatma hatası:", err.message);
  }
}
initInnertube();

// ============================================================
// ANA STREAM URL ÇÖZÜCÜ — Proxy tabanlı motorlar önce
// ============================================================
// SİRALAMA: Invidious proxy → Piped → Cobalt → youtubei.js → yt-dlp
// En az fark edilebilir yöntemler başa, en riskli sona
async function resolveStreamUrl(videoUrl, format, ua, countryClient = null) {
  const videoIdMatch = videoUrl.match(/v=([^&]+)/);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;
  const type = format.includes("audio") || format === "bestaudio" ? "audio" : "video";
  let lastError = null;

  if (!videoId) {
    throw new Error("Video ID bulunamadı");
  }

  // ============ 1. ADIM: INVIDIOUS PROXY URL ============
  // (IPTAL EDILDI: Cihaza sadece 2KB hata HTML'i indirttiği için kaldırıldı)

  // ============ 2. ADIM: PIPED ============
  // Piped de proxy yapıyor — güvenli
  try {
    console.log(`[ADIM-2] Piped deneniyor...`);
    const pipedUrl = await resolveViaPiped(videoId, type);
    if (pipedUrl) {
      console.log(`[RESOLVE] ✓ Piped ile çözüldü`);
      return pipedUrl;
    }
  } catch (e) {
    console.warn(`[ADIM-2] Piped hatası:`, e.message?.slice(0, 100));
    lastError = e;
  }

  // ============ 3. ADIM: COBALT API ============
  // Bağımsız altyapı — kendi PoToken üretiyor
  try {
    console.log(`[ADIM-3] Cobalt deneniyor...`);
    const cobaltUrl = await resolveViaCobalt(videoId, type);
    if (cobaltUrl) {
      console.log(`[RESOLVE] ✓ Cobalt ile çözüldü`);
      return cobaltUrl;
    }
  } catch (e) {
    console.warn(`[ADIM-3] Cobalt hatası:`, e.message?.slice(0, 100));
    lastError = e;
  }

  // ============ 4. ADIM: YOUTUBEI.JS ============
  // Doğrudan YouTube API — bot algılanma riski orta
  if (ytInnertube) {
    try {
      console.log(`[ADIM-4] youtubei.js deneniyor...`);
      const info = await ytInnertube.getBasicInfo(videoId);

      const isAudio = format.includes("audio") || format === "bestaudio";
      let pbFormat;
      
      try {
        pbFormat = isAudio
          ? info.chooseFormat({ type: 'audio', quality: 'best' })
          : info.chooseFormat({ type: 'video+audio', quality: '360p' });
      } catch (fmtErr) {
        console.warn(`[youtubei.js] Format seçim hatası: ${fmtErr.message}`);
      }

      if (pbFormat) {
        let url = null;
        
        if (pbFormat.decipher) {
          url = pbFormat.decipher(ytInnertube.session.player);
        } else if (pbFormat.url) {
          url = pbFormat.url;
        }
        
        if (url) {
          console.log(`[RESOLVE] ✓ youtubei.js ile çözüldü — format=${pbFormat.mime_type}`);
          stats.innertubeSuccess++;
          return url;
        }
      }
    } catch (innertubeErr) {
      console.warn(`[ADIM-4] youtubei.js başarısız:`, innertubeErr.message?.slice(0, 150));
      stats.innertubeFail++;
      lastError = innertubeErr;
      
      // Session bozulmuşsa yeniden başlat
      if (innertubeErr.message?.includes('Streaming data not available') || 
          innertubeErr.message?.includes('sign in')) {
        console.log(`[youtubei.js] Session yeniden başlatılıyor...`);
        initInnertube().catch(() => {});
      }
    }
  }

  // ============ 5. ADIM: YT-DLP (SON ÇARE) ============
  // En yüksek ban riski — sadece diğerleri başarısız olduysa
  // Sadece 2 güvenli client dene (tümünü deneme, dikkat çeker)
  if (Date.now() >= ytDlpCircuitBreakerUntil) {
    const safeClients = ["ios", "tv_embedded", "android"]; // ios ve tv_embedded PoToken ile en iyi ikili
    
    for (const client of safeClients) {
      let usedProxy = null;
      try {
        // PoToken server'ın ısınması için küçük bir jitter/gecikme artırıldı
        await randomJitter(1000, 3000); 

        const opts = {
          format: "bestaudio/best",
          getUrl: true,
          noCheckCertificates: true,
          noWarnings: true,
          preferFreeFormats: false,
          addHeader: [
            "referer:https://www.youtube.com/",
            `user-agent:${ua}`
          ]
        };

        // Cookies
        const useCookies = process.env.USE_COOKIES !== "false";
        if (useCookies && fs.existsSync("cookies.txt")) {
          opts.cookies = "cookies.txt";
        }

        // Proxy rotasyonu
        usedProxy = getRandomProxyUrl();
        if (usedProxy) {
          opts.proxy = usedProxy;
          const proxyDisplay = usedProxy.split('@')[1] || 'env_proxy';
          console.log(`[yt-dlp] Proxy: ${proxyDisplay}`);
        }

        // PoToken Server explicitly passed to extractor
        // Not: Bazı sürümlerde yt_pot_server, bazılarında pot_token_server kullanılır
        opts.extractorArgs = `youtube:player_client=${client};pot_token_server=http://localhost:4416`;

        console.log(`[ADIM-5] yt-dlp: client=${client}`);
        const result = await ytdlp(videoUrl, opts);
        const url = result.toString().trim().split('\n')[0];

        if (url && url.startsWith("http")) {
          console.log(`[RESOLVE] ✓ yt-dlp ile çözüldü — client=${client}`);
          ytDlpFailCount = 0;
          stats.ytDlpSuccess++;
          if (usedProxy) markProxySuccess(usedProxy);
          return url;
        }
      } catch (err) {
        const errMsg = err.stderr?.slice(0, 150) || err.message?.slice(0, 150);
        console.warn(`[yt-dlp] client=${client} başarısız:`, errMsg);
        lastError = err;
        
        if (usedProxy && (errMsg?.includes('bot') || errMsg?.includes('Sign in') || errMsg?.includes('proxy') || errMsg?.includes('timeout'))) {
          markProxyFailed(usedProxy);
        }
      }
    }

    ytDlpFailCount++;
    stats.ytDlpFail++;
    if (ytDlpFailCount >= CIRCUIT_BREAKER_THRESHOLD) {
      ytDlpCircuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_TIMEOUT;
      console.error(`[CIRCUIT_BREAKER] yt-dlp ${CIRCUIT_BREAKER_TIMEOUT/1000}sn devre dışı`);
    }
  } else {
    console.warn(`[yt-dlp] Circuit breaker aktif, atlanıyor.`);
  }

  throw lastError || new Error("Tüm motorlar başarısız oldu (Invidious, Piped, Cobalt, youtubei.js, yt-dlp)");
}

async function resolveStreamUrlWithFallback(videoId, type, ua, countryClient) {
  const format = type === "audio" ? "bestaudio/best" : "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best";
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  return await resolveStreamUrl(url, format, ua, countryClient);
}

// ============================================================
// İSTEK BİRLEŞTİRME (DEDUPLICATION)
// Aynı anda 50 kişi aynı şarkıyı isterse bile YouTube'a 1 istek gider
// ============================================================
const pendingResolves = new Map();

async function resolveWithDedup(videoId, type, ua, countryClient) {
  const key = `${videoId}:${type}`;
  
  // Zaten çözümleniyor mu?
  if (pendingResolves.has(key)) {
    console.log(`[DEDUP] ${videoId} zaten çözümleniyor, bekleniyor...`);
    return pendingResolves.get(key);
  }
  
  const promise = resolveStreamUrlWithFallback(videoId, type, ua, countryClient)
    .finally(() => {
      pendingResolves.delete(key);
    });
  
  pendingResolves.set(key, promise);
  return promise;
}

// ============================================================
// PIPED/INVIDIOUS SEARCH FALLBACK (YouTube API quota için)
// ============================================================
async function fetchFromPiped(path) {
  const shuffled = [...pipedInstances].sort(() => Math.random() - 0.5);
  for (const inst of shuffled.slice(0, 5)) {
    try {
      const resp = await axios.get(`${inst}${path}`, { timeout: 8000 });
      return resp;
    } catch (e) { /* sonraki instance'ı dene */ }
  }
  throw new Error("Hiçbir Piped instance yanıt vermedi");
}

// ============================================================
// EXPRESS APP
// ============================================================
const axiosClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true })
});

const app = express();
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  stats.totalRequests++;
  const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
  console.log(`[REQ] ${new Date().toISOString()} | ${req.method} ${req.originalUrl} | IP: ${req.ip} | Country: ${country}`);
  next();
});

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
app.use((req, res, next) => {
  const appKey = req.headers['x-app-key'];
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

// ============================================================
// CONFIG & FILES
// ============================================================
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

// ============================================================
// RATE LIMITS
// ============================================================
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 40'tan 60'a çıkarıldı — çok kullanıcı desteği
  handler: (req, res, next, options) => {
    stats.rateLimitHits++;
    logError("RATE_LIMIT", null, `IP ${req.ip} rate limit aştı (Global)`);
    res.status(options.statusCode).send(options.message);
  }
}));

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  handler: (req, res, next, options) => {
    stats.rateLimitHits++;
    logError("RATE_LIMIT", null, `IP ${req.ip} rate limit aştı (Search)`);
    res.status(options.statusCode).send(options.message);
  }
});

// ============================================================
// YOUTUBE API SETUP
// ============================================================
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CACHE_DURATION = 60 * 60;
const STREAM_CACHE_DURATION = 5 * 60 * 60; // 5 saat (YouTube URL'leri ~6 saat geçerli)
const SEARCH_CACHE_DURATION = parseInt(process.env.SEARCH_CACHE_TTL || "3600");

// ============================================================
// BLOCKED CHANNELS
// ============================================================
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
  } catch (e) { }
  return "default";
}

// ============================================================
// ENDPOINTS
// ============================================================

// HEALTH
app.get("/health", (req, res) => {
  const now = Date.now();
  const activeProxies = proxyList.filter(p => {
    const h = proxyHealth.get(p);
    return !h || h.cooldownUntil <= now;
  });
  
  res.json({
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    memoryRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    redis: redis ? "connected" : "disconnected",
    ytDlp: Date.now() < ytDlpCircuitBreakerUntil ? "circuit_breaker_open" : "ok",
    youtubeApi: youtubeApiStatus,
    innertubeOAuth: ytInnertube ? "active" : "inactive",
    proxies: {
      total: proxyList.length,
      active: activeProxies.length,
      cooling: proxyList.length - activeProxies.length
    },
    fallbackInstances: {
      cobalt: cobaltInstances.length,
      invidious: invidiousInstances.length,
      piped: pipedInstances.length
    },
    stats: stats
  });
});

// ADMIN STATS
app.get("/admin/stats", (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    stats: stats
  });
});

// CONFIG
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
        logError("API_FALLBACK", null, "YouTube API Quota exceeded. Using Piped fallback.");
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
        logError("API_FALLBACK", null, `YouTube API Quota exceeded. Piped fallback: ${query}`);
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
        nextToken = "";
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
    res.status(500).json({ error: "Search failed" });
  }
});

// ============================================================
// STREAM (Audio) — 4 katmanlı fallback
// ============================================================
app.get("/stream", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    // 1. Disk cache kontrolü
    const localFile = path.join(CACHE_DIR, `audio_${videoId}.m4a`);
    if (fs.existsSync(localFile) && fs.statSync(localFile).size >= MIN_AUDIO_SIZE) {
      console.log(`[DISK_CACHE_HIT] audio ${videoId}`);
      stats.cacheHits++;
      
      if (req.path.includes("download")) {
        res.setHeader("Content-Disposition", `attachment; filename=audio_${videoId}.m4a`);
      }
      return res.sendFile(localFile);
    }

    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    // 2. Redis/memory cache kontrolü
    const cacheKey = `stream:audio:${videoId}`;
    const cachedData = await cacheGet(cacheKey);
    let streamUrl, ua;

    if (cachedData && cachedData.url) {
      streamUrl = cachedData.url;
      ua = cachedData.ua || getRandomUA();
      console.log("AUDIO CACHE HIT:", videoId);
      stats.cacheHits++;
    } else {
      ua = getRandomUA();
      streamUrl = await queue.add(async () => {
        await randomJitter();
        return resolveWithDedup(videoId, "audio", ua, countryClient);
      });
      await cacheSet(cacheKey, { url: streamUrl, ua }, STREAM_CACHE_DURATION);
      console.log("AUDIO RESOLVED:", videoId);
    }

    // 3. Stream'i proxy yap
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
        timeout: 30000,
        validateStatus: (status) => status < 400
      });
    } catch (fetchErr) {
      // Cache URL expire olmuş — temizle ve tekrar dene
      if (fetchErr.response && (fetchErr.response.status === 403 || fetchErr.response.status === 410)) {
        console.warn(`[STREAM] Cache URL expired, yeniden çözümleniyor: ${videoId}`);
        if (redis) redis.del(cacheKey);
        memoryCache.delete(cacheKey);
        
        // Tekrar çözümle
        ua = getRandomUA();
        streamUrl = await queue.add(async () => {
          await randomJitter();
          return resolveWithDedup(videoId, "audio", ua, countryClient);
        });
        await cacheSet(cacheKey, { url: streamUrl, ua }, STREAM_CACHE_DURATION);
        
        const retryHeaders = {
          "User-Agent": ua,
          "Referer": "https://www.youtube.com/"
        };
        if (req.headers.range) retryHeaders["Range"] = req.headers.range;
        
        response = await axiosClient({
          method: "GET",
          url: streamUrl,
          responseType: "stream",
          headers: retryHeaders,
          timeout: 30000,
          validateStatus: (status) => status < 400
        });
      } else {
        throw fetchErr;
      }
    }

    res.status(response.status);
    if (response.headers["content-type"]) res.setHeader("Content-Type", response.headers["content-type"]);
    if (response.headers["content-length"]) res.setHeader("Content-Length", response.headers["content-length"]);
    if (response.headers["content-range"]) res.setHeader("Content-Range", response.headers["content-range"]);
    if (response.headers["accept-ranges"]) res.setHeader("Accept-Ranges", response.headers["accept-ranges"]);

    response.data.pipe(res);

    // Arka planda disk cache'e kaydet
    downloadToCache(videoId, "audio", streamUrl).catch(() => { });
    
  } catch (err) {
    logError("STREAM", req.query.videoId, err.message);
    console.error("STREAM ERROR:", err.message);
    res.status(500).json({
      error: "Streaming failed",
      message: err.message
    });
  }
});

// ============================================================
// STREAM VIDEO (MP4)
// ============================================================
app.get("/stream/video", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const localFile = path.join(CACHE_DIR, `video_${videoId}.mp4`);

    // 1. Disk cache
    if (fs.existsSync(localFile) && fs.statSync(localFile).size > MIN_VIDEO_SIZE) {
      console.log(`[DISK_CACHE_HIT] video ${videoId}`);
      stats.cacheHits++;
      const stat = fs.statSync(localFile);
      const fileSize = stat.size;

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

    // Bozuk dosya temizle
    if (fs.existsSync(localFile)) {
      fs.unlinkSync(localFile);
    }

    // 2. Stream URL çöz
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);
    const ua = getRandomUA();

    let streamUrl;
    try {
      streamUrl = await queue.add(async () => {
        await randomJitter();
        return resolveWithDedup(videoId, "video", ua, countryClient);
      });
    } catch (resolveErr) {
      console.error(`[STREAM_VIDEO] URL resolve başarısız: ${resolveErr.message}`);

      // yt-dlp ile doğrudan indirme fallback
      const tempFile = localFile + ".tmp";
      const opts = {
        format: 'best[ext=mp4]/best',
        output: tempFile,
        noCheckCertificates: true,
        addHeader: [
          'referer:https://www.youtube.com/',
          `user-agent:${ua}`
        ]
      };
      if (process.env.USE_COOKIES !== "false" && fs.existsSync("cookies.txt")) {
        opts.cookies = "cookies.txt";
      }

      const activeProxy = getRandomProxyUrl();
      if (activeProxy) opts.proxy = activeProxy;

      await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, opts);

      if (!fs.existsSync(tempFile) || fs.statSync(tempFile).size < MIN_VIDEO_SIZE) {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        throw new Error("yt-dlp bozuk/boş dosya indirdi");
      }

      fs.renameSync(tempFile, localFile);
      console.log(`[yt-dlp] Video kaydedildi: video_${videoId}.mp4`);
      res.setHeader("Content-Type", "video/mp4");
      return res.sendFile(localFile);
    }

    // 3. Stream proxy
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
      timeout: 60000,
      validateStatus: (status) => status < 400
    });

    res.status(response.status);
    if (response.headers["content-type"]) res.setHeader("Content-Type", response.headers["content-type"]);
    if (response.headers["content-length"]) res.setHeader("Content-Length", response.headers["content-length"]);
    if (response.headers["content-range"]) res.setHeader("Content-Range", response.headers["content-range"]);
    if (response.headers["accept-ranges"]) res.setHeader("Accept-Ranges", response.headers["accept-ranges"]);
    response.data.pipe(res);

    downloadToCache(videoId, "video", streamUrl).catch(() => { });

  } catch (err) {
    logError("STREAM_VIDEO", req.query.videoId, err.message);
    console.error("VIDEO STREAM ERROR:", err.message);
    res.status(500).json({ error: "Video streaming failed" });
  }
});

// ============================================================
// DOWNLOAD MP3 (Audio)
// ============================================================
app.get("/download/mp3", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: "videoId required" });

    const localFile = path.join(CACHE_DIR, `audio_${videoId}.m4a`);

    if (fs.existsSync(localFile) && fs.statSync(localFile).size >= MIN_AUDIO_SIZE) {
      console.log(`[DISK_CACHE_HIT] download audio ${videoId}`);
      stats.cacheHits++;
      res.setHeader("Content-Disposition", `attachment; filename=audio_${videoId}.m4a`);
      return res.sendFile(localFile);
    }

    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Content-Disposition", `attachment; filename=audio_${videoId}.m4a`);

    const ua = getRandomUA();
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    const streamUrl = await queue.add(async () => {
      await randomJitter();
      return resolveWithDedup(videoId, "audio", ua, countryClient);
    });

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }

    const response = await axios({
      method: "GET",
      url: streamUrl.toString().trim(),
      responseType: "stream",
      timeout: 30000,
      headers: {
        "User-Agent": ua,
        "Referer": "https://www.youtube.com/"
      }
    });

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);
    downloadToCache(videoId, "audio", streamUrl).catch(() => { });

  } catch (err) {
    logError("DOWNLOAD_MP3", req.query.videoId, err.message);
    res.status(500).json({ error: "Audio download failed" });
  }
});

// ============================================================
// DOWNLOAD MP4 (Video)
// ============================================================
app.get("/download/mp4", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: "videoId required" });

    const localFile = path.join(CACHE_DIR, `video_${videoId}.mp4`);

    if (fs.existsSync(localFile) && fs.statSync(localFile).size >= MIN_VIDEO_SIZE) {
      console.log(`[DISK_CACHE_HIT] download video ${videoId}`);
      stats.cacheHits++;
      res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
      return res.sendFile(localFile);
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);

    const ua = getRandomUA();
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    const streamUrl = await queue.add(async () => {
      await randomJitter();
      return resolveWithDedup(videoId, "video", ua, countryClient);
    });

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }

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
    downloadToCache(videoId, "video", streamUrl).catch(() => { });

  } catch (err) {
    logError("DOWNLOAD_MP4", req.query.videoId, err.message);
    res.status(500).json({ error: "MP4 download failed" });
  }
});

// ============================================================
// WARMUP & START
// ============================================================
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
    console.log("Top50 cache hazır ✓");
    return items;
  } catch (e) {
    console.log("Warmup başarısız:", e.message);
    return [];
  }
}

// Top50 şarkıları arka planda disk cache'e indir
async function preDownloadTop50(items) {
  if (!items || items.length === 0) return;
  
  console.log(`[PRE-CACHE] Top ${Math.min(items.length, 20)} şarkı arka planda indiriliyor...`);
  
  // İlk 20 şarkıyı indir (tümünü değil, bant genişliği için)
  const topItems = items.slice(0, 20);
  let downloaded = 0;
  
  for (const item of topItems) {
    const videoId = typeof item.id === 'string' ? item.id : item.id?.videoId;
    if (!videoId) continue;
    
    const localFile = path.join(CACHE_DIR, `audio_${videoId}.m4a`);
    if (fs.existsSync(localFile) && fs.statSync(localFile).size >= MIN_AUDIO_SIZE) {
      continue; // Zaten cache'de
    }
    
    try {
      const ua = getRandomUA();
      await randomJitter(1000, 3000); // Pre-cache yavaş yapsın, dikkat çekmesin
      const streamUrl = await resolveWithDedup(videoId, "audio", ua, "default");
      if (streamUrl) {
        await downloadToCache(videoId, "audio", streamUrl);
        downloaded++;
      }
    } catch (e) {
      // Sessiz devam — warmup hata verirse önemli değil
    }
    
    // Her 5 indirmede bir durakla
    if (downloaded > 0 && downloaded % 5 === 0) {
      await randomJitter(3000, 6000);
    }
  }
  
  console.log(`[PRE-CACHE] ${downloaded} şarkı arka planda cache'e indirildi ✓`);
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", async () => {
  console.log("=".repeat(50));
  console.log(`🎵 Ringtone Backend v3.0 (PoToken) — Port ${PORT}`);
  console.log(`Redis: ${redis ? "bağlı ✓" : "in-memory fallback"}`);
  console.log(`Proxy Pool: ${proxyList.length} adet`);
  console.log(`OAuth: ${fs.existsSync('oauth_credentials.json') ? 'mevcut ✓' : 'yok ✗'}`);
  console.log(`Cookies: ${fs.existsSync('cookies.txt') ? 'mevcut ✓' : 'yok ✗'}`);
  console.log("=".repeat(50));
  
  // Paralel warmup
  const [top50Result] = await Promise.allSettled([
    warmTop50(),
    refreshAlternativeInstances(),
    refreshCobaltInstances()
  ]);
  
  // Top50 şarkıları arka planda indir (sunucuyu bloklamaz)
  const top50Items = top50Result.status === 'fulfilled' ? top50Result.value : [];
  if (top50Items && top50Items.length > 0) {
    preDownloadTop50(top50Items).catch(() => {});
  }
  
  // Invidious/Piped/Cobalt instance listesini her 6 saatte yenile
  setInterval(refreshAlternativeInstances, 6 * 60 * 60 * 1000);
  setInterval(refreshCobaltInstances, 6 * 60 * 60 * 1000);
  
  // Top50'yi her 12 saatte bir pre-cache'e al
  setInterval(async () => {
    const items = await warmTop50();
    if (items && items.length > 0) preDownloadTop50(items).catch(() => {});
  }, 12 * 60 * 60 * 1000);
});
