require("dotenv").config();

/* =========================
   CRASH PROTECTION (Sunucu asla çökmesin)
========================= */
process.on("uncaughtException", (err) => {
  console.error(`[FATAL] Yakalanmamış hata (sunucu ÇÖKMEDEN kurtarıldı): ${err.message}`);
  console.error(err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(`[FATAL] İşlenmeyen Promise hatası (sunucu ÇÖKMEDEN kurtarıldı):`, reason);
});

// Memory izleme — RAM dolmadan uyar
setInterval(() => {
  const mem = process.memoryUsage();
  const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
  if (mem.heapUsed > 400 * 1024 * 1024) {
    console.warn(`[MEMORY_WARNING] RAM yüksek! Heap: ${heapUsedMB} MB, RSS: ${rssMB} MB`);
    if (global.gc) global.gc(); // Manuel garbage collection
  }
}, 60000); // Her dakika kontrol

const axios = require("axios");
const http = require("http");
const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const express = require("express");
const ytdlp = require("yt-dlp-exec");
// PoToken: sistem yt-dlp binary'sini kullan (Docker'dan gelir)
const YT_DLP_PATH = process.env.YT_DLP_PATH || "/usr/local/bin/yt-dlp";
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const Redis = require("ioredis");

const PQueue = require("p-queue").default;
const { Innertube, UniversalCache } = require("youtubei.js");

/* =========================
   ANTI-BOT FAZ 1: COOKIE & PROXY ROTASYONU
   yt_cookies/ klasörüne koyduğunuz tüm .txt dosyaları otomatik algılanır.
   proxies.txt dosyasındaki proxy adresleri rotasyona sokulur.
   Klasör/dosya boşsa mevcut cookies.txt ve PROXY_URL kullanılır.
========================= */
let cookiePool = [];
let proxyPool = [];

function loadRotationAssets() {
  try {
    // Cookie havuzunu yükle
    const cookieDir = path.join(__dirname, "yt_cookies");
    if (!fs.existsSync(cookieDir)) fs.mkdirSync(cookieDir, { recursive: true });
    const cookieFiles = fs.readdirSync(cookieDir).filter(f => f.endsWith(".txt"));
    cookiePool = cookieFiles.map(f => path.join(cookieDir, f));

    // Proxy havuzunu yükle
    const proxyFile = path.join(__dirname, "proxies.txt");
    if (fs.existsSync(proxyFile)) {
      proxyPool = fs.readFileSync(proxyFile, "utf-8")
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.startsWith("http"));
    }

    console.log(`[ROTATION] Yüklendi: ${cookiePool.length} cookie dosyası, ${proxyPool.length} proxy adresi`);
  } catch (e) {
    console.warn("[ROTATION] Asset yükleme hatası (sistem eski ayarlarla devam eder):", e.message);
  }
}

function getRandomCookie() {
  // Havuzda dosya varsa rastgele seç, yoksa varsayılan cookies.txt
  if (cookiePool.length > 0) {
    return cookiePool[Math.floor(Math.random() * cookiePool.length)];
  }
  return fs.existsSync(path.join(__dirname, "cookies.txt")) ? path.join(__dirname, "cookies.txt") : null;
}

function getRandomProxy() {
  // Havuzda proxy varsa rastgele seç, yoksa env var
  if (proxyPool.length > 0) {
    return proxyPool[Math.floor(Math.random() * proxyPool.length)];
  }
  return process.env.PROXY_URL || null;
}

// Başlangıçta yükle + her 10 dakikada bir yeniden tara (yeni dosya eklerseniz otomatik algılanır)
loadRotationAssets();
setInterval(loadRotationAssets, 10 * 60 * 1000);

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
      client_type: 'TV'
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
      await yt.session.signIn(creds);
    } else {
      console.warn("[YOUTUBEI] OAuth kimlik bilgisi bulunamadı, anonim modda çalışıyor.");
    }
  } catch (err) {
    console.error("[YOUTUBEI] Başlatma Hatası:", err.message);
  }
}
initYoutubei();

/* =========================
   ANTI-BOT FAZ 2: HESAP ISITMA (ZOMBİ HESAP KORUMASI)
   OAuth oturumu varsa 24 saatte bir YouTube anasayfasında gezinir,
   rastgele video bilgisi çeker ve %30 ihtimalle beğeni atar.
   Hesap "sadece indirme botu" yerine "gerçek kullanıcı" profili kazanır.
   OAuth yoksa sessizce atlanır, sistemi etkilemez.
========================= */
async function warmupAccount() {
  try {
    if (!yt) return;
    // OAuth oturumu yoksa çalışma
    if (!yt.session || !yt.session.logged_in) {
      console.log("[WARMUP] OAuth oturumu yok, ısıtma atlanıyor.");
      return;
    }

    console.log("[WARMUP] Hesap ısıtma rutini başladı...");

    // Anasayfadan video listesi çek
    const home = await yt.getHomeFeed();
    const videos = home?.videos || home?.contents?.filter(c => c.id) || [];

    if (videos.length === 0) {
      console.log("[WARMUP] Anasayfada video bulunamadı, atlanıyor.");
      return;
    }

    // Rastgele 1-2 videonun bilgisini çek (izleme simülasyonu)
    const pickCount = Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < pickCount && i < videos.length; i++) {
      const randomIdx = Math.floor(Math.random() * Math.min(10, videos.length));
      const video = videos[randomIdx];
      if (!video || !video.id) continue;

      try {
        await yt.getBasicInfo(video.id);
        console.log(`[WARMUP] Video bilgisi çekildi: ${video.id}`);

        // %30 ihtimalle beğeni at
        //    if (Math.random() > 0.7) {
        //     try {
        //      await yt.interact.like(video.id);
        //   console.log(`[WARMUP]  Rastgele beğeni atıldı: ${video.id}`);
        //  } catch (likeErr) {
        // Like başarısız olabilir, önemsiz
        //      }
        //      }
        // Beğeni KALDIRILDI — YouTube watch_time=0 + like=1 pattern'ını
        // zombie hesap olarak işaretliyor
      } catch (videoErr) {
        // Tek video hatası tüm rutini durdurmasın
      }

      // İnsan davranışı: 3-8 saniye arası bekle
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
    }

    console.log("[WARMUP] Hesap ısıtma rutini tamamlandı ✅");
  } catch (e) {
    console.warn("[WARMUP] Isıtma başarısız (önemsiz, sistem etkilenmez):", e.message);
  }
}

// İlk ısıtma: sunucu açıldıktan 15 dakika sonra (hemen başlamamak daha doğal)
setTimeout(warmupAccount, 15 * 60 * 1000);
// Sonraki ısıtmalar: 48 saatte bir (daha az şüpheli, YouTube'un radar aralığı dışında)
setInterval(warmupAccount, 48 * 60 * 60 * 1000);

const queue = new PQueue({
  concurrency: 5,      // YouTube bot tespitini önlemek için düşük tutuldu
  interval: 2000,
  intervalCap: 3       // 2 saniyede max 3 istek (insan davranışı)
});

// ★ VIDEO ID DOĞRULAMA (Path traversal ve injection koruması)
const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
function isValidVideoId(id) {
  return id && VIDEO_ID_REGEX.test(id);
}

/* =========================
   CLOUDFLARE R2 (S3) CACHE
========================= */
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");

let r2Client = null;
const R2_BUCKET = process.env.R2_BUCKET_NAME || "ringtone-cache";
const R2_MAX_SIZE = 9 * 1024 * 1024 * 1024; // 9GB limit (10GB free, 1GB tampon)
const R2_CLEANUP_DAYS = 30; // 30 gün dinlenmemiş şarkıları sil

if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
  console.log("[R2] Cloudflare R2 bağlantısı hazır!");
} else {
  console.warn("[R2] R2 credentials bulunamadı. Sadece disk cache kullanılacak.");
}

// R2'ye dosya yükle (arka planda)
async function uploadToR2(key, filePath) {
  if (!r2Client) return;
  try {
    const fileStream = fs.createReadStream(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === ".m4a" ? "audio/mp4" : ext === ".mp4" ? "video/mp4" : "application/octet-stream";

    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: contentType
    }));
    console.log(`[R2_UPLOAD] Başarılı: ${key}`);
    // Erişim zamanını kaydet
    await trackR2Access(key);
  } catch (err) {
    console.warn(`[R2_UPLOAD_ERR] ${key}: ${err.message}`);
  }
}

// R2'de dosya var mı kontrol et
async function existsInR2(key) {
  if (!r2Client) return false;
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (err) {
    return false;
  }
}

// R2'den dosyayı stream olarak al
async function getR2Stream(key) {
  if (!r2Client) return null;
  try {
    const response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    // Her erişimde son dinlenme zamanını güncelle
    trackR2Access(key).catch(() => { });
    return {
      stream: response.Body,
      contentType: response.ContentType,
      contentLength: response.ContentLength
    };
  } catch (err) {
    if (err.name !== "NoSuchKey") console.warn(`[R2_GET_ERR] ${key}: ${err.message}`);
    return null;
  }
}

// ★ R2 ERİŞİM TAKİBİ: Her dinlemede son erişim zamanını Redis'e kaydet
async function trackR2Access(key) {
  try {
    if (redis) {
      await redis.hset("r2:last_access", key, Date.now().toString());
    }
  } catch (err) { /* sessizce devam */ }
}

// ★ R2 OTOMATİK TEMİZLEYİCİ: 30 gündür dinlenmeyen şarkıları siler
async function cleanupR2() {
  if (!r2Client) return;
  try {
    console.log("[R2_CLEANUP] Otomatik temizlik başlıyor...");

    // R2'deki tüm dosyaları listele
    let allObjects = [];
    let continuationToken = undefined;
    do {
      const listResponse = await r2Client.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        ContinuationToken: continuationToken
      }));
      if (listResponse.Contents) allObjects.push(...listResponse.Contents);
      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
    } while (continuationToken);

    if (allObjects.length === 0) {
      console.log("[R2_CLEANUP] R2 deposu boş, temizlik gerekmiyor.");
      return;
    }

    // Toplam boyutu hesapla
    const totalSize = allObjects.reduce((acc, obj) => acc + (obj.Size || 0), 0);
    console.log(`[R2_CLEANUP] R2 deposu: ${allObjects.length} dosya, ${(totalSize / 1024 / 1024).toFixed(1)} MB`);

    // Redis'ten son erişim zamanlarını al
    let lastAccessMap = {};
    if (redis) {
      lastAccessMap = await redis.hgetall("r2:last_access") || {};
    }

    const now = Date.now();
    const maxAge = R2_CLEANUP_DAYS * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    let deletedSize = 0;

    // Boyut limitini aşıyorsa veya eski dosyalar varsa temizle
    const needsSpaceCleanup = totalSize > R2_MAX_SIZE;

    // Dosyaları son erişim zamanına göre sırala (en eski önce)
    const sortedObjects = allObjects.map(obj => ({
      ...obj,
      lastAccess: parseInt(lastAccessMap[obj.Key] || "0") || (obj.LastModified ? obj.LastModified.getTime() : 0)
    })).sort((a, b) => a.lastAccess - b.lastAccess);

    for (const obj of sortedObjects) {
      const age = now - obj.lastAccess;
      const isExpired = age > maxAge;
      const needsSpace = needsSpaceCleanup && (totalSize - deletedSize) > R2_MAX_SIZE * 0.7;

      if (isExpired || needsSpace) {
        try {
          await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: obj.Key }));
          deletedCount++;
          deletedSize += obj.Size || 0;
          if (redis) await redis.hdel("r2:last_access", obj.Key);
          console.log(`[R2_CLEANUP] Silindi: ${obj.Key} (${(age / 86400000).toFixed(0)} gün önce dinlenmiş)`);
        } catch (delErr) {
          console.warn(`[R2_CLEANUP_ERR] ${obj.Key}: ${delErr.message}`);
        }
      }
    }

    if (deletedCount > 0) {
      console.log(`[R2_CLEANUP] Tamamlandı: ${deletedCount} dosya silindi, ${(deletedSize / 1024 / 1024).toFixed(1)} MB yer açıldı.`);
    } else {
      console.log("[R2_CLEANUP] Silinecek eski dosya yok. Depo sağlıklı ✅");
    }
  } catch (err) {
    console.error(`[R2_CLEANUP_ERR] ${err.message}`);
  }
}

// Her 6 saatte bir otomatik temizlik çalıştır
setInterval(cleanupR2, 6 * 60 * 60 * 1000);
// Startup'tan 2 dakika sonra ilk temizliği yap
setTimeout(cleanupR2, 2 * 60 * 1000);

/* =========================
   PHASE 6: DISK CACHING
========================= */
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
const MAX_CACHE_SIZE = 300 * 1024 * 1024; // 300MB limit (Railway ephemeral disk için)

function checkDiskSpaceAndCleanup() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR).map(f => {
      const p = path.join(CACHE_DIR, f);
      return { path: p, stat: fs.statSync(p), name: f };
    });

    const now = Date.now();
    for (const file of files) {
      if ((file.path.endsWith('.tmp') || file.path.endsWith('.ytdl') || file.path.includes('.part') || file.path.includes('.fallback')) && (now - file.stat.mtimeMs > 10 * 60 * 1000)) {
        try { fs.unlinkSync(file.path); console.log(`[DISK_CLEANUP] Eski temp silindi: ${file.path}`); } catch (e) { }
      }
    }

    const currentFiles = fs.readdirSync(CACHE_DIR).map(f => {
      const p = path.join(CACHE_DIR, f);
      return { path: p, stat: fs.statSync(p), name: f };
    });

    const totalSize = currentFiles.reduce((acc, f) => acc + f.stat.size, 0);
    if (totalSize > MAX_CACHE_SIZE) {
      console.log(`[DISK_CLEANUP] Disk doluyor (${(totalSize / 1024 / 1024).toFixed(1)} MB). Temizleniyor...`);
      // Aktif indirmeleri silmemek icin sadece tamamlanmis dosyalari sil (.mp4, .m4a)
      const finishedFiles = currentFiles.filter(f => f.name.endsWith('.mp4') || f.name.endsWith('.m4a'));
      finishedFiles.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
      let deletedSize = 0;
      const targetToDelete = totalSize - (MAX_CACHE_SIZE * 0.5); // %50'ye kadar temizle
      for (const file of finishedFiles) {
        if (deletedSize >= targetToDelete) break;
        try { fs.unlinkSync(file.path); deletedSize += file.stat.size; } catch (e) { }
      }
      console.log(`[DISK_CLEANUP] ${(deletedSize / 1024 / 1024).toFixed(1)} MB yer açıldı.`);
    }
  } catch (err) { console.error(`[DISK_CLEANUP] Hata: ${err.message}`); }
}
setInterval(checkDiskSpaceAndCleanup, 15 * 1000); // 15 saniyede bir kontrol
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
    const minSize = type === "video" ? 150 * 1024 : 20 * 1024;
    if (stats.size < minSize) {
      fs.unlinkSync(filePath);
      throw new Error(`Download successful but file too small (${(stats.size / 1024).toFixed(1)} KB) - likely bot detection.`);
    }

    console.log(`[DISK_CACHE] Kaydedildi: ${fileName} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    // ★ Arka planda R2'ye de yükle (kalıcı bulut cache)
    const r2Key = `${type}/${videoId}.${ext}`;
    uploadToR2(r2Key, filePath).catch(() => { });
  } catch (err) {
    console.log(`[DISK_CACHE_ERR] ${fileName} indirilemedi: ${err.message}`);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  } finally {
    downloadingFiles.delete(fileName);
  }
}

// Gereksiz ikinci disk silici temizlendi.

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
const CIRCUIT_BREAKER_THRESHOLD = 10;
const CIRCUIT_BREAKER_TIMEOUT = 30 * 1000; // 30 sn (Çok daha kısa, hızlıca tekrar dener)
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
    if (redis) {
      redis.disconnect();
    }
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

// OOM (Out of Memory) önleyici temizlik: Belleği şişiren eski aramaları süpür
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of memoryCache.entries()) {
    if (now >= value.expire) {
      memoryCache.delete(key);
    }
  }
  // Eğer hala çok büyükse en eskileri zorla sil (Yüksek kapasite limiti)
  if (memoryCache.size > 2000) {
    const keys = Array.from(memoryCache.keys());
    for (let i = 0; i < keys.length - 1000; i++) {
      memoryCache.delete(keys[i]);
    }
  }
}, 60 * 1000);

// Bots & Jitter
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1"
];
function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Bot tespiti atlatmak için zenginleştirilmiş client hints header'ları
function getAntiBotHeaders(ua) {
  const isMobile = ua.includes("Android") || ua.includes("Mobile") || ua.includes("iPhone");
  const platform = ua.includes("Windows") ? '"Windows"' : ua.includes("Mac OS X") ? '"macOS"' : '"Linux"';
  return {
    "User-Agent": ua,
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": isMobile ? "?1" : "?0",
    "sec-ch-ua-platform": platform,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Accept-Language": "en-US,en;q=0.9"
  };
}
const randomJitter = async () => {
  // Sadece yt-dlp çağrılarında kullanılır, 100-300ms arası minimal gecikme
  const ms = Math.floor(Math.random() * 200) + 100;
  await new Promise(resolve => setTimeout(resolve, ms));
};

// Fallback player client stratejisi: default → android → web (3 deneme yeterli, hız için)
const PLAYER_CLIENTS = ["default", "android", "web"];

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
      "--remote-components", "ejs:github",
      "--quiet", "--no-warnings"
    ];

    // Cookie Rotasyonu (Faz 1)
    const streamCookie = getRandomCookie();
    if (process.env.USE_COOKIES !== "false" && streamCookie) {
      args.push("--cookies", streamCookie);
    }
    // Proxy Rotasyonu (Faz 1)
    const streamProxy = getRandomProxy();
    if (streamProxy) {
      args.push("--proxy", streamProxy);
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
          if (stats.size > (type === "video" ? 150 * 1024 : 20 * 1024)) {
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
    // Video için: en iyi video+audio birleştir, yoksa hazır birleşik al
    const format = type === "audio"
      ? "bestaudio[ext=m4a]/bestaudio"
      : "b[ext=mp4][height<=720]/best[ext=mp4]/b/best";
    const outputFile = path.join(CACHE_DIR, `${type}_${videoId}.${ext}`);
    const tempFile = path.join(CACHE_DIR, `temp_${videoId}.${ext}`);

    if (fs.existsSync(outputFile)) {
      const stats = fs.statSync(outputFile);
      const minSize = type === "video" ? 150 * 1024 : 20 * 1024;
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
      "--socket-timeout", "30",
      "--remote-components", "ejs:github"
    ];

    // Video ise çıktıyı direkt mp4 olarak alıyoruz (merge gerekmez)
    // args.push("--merge-output-format", "mp4");

    // Cookie Rotasyonu (Faz 1)
    const dlCookie = getRandomCookie();
    if (process.env.USE_COOKIES !== "false" && dlCookie) {
      args.push("--cookies", dlCookie);
    }

    // Proxy Rotasyonu (Faz 1)
    const dlProxy = getRandomProxy();
    if (dlProxy) {
      args.push("--proxy", dlProxy);
    }

    console.log(`[YTDL_DIRECT] İndiriliyor: ${videoId} (${type})`);

    const proc = execFile(ytdlpBin, args, {
      timeout: 900000, // 15 dakika (büyük videolar için)
      maxBuffer: 50 * 1024 * 1024
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
      const minSize = type === "video" ? 100 * 1024 : 20 * 1024; // 100KB video, 20KB audio min

      if (stats.size < minSize) {
        fs.unlinkSync(tempFile);
        return reject(new Error(`İndirilen dosya çok küçük (${(stats.size / 1024).toFixed(1)} KB) - bot detection`));
      }

      // Başarılı! Temp'ten asıl dosyaya taşı
      fs.renameSync(tempFile, outputFile);
      console.log(`[YTDL_DIRECT] Başarılı: ${outputFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
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

      // Cookie Rotasyonu (Faz 1)
      const useCookies = process.env.USE_COOKIES !== "false";
      const resolveCookie = getRandomCookie();
      if (useCookies && resolveCookie) {
        opts.cookies = resolveCookie;
      }

      // Proxy Rotasyonu (Faz 1)
      const resolveProxy = getRandomProxy();
      if (resolveProxy) {
        opts.proxy = resolveProxy;
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

// Dinamik + statik Piped instance listesi
let PIPED_INSTANCES = [
  "https://api.piped.private.coffee"   // Tek güvenilir instance (%99.5 uptime)
];

// Başlangıçta güncel Piped instance'larını çek
async function refreshPipedInstances() {
  try {
    const res = await axiosClient.get("https://piped-instances.kavin.rocks/", { timeout: 5000 });
    if (Array.isArray(res.data)) {
      const working = res.data
        .filter(i => i.up_to_date && i.uptime_24h > 90)
        .map(i => i.api_url)
        .filter(url => url && url.startsWith("https"));
      if (working.length > 0) {
        PIPED_INSTANCES = working; // Eski ölü instance'ları KOMPLE değiştir
        console.log(`[PIPED_REFRESH] ${PIPED_INSTANCES.length} aktif instance havuzda`);
      }
    }
  } catch (e) {
    console.warn(`[PIPED_REFRESH] Güncel liste alınamadı: ${e.message}`);
  }
}
setTimeout(refreshPipedInstances, 5000);
setInterval(refreshPipedInstances, 30 * 60 * 1000);

// Dinamik + statik Invidious instance listesi
let INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",          // %99.9 uptime, Şili
  "https://inv.thepixora.com",       // %98.5 uptime, Kanada (API açık)
  "https://invidious.nerdvpn.de",    // %99.9 uptime, Ukrayna
  "https://yt.chocolatemoo53.com"    // %88.9 uptime, ABD
];

// Başlangıçta güncel Invidious instance'larını çek
async function refreshInvidiousInstances() {
  try {
    const res = await axiosClient.get("https://api.invidious.io/instances.json", { timeout: 5000 });
    if (Array.isArray(res.data)) {
      const working = res.data
        .filter(([name, info]) => info.type === "https" && info.monitor && !info.monitor.down)
        .map(([name, info]) => info.uri)
        .filter(url => url && url.startsWith("https"));
      if (working.length > 0) {
        INVIDIOUS_INSTANCES = Array.from(new Set([...INVIDIOUS_INSTANCES, ...working]));
        console.log(`[INVIDIOUS_REFRESH] ${INVIDIOUS_INSTANCES.length} aktif instance havuzda`);
      }
    }
  } catch (e) {
    console.warn(`[INVIDIOUS_REFRESH] Güncel liste alınamadı: ${e.message}`);
  }
}
setTimeout(refreshInvidiousInstances, 6000);
setInterval(refreshInvidiousInstances, 30 * 60 * 1000);

async function fetchFromPiped(endpointPath) {
  let lastError = null;
  // Sunucu sırasını karıştır — ölü sunucuya sürekli denk gelmeyi önle
  const shuffled = [...PIPED_INSTANCES].sort(() => Math.random() - 0.5);
  for (const instance of shuffled) {
    try {
      const res = await axiosClient.get(`${instance}${endpointPath}`, { timeout: 5000 });
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

// HIZLI PARALEL PIPED — Search için (Promise.any ile en hızlı yanıt)
async function fetchFromPipedFast(endpointPath) {
  const promises = PIPED_INSTANCES.map(instance =>
    axiosClient.get(`${instance}${endpointPath}`, { timeout: 3000 })
      .then(res => {
        if (res && res.data && !res.data.error) return res;
        throw new Error("Invalid response");
      })
  );
  try {
    return await Promise.any(promises);
  } catch (err) {
    throw new Error("Tüm Piped API instance'ları başarısız oldu (paralel).");
  }
}


async function tryInvidiousFallback(videoId, type) {
  const shuffled = [...INVIDIOUS_INSTANCES].sort(() => Math.random() - 0.5);
  for (const instance of shuffled) {
    try {
      const res = await axiosClient.get(`${instance}/api/v1/videos/${videoId}`, { timeout: 3000 });
      if (res && res.data) {
        if (res.data.error) throw new Error(res.data.error);
        if (type === "audio") {
          const streams = res.data.adaptiveFormats;
          if (streams && Array.isArray(streams)) {
            const m4a = streams.find(s => (s.type && s.type.includes("audio/mp4")) || s.container === "m4a") || streams.find(s => s.type && s.type.includes("audio"));
            if (m4a && m4a.itag) {
              // DAIMA Invidious proxy üzerinden geç — doğrudan googlevideo linklerini ASLA kullanma
              return `${instance}/latest_version?id=${videoId}&itag=${m4a.itag}&local=true`;
            }
          }
        } else {
          const streams = res.data.formatStreams;
          if (streams && Array.isArray(streams)) {
            const mp4 = streams.find(s => (s.type && s.type.includes("video/mp4") && s.qualityLabel === "720p")) ||
              streams.find(s => s.type && s.type.includes("video/mp4")) ||
              streams[0];
            if (mp4 && mp4.itag) {
              return `${instance}/latest_version?id=${videoId}&itag=${mp4.itag}&local=true`;
            }
          }
        }
        throw new Error("No valid streams/itag in Invidious response.");
      }
    } catch (err) {
      logError("INVIDIOUS_INSTANCE_ERR", videoId, `Instance ${instance} failed: ${err.message}`);
    }
  }
  throw new Error("All Invidious instances failed.");
}

async function resolveStreamUrlWithFallback(videoId, type, ua, countryClient, forceProxy = false) {
  // ★ AKILLI ZAMANLI YARIŞ SİSTEMİ
  // Piped/Invidious/Cobalt HEMEN başlar (YouTube'a hiç gitmez)
  // yt-dlp/Youtubei 2 SANİYE GECİKMELİ başlar (proxy korumalı)
  // Promise.any → ilk cevap veren kazanır
  // Eğer Piped 1sn'de cevap verirse yt-dlp hiç YouTube'a istek göndermez!

  const allPromises = [];

  // ═══════ HEMEN BAŞLAYANLAR (YouTube'a gitmez, ücretsiz) ═══════

  // KATMAN 1: Piped (anında başlar)
  allPromises.push(
    (async () => {
      const pipedRes = await fetchFromPiped(`/streams/${videoId}`);
      if (type === "audio") {
        const streams = pipedRes.data.audioStreams || [];
        const best = streams.find(s => (s.mimeType && s.mimeType.includes("mp4a")) || s.format === "M4A") || streams[0];
        if (best && best.url) return { source: "piped", url: best.url };
      } else {
        const streams = pipedRes.data.videoStreams || [];
        const best = streams.find(s => s.videoOnly === false && s.format === "MPEG_4" && s.quality === "720p") ||
          streams.find(s => s.videoOnly === false && s.format === "MPEG_4") || streams[0];
        if (best && best.url) return { source: "piped", url: best.url };
      }
      throw new Error("Piped bulunamadı");
    })()
  );

  // KATMAN 2: Invidious (anında başlar)
  allPromises.push(
    (async () => {
      const invidiousUrl = await tryInvidiousFallback(videoId, type);
      if (invidiousUrl) return { source: "invidious", url: invidiousUrl };
      throw new Error("Invidious bulunamadı");
    })()
  );

  // KATMAN 3: Cobalt (anında başlar)
  allPromises.push(
    (async () => {
      const payload = {
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoQuality: "720",
        downloadMode: type === "audio" ? "audio" : "auto",
        audioFormat: "mp3",
        youtubeVideoCodec: "h264"
      };
      const cobaltRes = await axios.post("https://api.cobalt.tools/", payload, {
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        timeout: 4000
      });
      if (cobaltRes.data && cobaltRes.data.url) return { source: "cobalt", url: cobaltRes.data.url };
      throw new Error("Cobalt bulunamadı");
    })()
  );

  // ═══════ 2 SANİYE GECİKMELİ BAŞLAYANLAR (YouTube-direkt, proxy korumalı) ═══════
  // Piped/Invidious/Cobalt 2sn içinde cevap verirse bunlar hiç başlamaz!

  if (!forceProxy) {
    // KATMAN 4: yt-dlp (2sn gecikme + jitter ile)
    allPromises.push(
      (async () => {
        await new Promise(r => setTimeout(r, 2000)); // 2sn bekle — 3.parti API'lere şans ver
        await randomJitter(); // Bot tespitini önlemek için ek rastgele gecikme
        const format = type === "audio" ? "bestaudio" : "best[ext=mp4][protocol^=http]/best[ext=mp4][protocol!=m3u8_native][protocol!=m3u8]/best[ext=mp4]/best";
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const result = await resolveStreamUrl(url, format, ua, countryClient);
        if (result) return { source: "yt-dlp", url: result };
        throw new Error("yt-dlp başarısız");
      })()
    );

    // KATMAN 5: Youtubei.js (2sn gecikme + jitter ile)
    allPromises.push(
      (async () => {
        await new Promise(r => setTimeout(r, 2000)); // 2sn bekle — 3.parti API'lere şans ver
        await randomJitter(); // Bot tespitini önlemek için ek rastgele gecikme
        const ytUrl = await resolveWithYoutubei(videoId, type);
        if (ytUrl) return { source: "youtubei", url: ytUrl };
        throw new Error("Youtubei başarısız");
      })()
    );
  }

  try {
    const winner = await Promise.any(allPromises);
    console.log(`[RESOLVE] ✅ ${winner.source.toUpperCase()} kazandı (en hızlı): ${videoId}`);
    stats.proxyFallbackSuccess++;
    return winner.url;
  } catch (allErr) {
    stats.proxyFallbackFail++;
    logError("ALL_METHODS_FAIL", videoId, `Tüm yöntemler başarısız: ${allErr.message}`);
    throw new Error("Tüm yöntemler başarısız oldu (Piped + Invidious + Cobalt + yt-dlp + Youtubei.js).");
  }
}

const axiosClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true })
});

// ★ AKILLI PROXY ROUTING: Proxy SADECE YouTube/googlevideo URL'lerinde kullanılır
// Piped/Invidious URL'lerinde proxy kullanılmaz → bandwidth tasarrufu
function getProxyAxiosConfig(extraConfig = {}) {
  const config = { ...extraConfig };
  const targetUrl = config._targetUrl || "";
  const needsProxy = targetUrl.includes("googlevideo.com") || 
                     targetUrl.includes("youtube.com") ||
                     targetUrl.includes("ytimg.com") ||
                     targetUrl === ""; // URL belirtilmemişse güvenli tarafta kal
  if (process.env.PROXY_URL && needsProxy) {
    config.httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL);
    config.httpAgent = undefined; // proxy agent kullanılacak
  }
  delete config._targetUrl; // axios'a göndermeden önce temizle
  return config;
}

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
   HMAC SECURITY AUTH MIDDLEWARE
   + SERVER-SIDE TOKEN EXCHANGE (APK güvenliği)
========================= */
const crypto = require("crypto");

// ★ TOKEN EXCHANGE: Geçici API token'ları yönetimi
// APK'daki secret key sadece 1 kez /auth/token için kullanılır
// Sonraki tüm istekler geçici token ile yapılır
const activeApiTokens = new Map(); // token -> { createdAt, expiresAt, ip }
const API_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 saat (ms)

// Token oluşturma endpoint'i — HMAC ile çağrılır, geçici token döner
app.post("/auth/token", async (req, res) => {
  try {
    const timestamp = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];
    const EXPECTED_SECRET = process.env.APP_KEY || "RINGTONE_MASTER_V2_SECRET_2026";

    if (!timestamp || !signature) {
      return res.status(403).json({ error: "Missing credentials" });
    }

    // Replay attack koruması
    if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000) {
      return res.status(403).json({ error: "Request expired" });
    }

    // HMAC doğrulama
    const payload = timestamp + ":" + "/auth/token";
    const expectedSignature = crypto.createHmac("sha256", EXPECTED_SECRET).update(payload).digest("base64");
    if (signature !== expectedSignature) {
      console.warn(`[AUTH_TOKEN] Hatalı HMAC ile token istendi: IP: ${req.ip}`);
      return res.status(403).json({ error: "Invalid signature" });
    }

    // Geçici token oluştur
    const token = crypto.randomBytes(32).toString("hex");
    const tokenData = {
      createdAt: Date.now(),
      expiresAt: Date.now() + API_TOKEN_TTL,
      ip: req.ip
    };

    activeApiTokens.set(token, tokenData);

    // Redis'e de kaydet (sunucu restart'larında korunsun)
    try {
      if (redis) await redis.set(`api:token:${token}`, JSON.stringify(tokenData), "EX", Math.floor(API_TOKEN_TTL / 1000));
    } catch (e) { }

    // Eski expired token'ları temizle (bellek yönetimi)
    for (const [t, d] of activeApiTokens) {
      if (d.expiresAt < Date.now()) activeApiTokens.delete(t);
    }

    console.log(`[AUTH_TOKEN] ✅ Yeni API token verildi: IP: ${req.ip} | Token: ${token.substring(0, 8)}...`);
    res.json({ token, expiresIn: API_TOKEN_TTL / 1000 }); // saniye cinsinden süre
  } catch (err) {
    console.error("[AUTH_TOKEN] Token oluşturma hatası:", err.message);
    res.status(500).json({ error: "Token generation failed" });
  }
});

app.use(async (req, res, next) => {
  // Tamamen açık endpoint'ler
  if (req.path === "/health" || req.path === "/config" || req.path === "/auth/token") {
    return next();
  }

  // ★ YÖNTEM 1: Bearer Token ile erişim (tercih edilen, daha güvenli)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    // Önce memory'den kontrol
    let tokenData = activeApiTokens.get(token);

    // Memory'de yoksa Redis'ten kontrol
    if (!tokenData && redis) {
      try {
        const redisData = await redis.get(`api:token:${token}`);
        if (redisData) {
          tokenData = JSON.parse(redisData);
          activeApiTokens.set(token, tokenData); // memory'e de ekle
        }
      } catch (e) { }
    }

    if (tokenData && tokenData.expiresAt > Date.now()) {
      return next(); // ✅ Geçerli token — erişim izni
    }

    // Token geçersiz veya süresi dolmuş
    if (tokenData) {
      activeApiTokens.delete(token);
      try { if (redis) await redis.del(`api:token:${token}`); } catch (e) { }
    }
    // Token geçersizse HMAC'a düş (geriye uyumluluk)
  }

  // ★ YÖNTEM 2: HMAC Signature ile erişim (eski yöntem, geriye uyumlu)
  const timestamp = req.headers['x-timestamp'];
  const signature = req.headers['x-signature'];
  const EXPECTED_SECRET = process.env.APP_KEY || "RINGTONE_MASTER_V2_SECRET_2026";

  if (!timestamp || !signature) {
    console.warn(`[AUTH] Yetkisiz erişim (Eksik İmza): IP: ${req.ip} - Path: ${req.path}`);
    return res.status(403).json({ error: "Unauthorized / Missing Signature" });
  }

  // İstek 5 dakikadan eski ise reddet (Replay Attack koruması)
  const now = Date.now();
  if (Math.abs(now - parseInt(timestamp)) > 5 * 60 * 1000) {
    console.warn(`[AUTH] Süresi dolmuş istek: IP: ${req.ip}`);
    return res.status(403).json({ error: "Request Expired" });
  }

  // Beklenen imzayı oluştur
  const payload = timestamp + ":" + req.path;
  const expectedSignature = crypto.createHmac("sha256", EXPECTED_SECRET).update(payload).digest("base64");

  if (signature === expectedSignature) {
    next();
  } else {
    console.warn(`[AUTH] Hatalı imza ile erişim: IP: ${req.ip}`);
    return res.status(403).json({ error: "Forbidden / Invalid Signature" });
  }
});

/* =========================
   DRM FAZ 2: STREAM TOKEN SİSTEMİ (Redis destekli)
   Her stream isteği için tek kullanımlık, süresi dolan token üretilir.
   Token'lar mevcut cache key'lerinden tamamen bağımsızdır (drm:token:* prefix).
========================= */
const DRM_TOKEN_TTL = 15 * 60; // 15 dakika (saniye)
const activeStreamTokens = new Map(); // Redis yoksa fallback

async function generateStreamToken(videoId, userId, type = "audio") {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + (DRM_TOKEN_TTL * 1000);
  const tokenData = { videoId, userId, type, expires, used: false, createdAt: Date.now() };

  try {
    if (redis) {
      await redis.set(`drm:token:${token}`, JSON.stringify(tokenData), "EX", DRM_TOKEN_TTL);
    }
  } catch (e) { /* Redis hata, in-memory fallback */ }
  activeStreamTokens.set(token, tokenData);

  console.log(`[DRM] Token üretildi: ${token.substring(0, 8)}... | videoId: ${videoId} | type: ${type}`);
  return { token, expires };
}

async function validateStreamToken(token, videoId) {
  let entry = null;

  // Önce Redis'ten kontrol et
  try {
    if (redis) {
      const redisData = await redis.get(`drm:token:${token}`);
      if (redisData) entry = JSON.parse(redisData);
    }
  } catch (e) { /* Redis hata, in-memory fallback */ }

  // Redis'te yoksa in-memory'den bak
  if (!entry) entry = activeStreamTokens.get(token);
  if (!entry) return { valid: false, reason: "Token bulunamadı" };

  if (entry.expires < Date.now()) {
    activeStreamTokens.delete(token);
    try { if (redis) await redis.del(`drm:token:${token}`); } catch (e) { }
    return { valid: false, reason: "Token süresi dolmuş" };
  }
  if (entry.videoId !== videoId) return { valid: false, reason: "Video ID uyuşmuyor" };
  if (entry.used) return { valid: false, reason: "Token zaten kullanıldı" };

  // Token'ı kullanıldı olarak işaretle (tek kullanımlık)
  entry.used = true;
  activeStreamTokens.set(token, entry);
  try {
    if (redis) await redis.set(`drm:token:${token}`, JSON.stringify(entry), "EX", 60); // 1 dk sonra otomatik silinir
  } catch (e) { }

  console.log(`[DRM] Token doğrulandı: ${token.substring(0, 8)}... | videoId: ${videoId}`);
  return { valid: true };
}

// Token temizleyici: Süresi dolmuş in-memory token'ları her 5 dakikada temizle
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of activeStreamTokens) {
    if (val.expires < now || val.used) activeStreamTokens.delete(key);
  }
}, 5 * 60 * 1000);

/* =========================
   DRM FAZ 5: ERİŞİM İZLEME & ABUSE TESPİTİ
   Her kullanıcının stream erişimini takip eder.
   1 saatte 100+ farklı video = şüpheli aktivite → otomatik engel.
========================= */
const userStreamTracker = new Map();

function trackStreamAccess(userId, videoId, type) {
  if (!userStreamTracker.has(userId)) {
    userStreamTracker.set(userId, { count: 0, videos: new Set(), firstSeen: Date.now(), lastSeen: Date.now() });
  }
  const tracker = userStreamTracker.get(userId);
  tracker.count++;
  tracker.videos.add(videoId);
  tracker.lastSeen = Date.now();

  // Abuse tespiti: 1 saatte 100'den fazla farklı video = şüpheli
  const hourMs = 60 * 60 * 1000;
  if (tracker.videos.size > 100 && (Date.now() - tracker.firstSeen) < hourMs) {
    console.warn(`[DRM_ABUSE] ⚠️ Şüpheli aktivite: IP ${userId} - ${tracker.videos.size} video / ${tracker.count} istek`);
    return false; // Erişimi engelle
  }
  return true;
}

// Tracker temizleyici (her saat eski kayıtları sil)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of userStreamTracker) {
    if (now - val.lastSeen > 2 * 60 * 60 * 1000) userStreamTracker.delete(key);
  }
}, 60 * 60 * 1000);

// DRM yardımcı: Koruma header'larını ekle
function setDrmHeaders(res) {
  res.setHeader("X-DRM-Protected", "true");
  res.setHeader("X-Content-Protection", "RingtoneMaster-DRM/1.0");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
}


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
  windowMs: 60 * 1000,
  max: 200, // Çoklu cihaz desteği: 3+ cihaz rahat kullansın
  handler: (req, res, next, options) => {
    stats.rateLimitHits++;
    logError("RATE_LIMIT", null, `IP ${req.ip} rate limit aştı (Global)`);
    res.status(options.statusCode).send(options.message);
  }
}));

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // Çoklu cihaz desteği
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

// ARKA PLANDA ÖN-BELLEKLEME (Spotify gibi anında açılması için)
function prewarmTop10(items) {
  if (!items || !Array.isArray(items)) return;
  const top10 = items.slice(0, 10); // Sadece ilk 10'u ısıt ki rate-limit yemeyelim
  top10.forEach((item, index) => {
    const videoId = typeof item.id === "object" ? item.id.videoId : item.id;
    if (!videoId) return;

    const cacheKey = `stream:audio:${videoId}`;
    // Eğer cahce'te yoksa, arka planda yavaş yavaş bulup ekle
    cacheGet(cacheKey).then(cachedData => {
      if (!cachedData) {
        // Küçük gecikmelerle kuyruğa ekle (YouTube'u boğmamak için)
        setTimeout(() => {
          queue.add(async () => {
            try {
              const ua = getRandomUA();
              const url = await resolveStreamUrlWithFallback(videoId, "audio", ua, "web");
              await cacheSet(cacheKey, { url, ua }, STREAM_CACHE_DURATION);
              console.log(`[PREWARM_SUCCESS] ${videoId} arkaplanda hazırlandı!`);
            } catch (err) {
              // Sessizce yut
            }
          }).catch(() => { });
        }, index * 2000); // Her bir arasına 2 saniye koy
      }
    });
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

    // Arkada ilk 10 şarkıyı çözmeye başla, kullanıcı tıklayınca anında açılsın!
    prewarmTop10(items);

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
      // ★ ÖNCE ÜCRETSİZ KAYNAKLAR — YouTube API kotası korunur!
      // Sıra: Piped → Invidious → Youtubei → YouTube API (son çare)

      let searchSuccess = false;

      // KATMAN 1: Piped Search (ücretsiz, hızlı)
      if (!searchSuccess) {
        try {
          const pipedRes = await fetchFromPipedFast(`/search?q=${encodeURIComponent(query)}&filter=videos`);
          if (pipedRes.data && pipedRes.data.length > 0) {
            const pipedItems = pipedRes.data.map(item => ({
              id: { videoId: (item.url || "").split("?v=")[1] },
              snippet: {
                title: item.title,
                channelTitle: item.uploaderName,
                channelId: (item.uploaderUrl || "").split("/channel/")[1] || "",
                thumbnails: { high: { url: item.thumbnail || "" } }
              }
            }));
            resultData = filterBlockedChannels(pipedItems);
            nextToken = "";
            searchSuccess = true;
            console.log(`[SEARCH] ✅ Piped kazandı: "${query}"`);
          }
        } catch (pipedErr) {
          console.warn(`[SEARCH] Piped başarısız, Invidious deneniyor: ${pipedErr.message}`);
        }
      }

      // KATMAN 2: Invidious Search (ücretsiz)
      if (!searchSuccess) {
        const shuffledInv = [...INVIDIOUS_INSTANCES].sort(() => Math.random() - 0.5);
        for (const instance of shuffledInv) {
          try {
            const invRes = await axiosClient.get(`${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, { timeout: 4000 });
            if (invRes && invRes.data && invRes.data.length > 0) {
              const invItems = invRes.data.map(item => ({
                id: { videoId: item.videoId },
                snippet: {
                  title: item.title,
                  channelTitle: item.author,
                  channelId: item.authorId || "",
                  thumbnails: { high: { url: item.videoThumbnails?.find(t => t.quality === "high")?.url || "" } }
                }
              }));
              resultData = filterBlockedChannels(invItems);
              nextToken = "";
              searchSuccess = true;
              console.log(`[SEARCH] ✅ Invidious kazandı: "${query}"`);
              break;
            }
          } catch (e) { }
        }
      }

      // KATMAN 3: Youtubei.js Search (YouTube'a gider ama OAuth korumalı)
      if (!searchSuccess && yt) {
        try {
          const searchResults = await yt.search(query, { type: 'video' });
          const ytItems = searchResults.videos.map(item => ({
            id: { videoId: item.id },
            snippet: {
              title: item.title?.text || item.title || "Unknown",
              channelTitle: item.author?.name || "Unknown",
              channelId: item.author?.id || "",
              thumbnails: {
                high: { url: item.best_thumbnail?.url || item.thumbnails?.[0]?.url || "" }
              }
            }
          }));
          if (ytItems.length > 0) {
            resultData = filterBlockedChannels(ytItems);
            nextToken = "";
            searchSuccess = true;
            console.log(`[SEARCH] ✅ Youtubei kazandı: "${query}"`);
          }
        } catch (ytErr) {
          console.warn(`[SEARCH] Youtubei başarısız: ${ytErr.message}`);
        }
      }

      // KATMAN 4: YouTube Data API v3 (SON ÇARE — kota harcar)
      if (!searchSuccess) {
        console.warn(`[SEARCH] ⚠️ Tüm ücretsiz kaynaklar başarısız, YouTube API kullanılıyor (kota harcanır): "${query}"`);
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
        console.log(`[SEARCH] ✅ YouTube API son çare olarak kullanıldı: "${query}"`);
      }

    } catch (apiError) {
      logError("SEARCH_ALL_FAIL", null, `Tüm arama kaynakları başarısız: ${apiError.message}`);
      throw apiError;
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

// DRM FAZ 2: Stream Token Endpoint — İstemci önce token alır
app.post("/stream/token", async (req, res) => {
  try {
    const { videoId, type } = req.body;
    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: "Invalid videoId" });
    }
    const userId = req.headers["x-device-id"] || req.ip;
    const tokenData = await generateStreamToken(videoId, userId, type || "audio");
    res.json(tokenData);
  } catch (err) {
    console.error("[DRM] Token üretme hatası:", err.message);
    res.status(500).json({ error: "Token generation failed" });
  }
});

// STREAM (Direct Pipe)
// STREAM 

app.get("/stream", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: "Invalid or missing videoId" });
    }

    // DRM FAZ 2: Stream token doğrulaması
    const streamToken = req.query.token || req.headers["x-stream-token"];
    if (streamToken) {
      const tokenCheck = await validateStreamToken(streamToken, videoId);
      if (!tokenCheck.valid) {
        console.warn(`[DRM] Token reddedildi: ${tokenCheck.reason} | videoId: ${videoId} | IP: ${req.ip}`);
        return res.status(403).json({ error: "Invalid or expired stream token", reason: tokenCheck.reason });
      }
    }

    // DRM FAZ 5: Erişim izleme & abuse tespiti
    const accessAllowed = trackStreamAccess(req.ip, videoId, "audio");
    if (!accessAllowed) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }

    // DRM: Koruma header'ları
    setDrmHeaders(res);

    const typeStr = (req.query.type === "video" || req.path.includes("video") || req.path.includes("mp4")) ? "video" : "audio";
    const extStr = typeStr === "audio" ? "m4a" : "mp4";
    const r2Key = `${typeStr}/${videoId}.${extStr}`;
    const localFile = path.join(CACHE_DIR, `${typeStr}_${videoId}.${extStr}`);

    // ★ KATMAN 0: CLOUDFLARE R2 (En hızlı — YouTube'a hiç gitmez)
    try {
      const r2Data = await getR2Stream(r2Key);
      if (r2Data && r2Data.stream) {
        console.log(`[R2_CACHE_HIT] ☁️ Cloudflare'den sunuluyor: ${videoId}`);
        if (r2Data.contentType) res.setHeader("Content-Type", r2Data.contentType);
        if (r2Data.contentLength) res.setHeader("Content-Length", r2Data.contentLength);
        r2Data.stream.pipe(res);
        return;
      }
    } catch (r2Err) { /* R2 yoksa disk/YouTube'a devam */ }

    // KATMAN 1: DISK CACHE
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
        // Arka planda R2'ye yükle (bir sonraki istek R2'den gelsin)
        uploadToR2(r2Key, localFile).catch(() => { });
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
      // Queue ile sıralı çalıştır — jitter KALDIRILDI (hız için)
      streamUrl = await queue.add(async () => {
        return resolveStreamUrlWithFallback(videoId, "audio", ua, countryClient);
      });
      // Stream URL'leri 5 saat cache'le (YouTube URL'leri ~6 saat geçerli)
      await cacheSet(cacheKey, { url: streamUrl, ua }, STREAM_CACHE_DURATION);
      console.log("AUDIO CACHE SAVE:", videoId);
    }

    let response;
    let headersOptions;
    try {
      const dynamicHeaders = getAntiBotHeaders(ua);
      headersOptions = {
        ...dynamicHeaders,
        "Referer": "https://www.youtube.com/"
      };
      if (req.headers.range) headersOptions["Range"] = req.headers.range;

      response = await axiosClient({
        method: "GET",
        url: streamUrl,
        responseType: "stream",
        headers: headersOptions,
        validateStatus: (status) => status < 400,
        ...getProxyAxiosConfig({ _targetUrl: streamUrl })
      });
    } catch (fetchErr) {
      if (fetchErr.response && fetchErr.response.status === 403) {
        console.warn(`[STREAM_AUDIO] 403 Forbidden hatası. Cache silinip taze link alınıyor: ${videoId}`);
        if (redis) await redis.del(cacheKey);
        memoryCache.delete(cacheKey);

        const freshUrl = await queue.add(async () => {
          return await resolveStreamUrlWithFallback(videoId, "audio", getRandomUA(), countryClient, true);
        });
        streamUrl = freshUrl;
        await cacheSet(cacheKey, { url: streamUrl, ua }, STREAM_CACHE_DURATION);

        response = await axiosClient({
          method: "GET",
          url: streamUrl,
          responseType: "stream",
          headers: headersOptions,
          validateStatus: (status) => status < 400,
          ...getProxyAxiosConfig({ _targetUrl: streamUrl })
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


// VIDEO STREAM (MP4) - Yüksek Hızlı Doğrudan Aktarım (Proxy Stream)
app.get("/stream/video", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId || !isValidVideoId(videoId)) return res.status(400).json({ error: "Invalid or missing videoId" });

    // DRM FAZ 2: Stream token doğrulaması
    const streamToken = req.query.token || req.headers["x-stream-token"];
    if (streamToken) {
      const tokenCheck = await validateStreamToken(streamToken, videoId);
      if (!tokenCheck.valid) {
        console.warn(`[DRM] Video token reddedildi: ${tokenCheck.reason} | videoId: ${videoId} | IP: ${req.ip}`);
        return res.status(403).json({ error: "Invalid or expired stream token", reason: tokenCheck.reason });
      }
    }

    // DRM FAZ 5: Erişim izleme & abuse tespiti
    const accessAllowed = trackStreamAccess(req.ip, videoId, "video");
    if (!accessAllowed) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }

    // DRM: Koruma header'ları
    setDrmHeaders(res);

    // ★ KATMAN 0: CLOUDFLARE R2 (Video için de en hızlı yol)
    const r2Key = `video/${videoId}.mp4`;
    try {
      const r2Data = await getR2Stream(r2Key);
      if (r2Data && r2Data.stream) {
        console.log(`[R2_VIDEO_HIT] ☁️ Video Cloudflare'den sunuluyor: ${videoId}`);
        res.setHeader("Content-Type", "video/mp4");
        if (r2Data.contentLength) res.setHeader("Content-Length", r2Data.contentLength);
        r2Data.stream.pipe(res);
        return;
      }
    } catch (r2Err) { /* R2 yoksa YouTube'a devam */ }

    const cacheKey = `stream:video:${videoId}`;
    const cachedData = await cacheGet(cacheKey);
    let streamUrl;

    if (cachedData && cachedData.url) {
      streamUrl = cachedData.url;
      console.log(`[VIDEO_CACHE_HIT] Hızlı URL kullanılıyor: ${videoId}`);
    } else {
      console.log(`[VIDEO_RESOLVE] Akıllı Algoritma ve Fallback ile YouTube'dan doğrudan hızlı URL çekiliyor: ${videoId}`);
      const ua = getRandomUA();
      const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
      const countryClient = getPlayerClientForCountry(country);

      streamUrl = await queue.add(async () => {
        return await resolveStreamUrlWithFallback(videoId, "video", ua, countryClient);
      });
      await cacheSet(cacheKey, { url: streamUrl }, STREAM_CACHE_DURATION);
    }

    const headersOptions = {
      "User-Agent": getRandomUA(),
      "Referer": "https://www.youtube.com/",
      "Accept-Encoding": "identity" // Hayati önem taşıyor: YouTube'un videoyu GZIP ile gönderip ExoPlayer'ı bozmasını engeller.
    };
    if (req.headers.range) headersOptions["Range"] = req.headers.range;

    // M3U8 kontrolüne artık gerek yok, çünkü HTTP Progressive zorladık. Fakat M3U8 gelirse direkt proxy yapıp bozulmasına izin vermemek için son güvenlik bırakılır.
    if (streamUrl.includes(".m3u8") || streamUrl.includes("manifest/")) {
      console.warn(`[STREAM_VIDEO_HLS] Zorunlu MP4 yerine M3U8 geldi! Android HlsMediaSource gerektirir. Yönlendiriliyor...`);
      return res.redirect(streamUrl);
    }

    let response;
    try {
      response = await axiosClient({
        method: "GET",
        url: streamUrl,
        responseType: "stream",
        headers: headersOptions,
        decompress: false,
        validateStatus: (status) => status < 400,
        ...getProxyAxiosConfig({ _targetUrl: streamUrl })
      });
    } catch (fetchErr) {
      // Eğer YouTube URL'sinin süresi dolmuş veya IP'ye bloke konmuşsa (403), önbelleği temizleyip anında taze kopyayı çek
      if (fetchErr.response && (fetchErr.response.status === 403 || fetchErr.response.status === 404)) {
        console.warn(`[STREAM_VIDEO] YouTube URL süresi doldu (403/404). Önbellek silinip taze link alınıyor: ${videoId}`);
        if (redis) await redis.del(cacheKey);
        memoryCache.delete(cacheKey);

        const freshUrl = await queue.add(async () => {
          return await resolveStreamUrlWithFallback(videoId, "video", getRandomUA(), req.headers["cf-ipcountry"] || "UNKNOWN", true);
        });
        streamUrl = freshUrl;
        await cacheSet(cacheKey, { url: streamUrl }, STREAM_CACHE_DURATION);

        response = await axiosClient({
          method: "GET",
          url: streamUrl,
          responseType: "stream",
          headers: headersOptions,
          decompress: false,
          validateStatus: (status) => status < 400,
          ...getProxyAxiosConfig({ _targetUrl: streamUrl })
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

  } catch (err) {
    logError("STREAM_VIDEO_PROXY", req.query.videoId, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Video streaming failed: " + err.message });
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
    console.log(`[WARMUP] Top50 cache hazır (${new Date().toLocaleTimeString()}).`);
  } catch (e) { console.warn("[WARMUP] Top50 çekimi başarısız (Kota veya hata):", e.message); }
}

// Her 50 dakikada bir arkaplanda güncelleyerek anlık gecikmelerin önüne geç (sürekli taze cache)
setInterval(warmTop50, 50 * 60 * 1000);

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

    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: "Invalid or missing videoId" });
    }

    const typeStr = req.path.includes("video") || req.path.includes("mp4") ? "video" : "audio";
    const extStr = typeStr === "audio" ? "m4a" : "mp4";
    const localFile = path.join(CACHE_DIR, `${typeStr}_${videoId}.${extStr}`);

    if (fs.existsSync(localFile)) {
      const stats = fs.statSync(localFile);
      const minSize = typeStr === "video" ? 150 * 1024 : 20 * 1024;
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

    const streamUrl = await queue.add(() =>
      resolveStreamUrlWithFallback(videoId, "audio", ua, countryClient)
    );

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Invalid stream url" });
    }

    const response = await axiosClient({
      method: "GET",
      url: streamUrl.toString().trim(),
      responseType: "stream",
      timeout: 20000,
      validateStatus: (status) => status < 400,
      ...getProxyAxiosConfig(),
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

//mp4 - GERÇEK İNDİRME: Önce diske tam indir, sonra Content-Length ile gönder
app.get("/download/mp4", async (req, res) => {
  try {
    const { videoId } = req.query;

    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: "Invalid or missing videoId" });
    }

    const typeStr = "video";
    const extStr = "mp4";
    const localFile = path.join(CACHE_DIR, `${typeStr}_${videoId}.${extStr}`);

    // 1. Disk cache kontrolü - dosya zaten varsa direkt gönder
    if (fs.existsSync(localFile)) {
      const fileStats = fs.statSync(localFile);
      const minSize = typeStr === "video" ? 150 * 1024 : 20 * 1024;
      if (fileStats.size < minSize) {
        console.warn(`[DOWNLOAD_MP4] Bozuk cache dosyası siliniyor: ${localFile}`);
        fs.unlinkSync(localFile);
      } else {
        console.log(`[DOWNLOAD_MP4] Cache hit! Dosya gönderiliyor: ${videoId} (${(fileStats.size / 1024 / 1024).toFixed(2)} MB)`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", fileStats.size);
        res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
        return res.sendFile(localFile);
      }
    }

    // 2. YÖNTEM A: yt-dlp ile doğrudan diske indir (en güvenilir — 504 timeout olmaz)
    console.log(`[DOWNLOAD_MP4] yt-dlp ile doğrudan indiriliyor: ${videoId}`);
    try {
      const downloadedFile = await ytdlpDirectDownload(videoId, "video");
      if (downloadedFile && fs.existsSync(downloadedFile)) {
        const dlStats = fs.statSync(downloadedFile);
        console.log(`[DOWNLOAD_MP4] yt-dlp başarılı! Dosya gönderiliyor: ${videoId} (${(dlStats.size / 1024 / 1024).toFixed(2)} MB)`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", dlStats.size);
        res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
        // Arka planda R2'ye yükle
        const r2Key = `video/${videoId}.mp4`;
        uploadToR2(r2Key, downloadedFile).catch(() => { });
        return res.sendFile(downloadedFile);
      }
    } catch (ytdlpErr) {
      console.warn(`[DOWNLOAD_MP4] yt-dlp başarısız: ${ytdlpErr.message}. Fallback deneniyor...`);
    }

    // 3. YÖNTEM B: URL çözümle + axios ile diske indir (yedek)
    console.log(`[DOWNLOAD_MP4] Fallback: URL çözümlenip diske indiriliyor: ${videoId}`);
    const ua = getRandomUA();
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
    const countryClient = getPlayerClientForCountry(country);

    const streamUrl = await queue.add(() =>
      resolveStreamUrlWithFallback(videoId, "video", ua, countryClient)
    );

    if (!streamUrl || !streamUrl.toString().startsWith("http")) {
      return res.status(500).json({ error: "Video URL çözümlenemedi" });
    }

    const fallbackTempFile = localFile + ".fallback.tmp";
    const response = await axiosClient({
      method: "GET",
      url: streamUrl.toString().trim(),
      responseType: "stream",
      timeout: 300000,
      headers: {
        "User-Agent": ua,
        "Referer": "https://www.youtube.com/"
      },
      validateStatus: (status) => status < 400,
      ...getProxyAxiosConfig()
    });

    const writer = fs.createWriteStream(fallbackTempFile);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    if (!fs.existsSync(fallbackTempFile)) {
      return res.status(500).json({ error: "Dosya indirilemedi" });
    }

    const fallbackStats = fs.statSync(fallbackTempFile);
    if (fallbackStats.size < 150 * 1024) {
      fs.unlinkSync(fallbackTempFile);
      return res.status(500).json({ error: "İndirilen dosya çok küçük, muhtemelen bot algılaması" });
    }

    fs.renameSync(fallbackTempFile, localFile);
    console.log(`[DOWNLOAD_MP4] Fallback başarılı! Dosya gönderiliyor: ${videoId} (${(fallbackStats.size / 1024 / 1024).toFixed(2)} MB)`);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", fallbackStats.size);
    res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
    return res.sendFile(localFile);

  } catch (err) {
    logError("DOWNLOAD_MP4", req.query.videoId, err.message);
    console.error("MP4 ERROR:", err.message);
    // Fallback temp dosyasını temizle
    const tempCleanup = path.join(CACHE_DIR, `video_${req.query.videoId}.mp4.fallback.tmp`);
    if (fs.existsSync(tempCleanup)) {
      try { fs.unlinkSync(tempCleanup); } catch (e) { }
    }
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

    const maxSizeBytes = 350 * 1024 * 1024; // 350 MB
    const targetSizeBytes = 250 * 1024 * 1024; // 250 MB'a düşür

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