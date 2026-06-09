require("dotenv").config();

/* =========================
   GÜVENLİK: Zorunlu env değişkenleri
========================= */
const APP_SECRET = process.env.APP_KEY;
if (!APP_SECRET) {
  console.error("[FATAL] APP_KEY env var tanımlı değil! Sunucu güvenli başlatılamaz.");
  console.error("Çözüm: .env dosyasına APP_KEY=your_secret_here ekleyin veya PM2 ile APP_KEY tanımlayın.");
  process.exit(1);
}
const BAZOCAM_PASS_ENV = process.env.BAZOCAM_PASS || "";
if (!BAZOCAM_PASS_ENV) {
  console.warn("[WARNING] BAZOCAM_PASS env var tanımlı değil! Bazocam API çağrıları çalışmayacak.");
}
const ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) {
  console.error("[SECURITY] ADMIN_PASS env değişkeni zorunludur! .env dosyasına ekleyin.");
  process.exit(1);
}
const basicAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Secure Area"');
    return res.status(401).send('Authentication required');
  }
  const authData = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  if (authData[0] === 'admin' && authData[1] === ADMIN_PASS) {
    return next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Secure Area"');
    return res.status(401).send('Authentication required');
  }
};

/* =========================
   CRASH PROTECTION — PM2 otomatik restart yapar
========================= */
process.on("uncaughtException", (err) => {
  console.error(`[FATAL] Yakalanmamış hata: ${err.message}`);
  console.error(err.stack);
  // Bozuk state'te çalışmak yerine PM2'nin yeniden başlatmasını sağla
  try {
    const shutdownTimer = setTimeout(() => process.exit(1), 5000);
    shutdownTimer.unref();
    if (typeof server !== 'undefined' && server.close) {
      server.close(() => process.exit(1));
    } else {
      process.exit(1);
    }
  } catch (e) {
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(`[FATAL] İşlenmeyen Promise hatası (sunucu ÇÖKMEDEN kurtarıldı):`, reason);
});

// PM2 Cluster: Worker ID — periyodik görevler sadece worker 0'da çalışsın (4x tekrar önlenir)
const WORKER_ID = parseInt(process.env.NODE_APP_INSTANCE || process.env.pm_id || "0");
const isPrimaryWorker = WORKER_ID === 0;

// Proxy URL'deki şifreyi maskele (loglara şifre yazılmasın)
function maskProxyUrl(url) {
  if (!url) return url;
  try { return url.replace(/:([^:@]+)@/, ':***@'); } catch { return '***'; }
}

// Güvenli pipe: stream hata handler'ı ekler (FD leak önler)
function safePipe(source, dest) {
  source.on('error', (err) => {
    console.error('[SAFE_PIPE] Source error:', err.message);
    if (!dest.destroyed) dest.end();
  });
  dest.on('error', (err) => {
    console.error('[SAFE_PIPE] Dest error:', err.message);
    if (!source.destroyed) source.destroy();
  });
  dest.on('close', () => {
    if (!source.destroyed) source.destroy();
  });
  return source.pipe(dest);
}

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
const Bull = require("bull");
const { Innertube, UniversalCache } = require("youtubei.js");

// FFmpeg Worker & Media Library
const ffmpegWorker = require("./ffmpeg_worker");
const mediaLib = require("./media_library");

/* =========================
   ANTI-BOT FAZ 1: COOKIE & PROXY ROTASYONU
   yt_cookies/ klasörüne koyduğunuz tüm .txt dosyaları otomatik algılanır.
   proxies.txt dosyasındaki proxy adresleri rotasyona sokulur.
   Klasör/dosya boşsa mevcut cookies.txt ve PROXY_URL kullanılır.
========================= */
let cookiePool = [];
let proxyPool = [];

// PROXY PANEL VERİTABANI (Enhanced v2)
const PROXY_DATA_FILE = path.join(__dirname, "proxy_data.json");
let proxyData = { active: [], banned: [], banHistory: [], lastHealthCheck: null };

function loadProxyData() {
  try {
    if (!fs.existsSync(PROXY_DATA_FILE)) {
      fs.writeFileSync(PROXY_DATA_FILE, JSON.stringify({ active: [], banned: [], banHistory: [], lastHealthCheck: null }));
    }
    proxyData = JSON.parse(fs.readFileSync(PROXY_DATA_FILE, "utf-8"));
    // Migration: eski format → yeni format
    if (!proxyData.banHistory) proxyData.banHistory = [];
    if (!proxyData.lastHealthCheck) proxyData.lastHealthCheck = null;
    // Her proxy'ye istatistik alanları ekle (migration)
    for (const p of proxyData.active) {
      if (!p.successCount) p.successCount = 0;
      if (!p.failCount) p.failCount = 0;
      if (!p.lastUsed) p.lastUsed = null;
      if (!p.lastTested) p.lastTested = null;
      if (!p.latencyMs) p.latencyMs = null;
      if (!p.banCount) p.banCount = 0;
      if (!p.testResult) p.testResult = null;
    }
  } catch (e) {
    console.error("[PROXY_DB] Okuma hatası:", e.message);
  }
}

function saveProxyData() {
  try {
    // Ban geçmişini max 100 kayıtta tut
    if (proxyData.banHistory && proxyData.banHistory.length > 100) {
      proxyData.banHistory = proxyData.banHistory.slice(-100);
    }
    fs.writeFileSync(PROXY_DATA_FILE, JSON.stringify(proxyData, null, 2));
  } catch (e) {
    console.error("[PROXY_DB] Yazma hatası:", e.message);
  }
}

// Proxy kullanım istatistiklerini güncelle (bellekte, diske periyodik yaz)
let proxyDataDirty = false;
function trackProxyUsage(proxyIp, success) {
  const proxy = proxyData.active.find(p => p.ip === proxyIp);
  if (proxy) {
    if (success) proxy.successCount = (proxy.successCount || 0) + 1;
    else proxy.failCount = (proxy.failCount || 0) + 1;
    proxy.lastUsed = new Date().toISOString();
    proxyDataDirty = true; // Diske yazma bekletilir
  }
}
// Proxy verisini 30 saniyede bir diske yaz (sadece primary worker — cluster race condition önlemi)
if (isPrimaryWorker) {
  setInterval(() => {
    if (proxyDataDirty) {
      saveProxyData();
      proxyDataDirty = false;
    }
  }, 30000);
}

// Proxy sağlık skoru hesapla (%)
function getProxyHealthScore(proxy) {
  const total = (proxy.successCount || 0) + (proxy.failCount || 0);
  if (total === 0) return 100; // henüz kullanılmamış
  return Math.round(((proxy.successCount || 0) / total) * 100);
}

// Otomatik unban (6 saat süresi dolanları aktife al)
function autoUnbanProxies() {
  let changed = false;
  const now = Date.now();
  for (let i = proxyData.banned.length - 1; i >= 0; i--) {
    const proxy = proxyData.banned[i];
    if (now > new Date(proxy.auto_unban_at).getTime()) {
      proxyData.active.push({ ip: proxy.ip, added: new Date().toISOString(), successCount: 0, failCount: 0, lastUsed: null, lastTested: null, latencyMs: null, banCount: proxy.banCount || 0, testResult: null });
      proxyData.banHistory.push({ ip: proxy.ip, action: "auto_unban", time: new Date().toISOString() });
      proxyData.banned.splice(i, 1);
      changed = true;
    }
  }
  if (changed) saveProxyData();
}

// setInterval(runHealthCheck, 30 * 60 * 1000);
// Sunucu açıldıktan 1 dakika sonra ilk health check (KOTA DOSTU: Kapatıldı)
// setTimeout(runHealthCheck, 60 * 1000);

function loadRotationAssets() {
  try {
    // Cookie havuzunu yükle
    const cookieDir = path.join(__dirname, "yt_cookies");
    if (!fs.existsSync(cookieDir)) fs.mkdirSync(cookieDir, { recursive: true });
    const cookieFiles = fs.readdirSync(cookieDir).filter(f => f.endsWith(".txt"));
    cookiePool = cookieFiles.map(f => path.join(cookieDir, f));

    // Proxy havuzunu PHP panel verisinden yükle
    loadProxyData();
    autoUnbanProxies();

    // Eski proxies.txt varsa onları da aktife ekle (migrasyon)
    const proxyFile = path.join(__dirname, "proxies.txt");
    if (fs.existsSync(proxyFile)) {
      const content = fs.readFileSync(proxyFile, "utf-8");
      const oldProxies = content.split("\n").map(l => l.trim()).filter(l => l.length > 5);
      let migrated = false;
      for (let p of oldProxies) {
        if (!p.startsWith("http")) p = "http://" + p;
        if (!proxyData.active.find(x => x.ip === p) && !proxyData.banned.find(x => x.ip === p)) {
          proxyData.active.push({ ip: p, added: new Date().toISOString(), successCount: 0, failCount: 0, lastUsed: null, lastTested: null, latencyMs: null, banCount: 0, testResult: null });
          migrated = true;
        }
      }
      if (migrated) {
        saveProxyData();
        console.log(`[ROTATION] proxies.txt dosyasından ${oldProxies.length} proxy aktarıldı.`);
        // Dosyayı silmiyoruz ki kullanıcı her eklediğinde tekrar alabilsin (isteğe bağlı)
        // fs.unlinkSync(proxyFile); 
      }
    }

    proxyPool = proxyData.active.map(p => p.ip);
    console.log(`[ROTATION] Yüklendi: ${cookiePool.length} cookie dosyası, ${proxyPool.length} aktif proxy adresi`);
  } catch (e) {
    console.warn("[ROTATION] Asset yükleme hatası:", e.message);
  }
}

function getRandomCookie() {
  if (cookiePool.length > 0) return cookiePool[Math.floor(Math.random() * cookiePool.length)];
  return fs.existsSync(path.join(__dirname, "cookies.txt")) ? path.join(__dirname, "cookies.txt") : null;
}

function banProxy(ip) {
  loadProxyData();
  const index = proxyData.active.findIndex(p => p.ip === ip || p.ip === `http://${ip}` || `http://${p.ip}` === ip);
  if (index !== -1) {
    const proxy = proxyData.active[index];
    proxyData.active.splice(index, 1);
    proxyData.banned.push({
      ip: proxy.ip,
      banned_at: new Date().toISOString(),
      auto_unban_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(), // 6 Saat
      banCount: (proxy.banCount || 0) + 1,
      reason: "auto_403_429"
    });
    // Ban geçmişine kaydet
    if (!proxyData.banHistory) proxyData.banHistory = [];
    proxyData.banHistory.push({ ip: proxy.ip, action: "ban", reason: "403/429", time: new Date().toISOString() });
    saveProxyData();
    // Havuzu hemen güncelle
    proxyPool = proxyData.active.map(p => p.ip);
    console.log(`[PROXY_BAN] Proxy banlandi: ${ip} (6 saat)`);
  }
}

function getRandomProxy(videoId = null) {
  // Havuzda proxy varsa rastgele seç, yoksa null
  let proxyStr = null;
  if (proxyPool.length > 0) {
    if (videoId) {
      let hash = 0;
      for (let i = 0; i < videoId.length; i++) hash += videoId.charCodeAt(i);
      proxyStr = proxyPool[hash % proxyPool.length];
    } else {
      proxyStr = proxyPool[Math.floor(Math.random() * proxyPool.length)];
    }
  }

  // Protokol ekle (http:// yoksa)
  if (
  proxyStr &&
  !proxyStr.startsWith("http://") &&
  !proxyStr.startsWith("https://") &&
  !proxyStr.startsWith("socks5://")
) {
  proxyStr = "http://" + proxyStr;
}
  return proxyStr;
}

// Başlangıçta yükle + her 5 dakikada bir unban kontrolü yap
loadRotationAssets();
if (isPrimaryWorker) setInterval(loadRotationAssets, 5 * 60 * 1000);

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

//  ÇAKIŞMA ÖNLEYİCİ (Aynı anda birden fazla yt-dlp çalışmasını engeller)
const ongoingResolutions = new Map();

// Takılı kalan resolution'ları temizle (2 dakikadan eski olanlar) + hard cap
setInterval(() => {
  const now = Date.now();
  // Hard cap: 5000'den fazla entry birikirse en eskileri sil
  if (ongoingResolutions.size > 5000) {
    const keys = Array.from(ongoingResolutions.keys());
    for (let i = 0; i < keys.length - 2500; i++) ongoingResolutions.delete(keys[i]);
    console.warn(`[RESOLUTION_CLEANUP] Hard cap: ${keys.length} → 2500`);
  }
  for (const [key, val] of ongoingResolutions) {
    if (val._startedAt && now - val._startedAt > 120000) {
      ongoingResolutions.delete(key);
      console.warn(`[RESOLUTION_CLEANUP] Takılı resolution temizlendi: ${key}`);
    }
  }
}, 30000);

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

    console.log("[WARMUP] Hesap ısıtma rutini tamamlandı ");
  } catch (e) {
    console.warn("[WARMUP] Isıtma başarısız (önemsiz, sistem etkilenmez):", e.message);
  }
}

// İlk ısıtma: sunucu açıldıktan 15 dakika sonra (hemen başlamamak daha doğal)
if (isPrimaryWorker) {
  setTimeout(warmupAccount, 15 * 60 * 1000);
  setInterval(warmupAccount, 48 * 60 * 60 * 1000);
}

// YouTube istek kuyruğu — Çoklu kullanım ölçeği:
// concurrency: 12 → aynı anda 12 paralel YouTube çözümleme
// intervalCap: 8/1s → saniyede max 8 istek (YouTube ban eşiğinin altında)
// timeout: 30s → takılan bir resolve tüm kuyruğu bloke etmesin
const queue = new PQueue({
  concurrency: 50,      // 50 paralel çözümleme — Bull Queue zaten 264 paralel yönetiyor
  timeout: 120000,      // 120 saniye timeout
  throwOnTimeout: true
});
// Kuyruk izleme — yoğunluk uyarısı (eşik artırıldı)
setInterval(() => {
  if (queue.size > 50) {
    console.warn(`[QUEUE_WARNING] YouTube kuyruğu yoğun: ${queue.size} bekleyen, ${queue.pending} aktif`);
  }
}, 30000);

//  VIDEO ID DOĞRULAMA (Path traversal ve injection koruması)
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
const R2_MAX_SIZE = 9 * 1024 * 1024 * 1024; // 9GB — R2 free tier (10GB, 1GB tampon). Ana depo kendi diskimiz
const R2_CLEANUP_DAYS = 60; // 60 gün dinlenmemiş şarkıları sil (free tier'da yer açmak için)

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

// R2 ERİŞİM TAKİBİ: Her dinlemede son erişim zamanını Redis'e kaydet
async function trackR2Access(key) {
  try {
    if (redis) {
      await redis.hset("r2:last_access", key, Date.now().toString());
    }
  } catch (err) { /* sessizce devam */ }
}

//  R2 OTOMATİK TEMİZLEYİCİ: 30 gündür dinlenmeyen şarkıları siler
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
    // GÜVENLİK: Redis bağlı değilse temizlik yapma — erişim geçmişi olmadan
    // tüm dosyalar "hiç erişilmemiş" görünür ve yanlışlıkla silinir.
    if (!redis) {
      console.warn("[R2_CLEANUP] Redis bağlı değil, temizlik atlandı (veri kaybı önlendi).");
      return;
    }
    let lastAccessMap = {};
    try {
      lastAccessMap = await redis.hgetall("r2:last_access") || {};
    } catch (redisErr) {
      console.warn("[R2_CLEANUP] Redis okuma hatası, temizlik atlandı:", redisErr.message);
      return;
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

// Her 6 saatte bir otomatik temizlik (sadece primary worker)
if (isPrimaryWorker) {
  setInterval(cleanupR2, 6 * 60 * 60 * 1000);
  setTimeout(cleanupR2, 2 * 60 * 1000);
}

/* =========================
   PHASE 6: DISK CACHING
   Tüm cache dosyaları tek bir yerde: /app/media/ altında
   FFmpeg kalıcı dosyaları ve stream cache aynı dizinde toplanır
========================= */
const MEDIA_BASE = process.env.MEDIA_DIR || "/app/media";
const CACHE_DIR = path.join(MEDIA_BASE, "audio"); // M4A audio cache → /app/media/audio/
const VIDEO_CACHE_DIR = path.join(MEDIA_BASE, "video"); // MP4 video cache → /app/media/video/
[CACHE_DIR, VIDEO_CACHE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
const MAX_CACHE_SIZE = 125 * 1024 * 1024 * 1024; // 125GB — Contabo VPS (145GB disk), 20GB sisteme kalır

// Async disk temizleme — event loop'u bloke etmez
async function checkDiskSpaceAndCleanup() {
  try {
    const allDirs = [CACHE_DIR, VIDEO_CACHE_DIR];
    let allFiles = [];
    const now = Date.now();

    for (const dir of allDirs) {
      try { await fs.promises.access(dir); } catch { continue; }
      const entries = await fs.promises.readdir(dir);
      for (const f of entries) {
        const p = path.join(dir, f);
        try {
          const stat = await fs.promises.stat(p);
          allFiles.push({ path: p, stat, name: f });
        } catch (_) { /* dosya silinmiş olabilir */ }
      }

      // Temp dosyaları temizle
      for (const file of allFiles) {
        if ((file.path.endsWith('.tmp') || file.path.endsWith('.ytdl') || file.path.includes('.part') || file.path.includes('.fallback')) && (now - file.stat.mtimeMs > 10 * 60 * 1000)) {
          try { await fs.promises.unlink(file.path); console.log(`[DISK_CLEANUP] Eski temp silindi: ${file.path}`); } catch (e) { }
        }
      }
    }

    const totalSize = allFiles.reduce((acc, f) => acc + f.stat.size, 0);
    if (totalSize > MAX_CACHE_SIZE) {
      console.log(`[DISK_CLEANUP] Disk doluyor (${(totalSize / 1024 / 1024 / 1024).toFixed(1)} GB). Temizleniyor...`);
      const finishedFiles = allFiles.filter(f => f.name.endsWith('.mp4') || f.name.endsWith('.m4a') || f.name.endsWith('.mp3'));
      finishedFiles.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
      let deletedSize = 0;
      const targetToDelete = totalSize - (MAX_CACHE_SIZE * 0.7);
      for (const file of finishedFiles) {
        if (deletedSize >= targetToDelete) break;
        try { await fs.promises.unlink(file.path); deletedSize += file.stat.size; } catch (e) { }
      }
      console.log(`[DISK_CLEANUP] ${(deletedSize / 1024 / 1024).toFixed(1)} MB yer açıldı.`);
    }
  } catch (err) { console.error(`[DISK_CLEANUP] Hata: ${err.message}`); }
}
if (isPrimaryWorker) setInterval(checkDiskSpaceAndCleanup, 60 * 1000);
const downloadingFiles = new Set();

// 403 durumunda yeni stream URL almak için helper
async function getFreshStreamUrl(videoId, type) {
  // Eski cache'i temizle (403 almış URL'yi sil)
  try {
    if (redis) await redis.del(`stream:${type}:${videoId}`);
    // memoryCache kaldırıldı — Redis zorunlu, sadece redis.del yeterli
  } catch (_) { }

  // 1) Youtubei ile dene
  try {
    const url = await resolveWithYoutubei(videoId, type);
    if (url) {
      console.log(`[FRESH_URL] Youtubei ile yeni URL alındı: ${videoId}`);
      return url;
    }
  } catch (_) { }

  // 2) yt-dlp ile dene (daha güvenilir)
  try {
    const ua = getRandomUA();
    const format = type === "audio" ? "bestaudio[ext=m4a]/bestaudio" : "bestvideo[ext=mp4]/bestvideo";
    const url = await resolveStreamUrl(`https://www.youtube.com/watch?v=${videoId}`, format, ua);
    if (url) {
      console.log(`[FRESH_URL] yt-dlp ile yeni URL alındı: ${videoId}`);
      return url;
    }
  } catch (_) { }

  return null;
}

async function downloadToCache(videoId, type, streamUrl, ua = null) {
  const ext = type === "audio" ? "m4a" : "mp4";
  const fileName = `${type}_${videoId}.${ext}`;
  const targetDir = type === "video" ? VIDEO_CACHE_DIR : CACHE_DIR;
  const filePath = path.join(targetDir, fileName);
  const tempPath = filePath + ".tmp";

  if (fs.existsSync(filePath) || downloadingFiles.has(fileName)) return;

  downloadingFiles.add(fileName);
  try {
    await _downloadToCacheAttempt(videoId, type, streamUrl, ua, tempPath, filePath, fileName);
  } catch (err) {
    // 403 = URL süresi dolmuş → yeni URL al, tekrar dene
    if (err.message && err.message.includes("403")) {
      try {
        console.log(`[DISK_CACHE] 403 aldı, yeni URL alınıyor: ${videoId}`);
        const freshUrl = await getFreshStreamUrl(videoId, type);
        if (freshUrl) {
          await _downloadToCacheAttempt(videoId, type, freshUrl, ua, tempPath, filePath, fileName);
        } else {
          console.log(`[DISK_CACHE_ERR] ${fileName} yeni URL alınamadı`);
        }
      } catch (retryErr) {
        console.log(`[DISK_CACHE_ERR] ${fileName} retry başarısız: ${retryErr.message}`);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    } else {
      console.log(`[DISK_CACHE_ERR] ${fileName} indirilemedi: ${err.message}`);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  } finally {
    downloadingFiles.delete(fileName);
  }
}

async function _downloadToCacheAttempt(videoId, type, streamUrl, ua, tempPath, filePath, fileName) {
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
  safePipe(response.data, writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', (err) => {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch(e) {}
      reject(err);
    });
  });

  fs.renameSync(tempPath, filePath);

  // Final kontrol: Eğer dosya çok küçükse kaydetme, sil!
  const ext = type === "audio" ? "m4a" : "mp4";
  const stats = fs.statSync(filePath);
  const minSize = type === "video" ? 150 * 1024 : 20 * 1024;
  if (stats.size < minSize) {
    fs.unlinkSync(filePath);
    throw new Error(`Download successful but file too small (${(stats.size / 1024).toFixed(1)} KB) - likely bot detection.`);
  }

  console.log(`[DISK_CACHE] Kaydedildi: ${fileName} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  // Arka planda R2'ye de yükle (kalıcı bulut cache)
  const r2Key = `${type}/${videoId}.${ext}`;
  uploadToR2(r2Key, filePath).catch(() => { });
}

// Gereksiz ikinci disk silici temizlendi.

/* =========================
   ERROR LOGGING & CIRCUIT BREAKER
========================= */

function logError(type, videoId, errorMessage) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] - [${type}] - VideoID: ${videoId || "N/A"} - Error: ${errorMessage}\n`;
  console.error(logLine.trim());
  // Asenkron yazım — event loop'u bloke etmez
  fs.appendFile(path.join(__dirname, "error.log"), logLine, () => {});
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
// REDIS ZORUNLU KILINDI: Bellek sızıntılarını önlemek için in-memory fallback tamamen kaldırıldı.
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null, // Sürekli denemeye devam et
  retryStrategy: (times) => {
    console.warn(`[Redis] Yeniden bağlanılıyor... Deneme: ${times}`);
    return Math.min(times * 1000, 5000); // Max 5 saniyede bir dene
  },
  enableOfflineQueue: true // Redis kapalıysa istekleri sıraya al (hata fırlatmak yerine)
});

redis.on("error", (err) => {
  console.error("[Redis] KRİTİK HATA! Redis bağlantısı koptu. Sistem kararlılığı tehlikede:", err.message);
});

redis.on("connect", () => {
  console.log("[Redis] Bağlantı başarılı! Sisteme güvenli cache sağlandı.");
});

// Cache helper fonksiyonları
async function cacheGet(key) {
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch (e) {
    console.error(`[Redis] Okuma hatası (${key}):`, e.message);
    return null;
  }
}

async function cacheSet(key, data, ttlSeconds) {
  try {
    await redis.set(key, JSON.stringify(data), "EX", ttlSeconds);
  } catch (e) {
    console.error(`[Redis] Yazma hatası (${key}):`, e.message);
  }
}

// ==================== BULL QUEUE — Dağıtık Worker Desteği ====================
// Worker'lar ayrı process olarak çalışır (resolve_worker.js)
// Bu queue'ya iş ekle → worker çözer → sonucu Redis'e yazar → biz okuruz
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const resolveQueue = new Bull("resolve-stream", REDIS_URL, {
  defaultJobOptions: {
    timeout: 45000,
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 2,
    backoff: { type: "fixed", delay: 2000 }
  }
});

// Worker yoksa veya Bull hata verirse fallback olarak eski sistemi kullan
let bullWorkerAvailable = false;
let bullCheckInterval;

async function checkBullWorkers() {
  try {
    const workers = await resolveQueue.getWorkers();
    const wasAvailable = bullWorkerAvailable;
    bullWorkerAvailable = workers && workers.length > 0;
    if (bullWorkerAvailable && !wasAvailable) {
      console.log(`[BULL] ✅ ${workers.length} worker bağlandı! Dağıtık mod aktif.`);
    } else if (!bullWorkerAvailable && wasAvailable) {
      console.log(`[BULL] ⚠️ Worker bağlantısı kesildi. Fallback: lokal mod.`);
    }
  } catch (e) {
    bullWorkerAvailable = false;
  }
}
// Her 10 saniyede worker durumunu kontrol et
bullCheckInterval = setInterval(checkBullWorkers, 10000);
setTimeout(checkBullWorkers, 3000); // 3sn sonra ilk kontrol

/**
 * Bull Queue üzerinden URL çözümleme
 * Worker varsa → Bull'a gönder, sonucu bekle
 * Worker yoksa → null döner (caller eski sistemi kullanır)
 */
async function resolveViaBull(videoId, type, priority = 0) {
  if (!bullWorkerAvailable) return null;

  try {
    // Önce Redis cache kontrol (job göndermeden)
    const cacheKey = `stream:${type}:${videoId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached);
      if (data && data.url) return data.url;
    }

    // Bull'a iş gönder
    const job = await resolveQueue.add(
      { videoId, type, priority },
      { priority: priority === 1 ? 1 : (priority === 0 ? 5 : 10), timeout: 45000 }
    );

    // Sonucu bekle (max 40sn)
    const result = await job.finished();
    if (result && result.url) {
      console.log(`[BULL] ✅ ${videoId} çözüldü (${result.source}, ${result.time}ms)`);
      return result.url;
    }
    return null;
  } catch (e) {
    console.warn(`[BULL] ❌ Job başarısız: ${videoId} — ${e.message}`);
    return null; // Fallback: eski sistem
  }
}

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

// Fallback player client stratejisi: android_vr → default → android → web
// android_vr: Cookie'siz çalışır, YouTube bot tespiti düşük (VR cihaz simülasyonu)
const PLAYER_CLIENTS = ["android", "android_vr"];

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

// yt-dlp eşzamanlılık limiti — PM2 cluster'da 4 worker x 8 = 32 toplam process
let activeYtdlpCount = 0;
const MAX_YTDLP_CONCURRENT = 4;  // Worker başına 4 (4 worker = 16 toplam)
const MAX_YTDLP_QUEUE = 150;     // Büyük kuyruk — bekletsin, düşürmesin
const YTDLP_SLOT_TIMEOUT = 90000; // 90sn — kuyrukta sabırla beklesin
const ytdlpWaitQueue = [];

function acquireYtdlpSlot() {
  return new Promise((resolve, reject) => {
    if (activeYtdlpCount < MAX_YTDLP_CONCURRENT) {
      activeYtdlpCount++;
      resolve();
    } else if (ytdlpWaitQueue.length >= MAX_YTDLP_QUEUE) {
      reject(new Error("yt-dlp queue full, try again later"));
    } else {
      const timer = setTimeout(() => {
        const idx = ytdlpWaitQueue.findIndex(item => item.resolve === resolve);
        if (idx > -1) ytdlpWaitQueue.splice(idx, 1);
        reject(new Error("yt-dlp slot timeout"));
      }, YTDLP_SLOT_TIMEOUT);
      ytdlpWaitQueue.push({ resolve: () => { clearTimeout(timer); resolve(); } });
    }
  });
}

function releaseYtdlpSlot() {
  if (ytdlpWaitQueue.length > 0) {
    const next = ytdlpWaitQueue.shift();
    next.resolve(); // Yeni format: { resolve: fn }
  } else {
    activeYtdlpCount = Math.max(0, activeYtdlpCount - 1);
  }
}

function ytdlpStream(videoId, type, req, res) {
  return new Promise(async (resolve, reject) => {
    await acquireYtdlpSlot();
    const ext = type === "audio" ? "m4a" : "mp4";
    const format = type === "audio" ? "bestaudio[ext=m4a]/bestaudio" : "best[ext=mp4]/best";
    const targetDir = type === "video" ? VIDEO_CACHE_DIR : CACHE_DIR;
    const outputFile = path.join(targetDir, `${type}_${videoId}.${ext}`);
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
    const streamProxy = getRandomProxy(videoId);
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

    let slotReleased = false;
    function safeReleaseSlot() {
      if (!slotReleased) { slotReleased = true; releaseYtdlpSlot(); }
    }

    ytdlpProc.on("close", (code) => {
      safeReleaseSlot();
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
      if (ytdlpProc && !ytdlpProc.killed) {
        ytdlpProc.kill('SIGTERM');
        setTimeout(() => { if (!ytdlpProc.killed) ytdlpProc.kill('SIGKILL'); }, 5000);
      }
      cacheWriter.end();
      safeReleaseSlot(); // Client kopunca slot'u serbest bırak
      setTimeout(() => {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch(e) {}
      }, 1000);
    });
  });
}

function ytdlpDirectDownload(videoId, type) {
  return new Promise(async (resolve, reject) => {
    await acquireYtdlpSlot();
    const ext = type === "audio" ? "m4a" : "mp4";
    // Video için: en iyi video+audio birleştir, yoksa hazır birleşik al
    const format = type === "audio"
      ? "bestaudio[ext=m4a]/bestaudio"
      : "b[ext=mp4][height<=720]/best[ext=mp4]/b/best";
    const dlTargetDir = type === "video" ? VIDEO_CACHE_DIR : CACHE_DIR;
    const outputFile = path.join(dlTargetDir, `${type}_${videoId}.${ext}`);
    const tempFile = path.join(dlTargetDir, `temp_${videoId}.${ext}`);

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
      "--remote-components", "ejs:github",
      "--extractor-args", "youtube:player_client=android_vr"
    ];

    // Cookie Rotasyonu 
    const dlCookie = getRandomCookie();
    if (process.env.USE_COOKIES !== "false" && dlCookie) {
      args.push("--cookies", dlCookie);
    }

    // Proxy Rotasyonu 
    const dlProxy = getRandomProxy(videoId);

    console.log("[PROXY_TEST]", maskProxyUrl(dlProxy));

    if (dlProxy) {
      args.push("--proxy", dlProxy);
    }

    console.log(`[YTDL_DIRECT] İndiriliyor: ${videoId} (${type})`);

    const proc = execFile(ytdlpBin, args, {
      timeout: 900000, // 15 dakika (büyük videolar için)
      maxBuffer: 50 * 1024 * 1024
    }, (error, stdout, stderr) => {
      releaseYtdlpSlot();

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

  let clientsToTry = ["android_vr", "android"];
  if (countryClient && countryClient !== "default") {
    clientsToTry = [countryClient, ...clientsToTry.filter(c => c !== countryClient)];
  }

  for (const client of clientsToTry) {
    // İki deneme: önce proxy ile, proxy 402 verirse proxy'siz
    for (const useProxy of [true, false]) {
      let currentProxy = null;
      try {
        const opts = {
          format: format,
          getUrl: true,
          addHeader: [
            "referer:https://www.youtube.com/",
            `user-agent:${ua}`
          ]
        };

        // Cookie Rotasyonu — android_vr cookie'siz çalışır, göndermiyoruz
        if (client !== "android_vr") {
          const useCookies = process.env.USE_COOKIES !== "false";
          const resolveCookie = getRandomCookie();
          if (useCookies && resolveCookie) {
            opts.cookies = resolveCookie;
          }
        }

        // Proxy Rotasyonu — 402 aldıysa proxy'siz dene
        if (useProxy) {
          const vIdMatch = videoUrl.match(/v=([^&]+)/);
          const vId = vIdMatch ? vIdMatch[1] : null;
          const resolveProxy = getRandomProxy(vId);
          if (resolveProxy) {
            opts.proxy = resolveProxy;
            currentProxy = resolveProxy; // Banlama ihtimali için kaydet
          } else {
            // Havuzda proxy yok — proxy'siz denemeye atla (null proxy ile çalışma!)
            console.log(`[yt-dlp] Proxy havuzu boş, proxy'siz deneniyor...`);
            continue;
          }
        } else {
          console.log(`[yt-dlp] Proxy'siz deneniyor (proxy kotası bitmiş olabilir)`);
        }

        // "default" = yt-dlp kendi seçsin
        if (client !== "default") {
          opts.extractorArgs = `youtube:player_client=${client}`;
        }

        console.log(`[yt-dlp] Deneniyor: client=${client}, format=${format}${useProxy ? '' : ' (NO PROXY)'}`);
        console.log("PROXY TEST:", maskProxyUrl(opts.proxy));
        const result = await ytdlp(videoUrl, opts, { timeout: 30000, env: { ...process.env, PATH: '/usr/local/bin:' + (process.env.PATH || '') } });
        const url = result.toString().trim();

        if (url && url.startsWith("http")) {
          console.log(`[yt-dlp] Başarılı: client=${client}${useProxy ? '' : ' (proxy-siz)'}`);
          ytDlpFailCount = 0; // reset on success
          stats.ytDlpSuccess++;
          return url;
        }
      } catch (err) {
        const errMsg = (err.stderr || err.message || '').toString();
        // Proxy 402 (kota bitmiş) hatası → proxy'yi panelden otomatik banla ve proxy'siz tekrar dene
        if (useProxy && (errMsg.includes('402') || errMsg.includes('Payment Required') || errMsg.includes('Unable to connect to proxy') || errMsg.includes('407') || errMsg.includes('Proxy Authentication Required') || errMsg.includes('429') || errMsg.includes('Sign in to confirm'))) {
          console.warn(`[PROXY_UYARISI] 🚨 PROXY BANLANDI VEYA BİTTİ: ${maskProxyUrl(currentProxy)}`);
          if (currentProxy) banProxy(currentProxy); // Panelde 6 saat banla
          console.warn(`[yt-dlp] Proxy hatası (402/407/429). Proxy'siz deneniyor...`);
          continue; // useProxy=false döngüsüne geç
        }
        console.warn(`[yt-dlp] client=${client} başarısız:`, err.stderr || err.message);
        lastError = err;
        break; // proxy'siz de deneme, bir sonraki client'a geç
      }
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
if (isPrimaryWorker) {
  setTimeout(refreshPipedInstances, 5000);
  setInterval(refreshPipedInstances, 30 * 60 * 1000);
}

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
if (isPrimaryWorker) {
  setTimeout(refreshInvidiousInstances, 6000);
  setInterval(refreshInvidiousInstances, 30 * 60 * 1000);
}

async function fetchFromPiped(endpointPath) {
  let lastError = null;
  // Sunucu sırasını karıştır — ölü sunucuya sürekli denk gelmeyi önle
  const shuffled = [...PIPED_INSTANCES].sort(() => Math.random() - 0.5);
  for (const instance of shuffled) {
    try {
      const res = await axiosClient.get(`${instance}${endpointPath}`, { timeout: 1500 });
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
    axiosClient.get(`${instance}${endpointPath}`, { timeout: 1500 })
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
      const res = await axiosClient.get(`${instance}/api/v1/videos/${videoId}`, { timeout: 1500 });
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
  // ═══ DAĞITIK WORKER DESTEĞİ ═══
  // Bull worker varsa → işi worker'a gönder (yatay ölçekleme)
  // Worker yoksa → eski lokal sistem devam eder
  if (bullWorkerAvailable) {
    try {
      const bullResult = await resolveViaBull(videoId, type, 1);
      if (bullResult) return bullResult;
      // Bull başarısız → fallback: lokal çözümleme
      console.log(`[BULL_FALLBACK] ${videoId} worker'da çözülemedi, lokal deneniyor...`);
    } catch (e) {
      console.warn(`[BULL_FALLBACK] ${videoId} Bull hatası: ${e.message}`);
    }
  }

  // SADECE ÇALIŞAN KAYNAKLAR: yt-dlp + Youtubei.js
  const allPromises = [];

  // KATMAN 1: yt-dlp (ANA KAYNAK — proxy + cookies ile çalışır)
  allPromises.push(
    (async () => {
      const format = type === "audio" ? "bestaudio" : "best[ext=mp4][protocol^=http]/best[ext=mp4][protocol!=m3u8_native][protocol!=m3u8]/best[ext=mp4]/best";
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const result = await resolveStreamUrl(url, format, ua, countryClient);
      if (result) return { source: "yt-dlp", url: result };
      throw new Error("yt-dlp başarısız");
    })()
  );

  // KATMAN 2: Youtubei.js (YEDEK — paralel çalışır)
  allPromises.push(
    (async () => {
      const ytUrl = await resolveWithYoutubei(videoId, type);
      if (ytUrl) return { source: "youtubei", url: ytUrl };
      throw new Error("Youtubei başarısız");
    })()
  );

  try {
    const winner = await Promise.any(allPromises);
    console.log(`[RESOLVE] --> ${winner.source.toUpperCase()} kazandı (en hızlı): ${videoId}`);
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

// AKILLI PROXY ROUTING + Agent Cache (her istekte yeni agent oluşturmak yerine cache'le)
const proxyAgentCache = new Map();
function getOrCreateProxyAgent(proxyUrl) {
  if (!proxyAgentCache.has(proxyUrl)) {
    proxyAgentCache.set(proxyUrl, new HttpsProxyAgent(proxyUrl));
  }
  return proxyAgentCache.get(proxyUrl);
}
// Proxy havuzu değişince cache'i temizle
setInterval(() => {
  for (const key of proxyAgentCache.keys()) {
    if (!proxyPool.includes(key)) proxyAgentCache.delete(key);
  }
}, 5 * 60 * 1000);

function getProxyAxiosConfig(extraConfig = {}, videoId = null) {
  const config = { ...extraConfig };
  const targetUrl = config._targetUrl || "";
  const needsProxy = targetUrl.includes("googlevideo.com") ||
    targetUrl.includes("youtube.com") ||
    targetUrl.includes("ytimg.com") ||
    targetUrl === "";

  const proxyUrl = getRandomProxy(videoId);
  if (proxyUrl && needsProxy) {
    config.httpsAgent = getOrCreateProxyAgent(proxyUrl);
    config.httpAgent = undefined;
  }
  delete config._targetUrl;
  return config;
}

const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin: function(origin, callback) {
    // Android uygulaması origin göndermez → izin ver
    // Tarayıcı tabanlı isteklerde sadece güvenilir originler
    const allowed = [
      "https://music.cevapla.tv",
      "https://cevapla.tv",
      "https://music.cevapla.tr",
      "http://localhost:3000",
      "http://localhost:3001",
      undefined, // Android/mobile app
      null
    ];
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS: İzinsiz origin: " + origin));
    }
  },
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "X-Timestamp", "X-Signature", "X-App-Key", "X-Country", "X-Device-Id", "Authorization", "X-Stream-Token"],
  credentials: false
}));
app.use(express.json({ limit: '1mb' }));


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

// TOKEN EXCHANGE: Geçici API token'ları yönetimi
// APK'daki secret key sadece 1 kez /auth/token için kullanılır
// Sonraki tüm istekler geçici token ile yapılır
const API_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 saat (ms)

// Token oluşturma endpoint'i — HMAC ile çağrılır, geçici token döner
app.post("/auth/token", async (req, res) => {
  try {
    const timestamp = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];
    const EXPECTED_SECRET = APP_SECRET;

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

    // Redis'e kaydet (sunucu restart'larında korunsun)
    try {
      await redis.set(`api:token:${token}`, JSON.stringify(tokenData), "EX", Math.floor(API_TOKEN_TTL / 1000));
    } catch (e) {
      console.error("[AUTH_TOKEN] Redis kayıt hatası:", e.message);
      return res.status(500).json({ error: "Redis kayıt hatası" });
    }

    console.log(`[AUTH_TOKEN] --> Yeni API token verildi (Redis): IP: ${req.ip} | Token: ${token.substring(0, 8)}...`);
    res.json({ token, expiresIn: API_TOKEN_TTL / 1000 }); // saniye cinsinden süre
  } catch (err) {
    console.error("[AUTH_TOKEN] Token oluşturma hatası:", err.message);
    res.status(500).json({ error: "Token generation failed" });
  }
});

app.use(async (req, res, next) => {
  // CORS preflight — OPTIONS isteklerini her zaman geçir
  if (req.method === "OPTIONS") return next();
  // Tamamen açık endpoint'ler (minimum tutuldu — güvenlik için)
  if (req.path === "/health" || (req.path === "/config" && req.method === "GET") || req.path === "/auth/token" ||
      (req.path === "/blocked-channels" && req.method === "GET") ||
      (req.path === "/popup/active" && req.method === "GET") ||
      (req.path === "/popup/vote" && req.method === "POST") ||
      (req.path === "/device-action/active" && req.method === "GET") ||
      (req.path === "/device-action/executed" && req.method === "POST") ||
      req.path.startsWith("/top50/test")) {
    return next();
  }
  // Admin panel frontend (X-App-Key ile doğrulama)
  const adminPaths = ["/config", "/blocked-channels", "/send-notification", "/announcements", "/popup", "/device-actions", "/device-action"];
  const isAdminPath = adminPaths.some(p => req.path === p || req.path.startsWith(p + "/"));
  if (isAdminPath && req.headers["x-app-key"] === APP_SECRET) {
    return next();
  }
  // Admin panel'ler — basicAuth zaten kendi içlerinde kontrol ediyor
  if (req.path.startsWith("/proxy-panel") || req.path.startsWith("/cache-panel") ||
      req.path === "/playlist-cache" || req.path === "/admin/cache-playlist" || req.path === "/admin/playlist-progress" ||
      req.path === "/admin" || req.path.startsWith("/admin/panel") || req.path === "/converter") {
    return next();
  }
  // download/mp4 ve send-notification artık auth gerektirir (güvenlik düzeltmesi)

  //  YÖNTEM 1: Bearer Token ile erişim (tercih edilen, daha güvenli)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    let tokenData = null;
    try {
      const redisData = await redis.get(`api:token:${token}`);
      if (redisData) {
        tokenData = JSON.parse(redisData);
      }
    } catch (e) {
      console.error("[AUTH_TOKEN] Redis token doğrulama hatası:", e.message);
    }

    if (tokenData && tokenData.expiresAt > Date.now()) {
      return next(); //  Geçerli token — erişim izni
    }

    // Token geçersiz veya süresi dolmuş
    if (tokenData) {
      try { await redis.del(`api:token:${token}`); } catch (e) { }
    }
    // Token geçersizse HMAC'a düş (geriye uyumluluk)
  }

  // YÖNTEM 2: HMAC Signature ile erişim (eski yöntem, geriye uyumlu)
  const timestamp = req.headers['x-timestamp'];
  const signature = req.headers['x-signature'];
  const EXPECTED_SECRET = APP_SECRET;

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
// Stream Token'ları SADECE Redis üzerinde tutulur (OOM koruması)

async function generateStreamToken(videoId, userId, type = "audio") {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + (DRM_TOKEN_TTL * 1000);
  const tokenData = { videoId, userId, type, expires, used: false, createdAt: Date.now() };

  try {
    await redis.set(`drm:token:${token}`, JSON.stringify(tokenData), "EX", DRM_TOKEN_TTL);
    console.log(`[DRM] Token üretildi (Redis): ${token.substring(0, 8)}... | videoId: ${videoId} | type: ${type}`);
    return { token, expires };
  } catch (e) {
    console.error(`[DRM] Token üretme hatası: ${e.message}`);
    throw new Error("Redis bağlantı hatası nedeniyle token üretilemedi");
  }
}

async function validateStreamToken(token, videoId) {
  let entry = null;

  try {
    const redisData = await redis.get(`drm:token:${token}`);
    if (redisData) entry = JSON.parse(redisData);
  } catch (e) {
    console.error(`[DRM] Token doğrulama hatası: ${e.message}`);
    return { valid: false, reason: "Sunucu içi doğrulama hatası" };
  }

  if (!entry) return { valid: false, reason: "Token bulunamadı" };

  if (entry.expires < Date.now()) {
    try { await redis.del(`drm:token:${token}`); } catch (e) { }
    return { valid: false, reason: "Token süresi dolmuş" };
  }
  if (entry.videoId !== videoId) return { valid: false, reason: "Video ID uyuşmuyor" };
  if (entry.used) return { valid: false, reason: "Token zaten kullanıldı" };

  // Token'ı kullanıldı olarak işaretle (tek kullanımlık)
  entry.used = true;
  try {
    await redis.set(`drm:token:${token}`, JSON.stringify(entry), "EX", 60); // 1 dk sonra otomatik silinir
  } catch (e) { }

  console.log(`[DRM] Token doğrulandı (Redis): ${token.substring(0, 8)}... | videoId: ${videoId}`);
  return { valid: true };
}

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
    console.warn(`[DRM_ABUSE] *** Şüpheli aktivite: IP ${userId} - ${tracker.videos.size} video / ${tracker.count} istek`);
    return false; // Erişimi engelle
  }
  return true;
}

// Tracker temizleyici (her saat eski kayıtları sil)
setInterval(() => {
  const now = Date.now();
  // Hard cap: 10K tracker'dan fazlası birikirse eskileri sil
  if (userStreamTracker.size > 10000) {
    const keys = Array.from(userStreamTracker.keys());
    for (let i = 0; i < keys.length - 5000; i++) userStreamTracker.delete(keys[i]);
    console.warn(`[TRACKER_CLEANUP] Hard cap: ${keys.length} → 5000`);
  }
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
   FILES & CONFIG (Bellekte cache'lenir — her istekte disk okuma yok)
========================= */
const CONFIG_FILE = "config.json";
const DATA_FILE = "blockedChannels.json";

// Config ve blocked channels bellekte tutulur, 60 saniyede bir yenilenir
let _cachedConfig = null;
let _cachedBlockedChannels = null;

function getCachedConfig() {
  if (_cachedConfig) return _cachedConfig;
  try {
    _cachedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch (e) { _cachedConfig = {}; }
  return _cachedConfig;
}

function getCachedBlockedChannels() {
  if (_cachedBlockedChannels !== null) return _cachedBlockedChannels;
  try {
    const BLOCKED_FILE_PATH = path.join(__dirname, "blocked_channels.json");
    if (!fs.existsSync(BLOCKED_FILE_PATH)) return [];
    _cachedBlockedChannels = JSON.parse(fs.readFileSync(BLOCKED_FILE_PATH, "utf-8"));
  } catch (e) { _cachedBlockedChannels = []; }
  return _cachedBlockedChannels;
}

// Her 60 saniyede cache'i yenile (dosya değişikliklerini yakala)
setInterval(() => {
  _cachedConfig = null;
  _cachedBlockedChannels = null;
}, 60000);

if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    global: { enabled: true, mode: "youtube" },
    countries: {},
    mp3Provider: { bazocam: true, backend: true }
  }, null, 2));
}

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([]));
}

/* =========================
   RATE LIMITS
========================= */
// CGNAT NOT: Türk mobil operatörleri (Turkcell, Vodafone, Türk Telekom)
// binlerce kullanıcıyı aynı IP'den gönderir. Limit çok düşük olursa
// gerçek kullanıcılar bloke olur. Yüksek tutuyoruz, DDoS koruması
// Cloudflare/nginx seviyesinde yapılmalı.
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 600, // CGNAT: aynı IP'den yüzlerce kullanıcı gelebilir
  handler: (req, res, next, options) => {
    stats.rateLimitHits++;
    logError("RATE_LIMIT", null, `IP ${req.ip} rate limit aştı (Global)`);
    res.status(options.statusCode).send(options.message);
  }
}));

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200, // CGNAT: arama yoğunluğu yüksek olabilir
  handler: (req, res, next, options) => {
    stats.rateLimitHits++;
    logError("RATE_LIMIT", null, `IP ${req.ip} rate limit aştı (Search)`);
    res.status(options.statusCode).send(options.message);
  }
});

// Stream/Download: CGNAT uyumlu ama biraz daha kısıtlı (ağır endpointler)
const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100, // CGNAT: stream/download yoğunluğu
  handler: (req, res, next, options) => {
    stats.rateLimitHits++;
    logError("RATE_LIMIT", null, `IP ${req.ip} rate limit aştı (Stream)`);
    res.status(options.statusCode).send(options.message);
  }
});

// Auth: Brute-force koruması (daha düşük limit)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // CGNAT: auth istekleri, her kullanıcı 1 kez yapmalı
  handler: (req, res, next, options) => {
    stats.rateLimitHits++;
    logError("RATE_LIMIT", null, `IP ${req.ip} rate limit aştı (Auth)`);
    res.status(options.statusCode).send(options.message);
  }
});

// Route-bazlı rate limit uygulama (tanımlardan SONRA)
app.use("/auth", authLimiter);
app.use("/stream", streamLimiter);
app.use("/download", streamLimiter);

/* =========================
   YOUTUBE API SETUP
========================= */
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CACHE_DURATION = 60 * 60; // 1 saat (saniye cinsinden)
const STREAM_CACHE_DURATION = 5.5 * 60 * 60; // 5.5 saat (YouTube URL max 6 saat, cache'i son ana kadar kullan)
const SEARCH_CACHE_DURATION = parseInt(process.env.SEARCH_CACHE_TTL || "3600"); // config'den yönetilebilir

const BLOCKED_FILE = path.join(__dirname, "blocked_channels.json");

function getBlockedChannels() {
  return getCachedBlockedChannels();
}

function filterBlockedChannels(items, country = "all") {
  const blockedGroups = getBlockedChannels();
  if (!blockedGroups.length) return items;
  return items.filter(item => {
    // Hem YouTube formatı (snippet) hem de düz format (Bazocam vb.) desteği
    const snippet = item.snippet || item;
    const channelTitle = (snippet.channelTitle || snippet.uploaderName || "").toLowerCase();
    const videoTitle = (snippet.title || "").toLowerCase();
    
    const isBlocked = blockedGroups.some(group => {
      // Ülke kontrolü
      const ruleCountries = group.countries || "all";
      if (ruleCountries !== "all") {
        const countriesArray = Array.isArray(ruleCountries) ? ruleCountries : ruleCountries.split(",");
        if (!countriesArray.includes(country)) return false;
      }

      if (!group.channels || !Array.isArray(group.channels)) return false;
      const type = group.type || "channel";
      
      return group.channels.some(blockedValue => {
        const val = blockedValue.toLowerCase();
        if (type === "keyword") {
          return videoTitle.includes(val);
        } else {
          return channelTitle.includes(val);
        }
      });
    });
    
    return !isBlocked;
  });
}

// ARKA PLANDA ÖN-BELLEKLEME (Spotify gibi anında açılması için)
// Kendi sunucumuzda Top25'e çıkarıldı + FFmpeg ile kalıcı disk kaydı eklendi
function prewarmTop10(items) {
  if (!items || !Array.isArray(items)) return;
  const topItems = items.slice(0, 50); // Kendi sunucumuz — Top50'i ısıt
  console.log(`[PREWARM] ${topItems.length} şarkı ön-ısıtma başlatılıyor...`);

  topItems.forEach((item, index) => {
    const videoId = typeof item.id === "object" ? item.id.videoId : item.id;
    if (!videoId) return;

    const cacheKey = `stream:audio:${videoId}`;
    // Eğer cache'te yoksa, arka planda yavaş yavaş bulup ekle
    cacheGet(cacheKey).then(cachedData => {
      if (!cachedData) {
        // Küçük gecikmelerle kuyruğa ekle (YouTube'u boğmamak için)
        setTimeout(() => {
          queue.add(async () => {
            try {
              const ua = getRandomUA();
              const url = await resolveStreamUrlWithFallback(videoId, "audio", ua, "web");
              await cacheSet(cacheKey, { url, ua }, STREAM_CACHE_DURATION);
              console.log(`[PREWARM_SUCCESS] ${videoId} stream URL hazırlandı!`);

              // KALICI KAYIT: FFmpeg ile media/ dizinine kaydet (disk cache)
              // Zaten varsa atla
              if (!mediaLib.getReadyTrack(videoId, "m4a") && !mediaLib.isProcessing(videoId)) {
                const title = item.snippet?.title || "Unknown";
                const artist = item.snippet?.channelTitle || "Unknown";
                mediaLib.upsertTrack(videoId, { title, artist, category: "listening", status: "processing" });

                const cookiePath = getRandomCookie();
                const proxyUrl = getRandomProxy(videoId);
                ffmpegWorker.processAudio(videoId, { title, artist }, { cookiePath, proxyUrl })
                  .then(result => {
                    if (result && result.m4a) {
                      mediaLib.markReady(videoId, { m4a: result.m4a, duration: result.duration });
                      // R2'ye yedek olarak yükle
                      uploadToR2(`audio/${videoId}.m4a`, result.m4a).catch(() => {});
                      console.log(`[PREWARM_DISK] ✅ ${videoId} kalıcı olarak diske kaydedildi!`);
                    }
                  })
                  .catch(err => {
                    console.warn(`[PREWARM_DISK] ⚠️ ${videoId} disk kaydı başarısız: ${err.message}`);
                    mediaLib.markFailed(videoId, err.message);
                  });
              }
            } catch (err) {
              console.warn(`[PREWARM] ⚠️ ${videoId} başarısız: ${err.message}`);
            }
          }).catch(() => { });
        }, index * 3000); // Her bir arasına 3 saniye koy (kendi sunucumuz, bot tespiti azalt)
      }
    });
  });
}

function getPlayerClientForCountry(countryCode) {
  try {
    const configData = getCachedConfig();
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
  const mStats = mediaLib.getStats();
  res.json({
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    memoryRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    redis: redis ? "connected" : "disconnected",
    ytDlp: Date.now() < ytDlpCircuitBreakerUntil ? "circuit_breaker_open" : "ok",
    youtubeApi: youtubeApiStatus,
    mediaLibrary: { tracks: mStats.readyTracks, diskMB: mStats.totalDiskMB }
  });
});

app.get("/admin/stats", basicAuth, (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    stats: stats,
    mediaLibrary: mediaLib.getStats(),
    mediaDisk: ffmpegWorker.getMediaDiskUsage()
  });
});

//  Medya kütüphanesi detaylı istatistikler
app.get("/admin/media-stats", basicAuth, (req, res) => {
  res.json({
    library: mediaLib.getStats(),
    disk: ffmpegWorker.getMediaDiskUsage(),
    recentTracks: mediaLib.getAllTracks({ sortBy: "lastAccessed", limit: 20 })
  });
});

app.get("/config", (req, res) => {
  const config = { ...getCachedConfig() };
  config.watch_base = "https://www.youtube.com/watch?v=";
  res.json(config);
});

app.post("/config", async (req, res) => {
  try {
    await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(req.body, null, 2));
    _cachedConfig = null; // Cache'i hemen invalidate et
    res.json({ message: "Config updated successfully" });
  } catch (e) {
    res.status(500).json({ error: "Config write failed: " + e.message });
  }
});

app.get("/blocked-channels", (req, res) => {
  try {
    if (!fs.existsSync(BLOCKED_FILE)) return res.json([]);
    const data = fs.readFileSync(BLOCKED_FILE, "utf-8");
    res.type("json").send(data || "[]");
  } catch (e) { res.json([]); }
});

app.post("/blocked-channels", async (req, res) => {
  try {
    let blocked = [];
    if (fs.existsSync(BLOCKED_FILE)) {
      blocked = JSON.parse(await fs.promises.readFile(BLOCKED_FILE, "utf-8") || "[]");
    }
    const { id, channels, countries, type } = req.body;

    const existingIndex = blocked.findIndex(b => b.id === id);
    if (existingIndex >= 0) {
      blocked[existingIndex] = { id, channels, countries, type: type || "channel" };
    } else {
      const newId = id || Date.now().toString() + "-" + Math.random().toString(36).substring(2, 9);
      blocked.push({ id: newId, channels: channels || [], countries: countries || "all", type: type || "channel" });
    }

    await fs.promises.writeFile(BLOCKED_FILE, JSON.stringify(blocked, null, 2));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Write failed" }); }
});

app.delete("/blocked-channels/:id", async (req, res) => {
  try {
    if (!fs.existsSync(BLOCKED_FILE)) return res.json({ success: true });
    let blocked = JSON.parse(await fs.promises.readFile(BLOCKED_FILE, "utf-8") || "[]");
    blocked = blocked.filter(ch => ch.id !== req.params.id);
    await fs.promises.writeFile(BLOCKED_FILE, JSON.stringify(blocked, null, 2));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Delete failed" }); }
});

// ONESIGNAL BİLDİRİM GÖNDERME (fetch — exec/curl kaldırıldı, güvenli)
app.post("/send-notification", async (req, res) => {
  const { appId: bodyAppId, restKey: bodyRestKey, title, message, imageUrl, actionUrl, sendAt } = req.body;
  if (!title || !message) {
    return res.status(400).json({ error: "Başlık ve mesaj gereklidir" });
  }

  const appId = bodyAppId || process.env.ONESIGNAL_APP_ID || "9a255882-6fc4-43e6-af33-24f5f69642cf";
  const restKey = bodyRestKey || process.env.ONESIGNAL_REST_KEY || "";

  if (!restKey) {
    return res.status(400).json({ success: false, details: "REST API Key boş. Panelden veya .env'den tanımlayın." });
  }

  try {
    const notifPayload = {
      app_id: appId,
      headings: { en: title },
      contents: { en: message },
      included_segments: ["All"]
    };

    // Görsel URL (büyük resim)
    if (imageUrl) notifPayload.big_picture = imageUrl;
    // Tıklanınca açılacak URL
    if (actionUrl) notifPayload.url = actionUrl;
    // Zamanlanmış gönderim (ISO 8601 formatı)
    if (sendAt) notifPayload.send_after = sendAt;

    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Basic ${restKey}`
      },
      body: JSON.stringify(notifPayload)
    });

    const data = await response.json();
    console.log("[OneSignal]", JSON.stringify(data));

    if (data.errors && data.errors.length > 0) {
      return res.status(400).json({ success: false, details: data.errors[0] });
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error("[OneSignal] Hata:", error.message);
    res.status(500).json({ success: false, details: error.message });
  }
});

// TOP 50

app.get("/top50", async (req, res) => {
  // Ülke tespiti: Cloudflare header > Android X-Country header > fallback US
  const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "US";
  const region = country.toUpperCase();
  const cacheKey = `top50:${region}`;

  // Otomatik ülke algılama — bu ülkeyi ısıtma listesine ekle
  trackActiveRegion(region);

  try {
    // Redis cache kontrol (ülke bazlı)
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.json({ source: "cache", region, data: cached });
    }

    let items;
    try {
      const response = await axiosClient.get("https://www.googleapis.com/youtube/v3/videos", {
        params: {
          part: "snippet,contentDetails,statistics",
          chart: "mostPopular",
          regionCode: region,
          maxResults: 50,
          videoCategoryId: 10,
          key: YOUTUBE_API_KEY
        }
      });
      items = filterBlockedChannels(response.data.items, country);
      youtubeApiStatus = "ok";
    } catch (apiError) {
      if (apiError.response && (apiError.response.status === 403 || apiError.response.status === 429)) {
        logError("API_FALLBACK", null, `YouTube API Quota exceeded. Piped fallback for top50 region=${region}`);
        youtubeApiStatus = "quota_exceeded";
        stats.youtubeApiQuotaExceeded++;
        const pipedRes = await fetchFromPiped(`/trending?region=${region}`);
        const pipedItems = pipedRes.data.map(item => ({
          id: (item.url || "").split("?v=")[1],
          snippet: {
            title: item.title,
            channelTitle: item.uploaderName,
            channelId: (item.uploaderUrl || "").split("/channel/")[1] || ""
          }
        }));
        items = filterBlockedChannels(pipedItems, country);
      } else {
        throw apiError;
      }
    }

    await cacheSet(cacheKey, items, CACHE_DURATION);

    // Top50 prewarm — popüler şarkılar cache'te hazır olsun
    prewarmTop10(items);

    res.setHeader("Cache-Control", `public, max-age=${CACHE_DURATION}`);
    res.json({ source: "youtube", region, data: items });
  } catch (error) {
    logError("TOP50", null, `region=${region} ${error.message}`);
    console.error(`TOP50 ERROR [${region}]:`, error.message);
    res.status(500).json({ error: "API error" });
  }
});

// DEBUG: Ülke bazlı Top50 test endpoint'i — tarayıcıdan /top50/test/TR veya /top50/test/US ile dene
app.get("/top50/test/:region", async (req, res) => {
  const region = (req.params.region || "US").toUpperCase();
  const cacheKey = `top50:${region}`;
  const cached = await cacheGet(cacheKey);
  const titles = cached
    ? cached.slice(0, 10).map((item, i) => `${i+1}. ${item.snippet?.title || "?"}`)
    : null;
  res.json({
    region,
    cacheKey,
    hasCachedData: !!cached,
    totalCached: cached ? cached.length : 0,
    first10: titles || "Cache boş — henüz bu ülke için istek gelmemiş"
  });
});

// SEARCH
app.get("/search", searchLimiter, async (req, res) => {
  const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
  try {
    const query = req.query.q?.toLowerCase().trim();
    if (!query) return res.status(400).json({ error: "Query required" });

    const cacheKey = `search_bazocam:${query}`;

    // Redis cache kontrol
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // ADIM 1: Bazocam API
    let searchResult = null;
    try {
      console.log(`[SEARCH] Bazocam API kullanılıyor: "${query}"`);
      const response = await axiosClient.get(`https://bazocam.net/search.php?PASS=${BAZOCAM_PASS}&action=search&q=${encodeURIComponent(query)}`, { timeout: 8000 });

      const bazocamData = response.data || [];
      const filteredData = filterBlockedChannels(bazocamData, country);
      searchResult = { data: filteredData, nextPageToken: null };
    } catch (apiError) {
      logError("SEARCH_BAZOCAM_FAIL", null, `Bazocam arama başarısız: ${apiError.message}`);
    }

    // ADIM 2: Bazocam başarısız → YouTube Data API fallback
    if (!searchResult && YOUTUBE_API_KEY) {
      try {
        console.log(`[SEARCH] YouTube API fallback: "${query}"`);
        const ytResponse = await axiosClient.get("https://www.googleapis.com/youtube/v3/search", {
          params: {
            part: "snippet",
            q: query,
            type: "video",
            videoCategoryId: "10",
            maxResults: 20,
            key: YOUTUBE_API_KEY
          },
          timeout: 8000
        });

        const ytItems = (ytResponse.data.items || []).map(item => ({
          id: item.id.videoId,
          title: item.snippet.title,
          url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
          thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || "",
          uploader: item.snippet.channelTitle,
          uploaderUrl: "",
          duration: 0,
          snippet: {
            title: item.snippet.title,
            channelTitle: item.snippet.channelTitle,
            channelId: item.snippet.channelId || ""
          }
        }));

        const filteredYt = filterBlockedChannels(ytItems, country);
        searchResult = { data: filteredYt, nextPageToken: ytResponse.data.nextPageToken || null };
        console.log(`[SEARCH] YouTube API fallback başarılı: ${filteredYt.length} sonuç`);
      } catch (ytError) {
        logError("SEARCH_YT_FAIL", null, `YouTube API arama başarısız: ${ytError.message}`);
      }
    }

    if (searchResult) {
      await cacheSet(cacheKey, searchResult, SEARCH_CACHE_DURATION);
      res.setHeader("Cache-Control", "no-store");
      res.json(searchResult);

      // SEARCH WARM DEVRE DIŞI — yt-dlp kapasitesini boşa harcamamak için
      // Sadece kullanıcının SEÇTİĞİ şarkı çözümlenir (stream endpoint'inde)
      // Bu sayede aynı sunucuyla 10x daha fazla kullanıcıya hizmet verilir
    } else {
      throw new Error("Tüm arama kaynakları başarısız");
    }

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

// ========== BAZOCAM CDN URL ÇÖZÜCÜ ==========
// Bazocam'ın kendi proxy sistemi üzerinden Google CDN linklerini alır.
// Böylece senin sunucunda proxy kullanmana gerek kalmaz.
const BAZOCAM_PASS = BAZOCAM_PASS_ENV;
const BAZOCAM_BASE = "https://bazocam.net";

async function getBazocamCdnUrl(videoId, type = "audio") {
  try {
    let url;
    if (type === "audio") {
      // M4A: 128kbps audio stream
      url = `${BAZOCAM_BASE}/m4a.php?PASS=${BAZOCAM_PASS}&youtubeID=${videoId}&q=140`;
    } else {
      // MP4: 720p video stream
      url = `${BAZOCAM_BASE}/mp4.php?PASS=${BAZOCAM_PASS}&youtubeID=${videoId}&res=720`;
    }

    console.log(`[BAZOCAM_CDN] ${type} URL isteniyor: ${videoId}`);

    // Bazocam redirect ile Google CDN linkine yönlendiriyor
    // maxRedirects: 0 ile redirect URL'ini yakalıyoruz
    const response = await axios.get(url, {
      maxRedirects: 0,
      timeout: 20000,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: { "User-Agent": getRandomUserAgent() }
    });

    // 200 ile direkt link dönerse
    if (response.status === 200 && response.request?.res?.responseUrl) {
      const finalUrl = response.request.res.responseUrl;
      if (finalUrl.includes("googlevideo.com") || finalUrl.includes("google.com")) {
        console.log(`[BAZOCAM_CDN] ✅ Google CDN linki alındı: ${videoId}`);
        return finalUrl;
      }
    }

    // Response body'de URL varsa
    const body = typeof response.data === "string" ? response.data.trim() : "";
    if (body.startsWith("http") && (body.includes("googlevideo.com") || body.includes("google.com"))) {
      console.log(`[BAZOCAM_CDN] ✅ Body'den CDN linki alındı: ${videoId}`);
      return body;
    }

    console.log(`[BAZOCAM_CDN] ⚠️ CDN linki bulunamadı, fallback'e geçiliyor: ${videoId}`);
    return null;
  } catch (err) {
    // 302 redirect'i yakala
    if (err.response && (err.response.status === 301 || err.response.status === 302)) {
      const redirectUrl = err.response.headers.location;
      if (redirectUrl && redirectUrl.startsWith("http")) {
        console.log(`[BAZOCAM_CDN] ✅ Redirect CDN linki: ${videoId}`);
        return redirectUrl;
      }
    }
    console.warn(`[BAZOCAM_CDN] ❌ Hata (${type}): ${err.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  CACHE NOTIFY — Android NewPipe ile çaldığında backend'e bildir
//  Backend arka planda şarkıyı diske indirir (bir sonraki istekte diskten gelir)
// ═══════════════════════════════════════════════════════════════
app.post("/cache-notify", express.json(), async (req, res) => {
  const { videoId, url, type } = req.body;
  if (!videoId || !url) return res.status(400).json({ error: "videoId and url required" });

  const typeStr = type === "video" ? "video" : "audio";
  const ext = typeStr === "audio" ? "m4a" : "mp4";
  const targetDir = typeStr === "video" ? VIDEO_CACHE_DIR : CACHE_DIR;
  const localFile = path.join(targetDir, `${typeStr}_${videoId}.${ext}`);
  const altFile = path.join(targetDir, `${videoId}.${ext}`);

  // Zaten diskde varsa skip
  if (fs.existsSync(localFile) || fs.existsSync(altFile)) {
    return res.json({ status: "already_cached" });
  }

  // Media Library'de varsa skip
  const mediaTrack = mediaLib.getReadyTrack(videoId, ext === "m4a" ? "m4a" : "mp4");
  if (mediaTrack?.files?.[ext === "m4a" ? "m4a" : "mp4"]) {
    return res.json({ status: "already_in_library" });
  }

  // Arka planda indir (kullanıcıyı bekletme)
  res.json({ status: "downloading" });

  try {
    await downloadToCache(videoId, typeStr, url);
    console.log(`[CACHE_NOTIFY] ✅ ${typeStr}_${videoId} arka planda indirildi`);

    // FFmpeg ile kalıcı kütüphaneye de ekle
    if (typeStr === "audio" && !mediaLib.getReadyTrack(videoId, "m4a") && !mediaLib.isProcessing(videoId)) {
      mediaLib.upsertTrack(videoId, { title: videoId, category: "listening", status: "processing" });
      const cookiePath = getRandomCookie();
      const proxyUrl = getRandomProxy(videoId);
      ffmpegWorker.processAudio(videoId, { title: videoId }, { format: "m4a", cookiePath, proxyUrl })
        .then(result => {
          mediaLib.markReady(videoId, result);
          console.log(`[CACHE_NOTIFY] 🎵 Media Library'ye eklendi: ${videoId}`);
        })
        .catch(err => {
          mediaLib.markFailed(videoId, err.message);
        });
    }
  } catch (e) {
    console.warn(`[CACHE_NOTIFY] ❌ İndirme başarısız: ${videoId} — ${e.message}`);
  }
});

app.get("/stream", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: "Invalid or missing videoId" });
  }

  const typeStr = (req.query.type === "video" || req.path.includes("video") || req.path.includes("mp4")) ? "video" : "audio";
  const cacheKey = `ongoing:${typeStr}:${videoId}`;

  //  KİLİT MEKANİZMASI: Eğer bu şarkı şu an çözümleniyorsa, mevcut işlemi bekle
  if (ongoingResolutions.has(cacheKey)) {
    console.log(`[DEBOUNCE] +++ ${videoId} zaten çözümleniyor, bekletiliyor...`);
    try {
      await ongoingResolutions.get(cacheKey);
      // İlk işlem bittiğinde akış aşağıdan (cache hit ile) devam edecek
    } catch (err) {
      // Önceki hata aldıysa biz yine de bir şans verelim veya hata döndürelim
    }
  }

  try {

    // DRM : Stream token doğrulaması
    const streamToken = req.query.token || req.headers["x-stream-token"];
    if (streamToken) {
      const tokenCheck = await validateStreamToken(streamToken, videoId);
      if (!tokenCheck.valid) {
        console.warn(`[DRM] Token reddedildi: ${tokenCheck.reason} | videoId: ${videoId} | IP: ${req.ip}`);
        return res.status(403).json({ error: "Invalid or expired stream token", reason: tokenCheck.reason });
      }
    }

    // DRM : Erişim izleme & abuse tespiti
    const accessAllowed = trackStreamAccess(req.ip, videoId, "audio");
    if (!accessAllowed) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }

    // DRM: Koruma header'ları
    setDrmHeaders(res);

    const typeStr = (req.query.type === "video" || req.path.includes("video") || req.path.includes("mp4")) ? "video" : "audio";
    const extStr = typeStr === "audio" ? "m4a" : "mp4";
    const r2Key = `${typeStr}/${videoId}.${extStr}`;
    const targetCacheDir = typeStr === "video" ? VIDEO_CACHE_DIR : CACHE_DIR;
    const localFile = path.join(targetCacheDir, `${typeStr}_${videoId}.${extStr}`);
    // Eski format uyumluluğu: FFmpeg "videoId.m4a", downloadToCache "audio_videoId.m4a" kaydediyor
    const altFile = path.join(targetCacheDir, `${videoId}.${extStr}`);

    //  KATMAN -1: FFMPEG MEDIA LIBRARY (En hızlı — kendi diskimiz)
    const mediaTrack = mediaLib.getReadyTrack(videoId, extStr === "m4a" ? "m4a" : "mp4");
    if (mediaTrack && mediaTrack.files) {
      const mediaFile = mediaTrack.files[extStr === "m4a" ? "m4a" : "mp4"];
      if (mediaFile && fs.existsSync(mediaFile)) {
        console.log(`[MEDIA_LIB_HIT] 🎵 Kendi diskimizden sunuluyor: ${videoId}`);
        mediaLib.recordAccess(videoId);
        const fSize = fs.statSync(mediaFile).size;
        res.setHeader("Content-Type", typeStr === "video" ? "video/mp4" : "audio/mp4");
        res.setHeader("Content-Length", fSize);
        res.setHeader("Accept-Ranges", "bytes");
        return res.sendFile(mediaFile, (err) => {
          if (err && err.status === 416) return res.status(416).end();
          if (err && !res.headersSent) res.status(500).end();
        });
      }
    }

    // KATMAN 0: DISK CACHE (Anlık — ağ gecikmesi yok)
    // İki format kontrol: "audio_videoId.m4a" (downloadToCache) ve "videoId.m4a" (FFmpeg)
    const diskFile = fs.existsSync(localFile) ? localFile : (fs.existsSync(altFile) ? altFile : null);
    if (diskFile) {
      const stats = fs.statSync(diskFile);
      const minSize = typeStr === "video" ? 100 * 1024 : 20 * 1024;
      if (stats.size < minSize) {
        console.warn(`[DISK_CACHE_ERR] Bozuk dosya, siliniyor: ${diskFile}`);
        fs.unlinkSync(diskFile);
      } else {
        console.log(`[DISK_CACHE_HIT]  Diskten anında sunuluyor: ${videoId} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        if (req.path.includes("download")) {
          res.setHeader("Content-Disposition", `attachment; filename=${typeStr}_${videoId}.${extStr}`);
        }
        res.setHeader("Content-Type", typeStr === "video" ? "video/mp4" : "audio/m4a");
        res.setHeader("Content-Length", stats.size);
        res.setHeader("Accept-Ranges", "bytes");
        // Arka planda R2'ye yükle
        uploadToR2(r2Key, diskFile).catch(() => { });
        return res.sendFile(diskFile, (err) => {
          if (err && err.status === 416) return res.status(416).end();
          if (err && !res.headersSent) res.status(500).end();
        });
      }
    }

    //  KATMAN 1: CLOUDFLARE R2 (Ağ gecikmesi var ama YouTube'dan hızlı)
    try {
      const r2Data = await getR2Stream(r2Key);
      if (r2Data && r2Data.stream) {
        console.log(`[R2_CACHE_HIT] --> Cloudflare'den sunuluyor: ${videoId}`);
        if (r2Data.contentType) res.setHeader("Content-Type", r2Data.contentType);
        if (r2Data.contentLength) res.setHeader("Content-Length", r2Data.contentLength);
        safePipe(r2Data.stream, res);
        return;
      }
    } catch (r2Err) { /* R2 yoksa YouTube'a devam */ }

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

      // ÇAKIŞMA ÖNLEYİCİ: Bu videoyu çözme işlemini bir Promise olarak başlat
      const resolutionPromise = queue.add(async () => {
        try {
          const url = await resolveStreamUrlWithFallback(videoId, "audio", ua, countryClient);
          return url;
        } finally {
          const ongoingKey = `ongoing:${typeStr}:${videoId}`;
          ongoingResolutions.delete(ongoingKey);
        }
      });

      const ongoingKey = `ongoing:${typeStr}:${videoId}`;
      resolutionPromise._startedAt = Date.now();
      ongoingResolutions.set(ongoingKey, resolutionPromise);
      streamUrl = await resolutionPromise;

      // Stream URL'leri 5 saat cache'le (arka planda — kullanıcıyı bekletme)
      cacheSet(cacheKey, { url: streamUrl, ua }, STREAM_CACHE_DURATION).catch(() => {});
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
        ...getProxyAxiosConfig({ _targetUrl: streamUrl }, videoId)
      });
    } catch (fetchErr) {
      // Proxy hatası tespiti
      if (fetchErr.response && (fetchErr.response.status === 402 || fetchErr.response.status === 407)) {
        console.warn(`[PROXY_UYARISI]  AXIOS PROXY BİTİYOR VEYA REDDEDİLDİ! Status: ${fetchErr.response.status}`);
      } else if (fetchErr.code && (fetchErr.code === 'ECONNRESET' || fetchErr.code === 'ECONNREFUSED' || fetchErr.code === 'ENOTFOUND')) {
        console.warn(`[PROXY_UYARISI]  AXIOS PROXY BAĞLANTISI KOPTU! Code: ${fetchErr.code}`);
      }

      if (fetchErr.response && (fetchErr.response.status === 403 || fetchErr.response.status === 502 || fetchErr.response.status === 503)) {
        console.warn(`[STREAM_AUDIO] ${fetchErr.response.status} — Proxy/CDN hatası. Direkt yt-dlp stream kullanılıyor: ${videoId}`);
        if (redis) await redis.del(cacheKey);

        // Arka planda kalıcı indirmeyi başlat
        if (!mediaLib.getReadyTrack(videoId, "m4a") && !mediaLib.isProcessing(videoId)) {
          const metadata = { 
            title: req.query.title || "Unknown", 
            artist: req.query.uploader || "Unknown" 
          };
          const category = typeStr === "video" ? "watching" : "listening";

          mediaLib.upsertTrack(videoId, { ...metadata, category, status: "processing" });
          const cookiePath = getRandomCookie();
          const proxyUrl = getRandomProxy(videoId);
          ffmpegWorker.processAudio(videoId, metadata, { format: "m4a", cookiePath, proxyUrl })
            .then(result => {
              mediaLib.markReady(videoId, result);
              ffmpegWorker.downloadThumbnail(videoId).then(thumb => {
                if (thumb) mediaLib.upsertTrack(videoId, { thumbnail: thumb, status: "ready" });
              }).catch(() => { });
            }).catch(err => {
              mediaLib.markFailed(videoId, err.message);
            });
        }

        // Kullanıcıyı bekletmemek için direkt stream et ve fonksiyonu bitir
        await ytdlpStream(videoId, "audio", req, res);
        return;
      } else {
        throw fetchErr;
      }
    }

    res.status(response.status);
    if (response.headers["content-type"]) res.setHeader("Content-Type", response.headers["content-type"]);
    if (response.headers["content-length"]) res.setHeader("Content-Length", response.headers["content-length"]);
    if (response.headers["content-range"]) res.setHeader("Content-Range", response.headers["content-range"]);
    if (response.headers["accept-ranges"]) res.setHeader("Accept-Ranges", response.headers["accept-ranges"]);

    safePipe(response.data, res);

    if (typeof streamUrl !== 'undefined') {
      // downloadToCache kaldırıldı — FFmpeg worker tek başına kalıcı cache'i yönetir
      // Eski downloadToCache, YouTube URL'si expire olunca 403 alıyordu

      //  ARKA PLANDA FFmpeg ile kalıcı dosya oluştur (bir sonraki istek diskten gelir)
      const isVideo = typeStr === "video";
      const checkExt = isVideo ? "mp4" : "m4a";

      if (!mediaLib.getReadyTrack(videoId, checkExt) && !mediaLib.isProcessing(videoId)) {
        const metadata = { 
          title: req.query.title || "Unknown", 
          artist: req.query.uploader || "Unknown" 
        };
        const category = isVideo ? "watching" : "listening";
        
        mediaLib.upsertTrack(videoId, { ...metadata, category, status: "processing" });
        const cookiePath = getRandomCookie();
        const proxyUrl = getRandomProxy(videoId);
        
        const processPromise = isVideo 
          ? ffmpegWorker.processVideo(videoId, metadata, { cookiePath, proxyUrl })
          : ffmpegWorker.processAudio(videoId, metadata, { format: "m4a", cookiePath, proxyUrl });

        processPromise.then(result => {
            mediaLib.markReady(videoId, result);
            ffmpegWorker.downloadThumbnail(videoId).then(thumb => {
              if (thumb) mediaLib.upsertTrack(videoId, { thumbnail: thumb, status: "ready" });
            }).catch(() => { });
            console.log(`[FFMPEG_BG] +++ Arka planda kalıcı dosya oluşturuldu (${checkExt}): ${videoId}`);
          })
          .catch(err => {
            mediaLib.markFailed(videoId, err.message);
            console.warn(`[FFMPEG_BG] *** Arka plan işleme başarısız: ${videoId}: ${err.message}`);
          });
      }
    }
  } catch (err) {
    logError("STREAM", req.query.videoId, err.message);
    console.error("STREAM ERROR:", err.message);
    if (!res.headersSent) {
      // Kuyruk dolu/timeout → 503 ile "tekrar dene" sinyali
      const isQueueError = err.message && (err.message.includes("timeout") || err.message.includes("queue full"));
      const statusCode = isQueueError ? 503 : 500;
      if (isQueueError) res.setHeader("Retry-After", "5");
      res.status(statusCode).json({
        error: isQueueError ? "Server busy, please retry" : "Streaming failed",
        retryable: isQueueError,
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

    const r2Key = `video/${videoId}.mp4`;
    const localVideoFile = path.join(VIDEO_CACHE_DIR, `video_${videoId}.mp4`);
    const altVideoFile = path.join(VIDEO_CACHE_DIR, `${videoId}.mp4`);

    // KATMAN -1: FFMPEG MEDIA LIBRARY (Kendi diskimizden video)
    const mediaTrack = mediaLib.getReadyTrack(videoId, "mp4");
    if (mediaTrack && mediaTrack.files?.mp4 && fs.existsSync(mediaTrack.files.mp4)) {
      const videoFile = mediaTrack.files.mp4;
      const fStats = fs.statSync(videoFile);
      const fileSize = fStats.size;
      console.log(`[MEDIA_VIDEO_HIT] +++ Video diskten sunuluyor: ${videoId} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
      mediaLib.recordAccess(videoId);

      // Range Request desteği (ExoPlayer için ZORUNLU)
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize) {
          res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
          return res.end();
        }

        const chunkSize = (end - start) + 1;

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": "video/mp4",
        });
        const fileStream = fs.createReadStream(videoFile, { start, end });
        return safePipe(fileStream, res);
      } else {
        res.writeHead(200, {
          "Content-Length": fileSize,
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
        });
        const fileStream = fs.createReadStream(videoFile);
        return safePipe(fileStream, res);
      }
    }

    //  KATMAN 0: DISK CACHE (Anlık) — iki format kontrol
    const diskVideoFile = fs.existsSync(localVideoFile) ? localVideoFile : (fs.existsSync(altVideoFile) ? altVideoFile : null);
    if (diskVideoFile) {
      const vStats = fs.statSync(diskVideoFile);
      if (vStats.size > 100 * 1024) {
        const fileSize = vStats.size;
        console.log(`[DISK_VIDEO_HIT] +++ Video diskten: ${videoId} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
        uploadToR2(r2Key, diskVideoFile).catch(() => { });

        //  Range Request desteği (ExoPlayer için ZORUNLU)
        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunkSize = (end - start) + 1;

          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": "video/mp4",
          });
          const fileStream = fs.createReadStream(diskVideoFile, { start, end });
          return safePipe(fileStream, res);
        } else {
          res.writeHead(200, {
            "Content-Length": fileSize,
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
          });
          const fileStream = fs.createReadStream(diskVideoFile);
          return safePipe(fileStream, res);
        }
      } else {
        fs.unlinkSync(diskVideoFile);
      }
    }

    // KATMAN 1: CLOUDFLARE R2
    try {
      const r2Data = await getR2Stream(r2Key);
      if (r2Data && r2Data.stream) {
        console.log(`[R2_VIDEO_HIT] --> Video R2'den sunuluyor: ${videoId}`);
        res.setHeader("Content-Type", "video/mp4");
        if (r2Data.contentLength) res.setHeader("Content-Length", r2Data.contentLength);
        safePipe(r2Data.stream, res);
        return;
      }
    } catch (r2Err) { }

    // KATMAN 2: YouTube'dan çöz
    const cacheKey = `stream:video:${videoId}`;
    const cachedData = await cacheGet(cacheKey);
    let streamUrl;

    if (cachedData && cachedData.url) {
      streamUrl = cachedData.url;
      console.log(`[VIDEO_CACHE_HIT] Hızlı URL kullanılıyor: ${videoId}`);
    } else {
      console.log(`[VIDEO_RESOLVE] YouTube'dan video URL çözümleniyor: ${videoId}`);
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
      "Accept-Encoding": "identity"
    };
    if (req.headers.range) headersOptions["Range"] = req.headers.range;

    if (streamUrl.includes(".m3u8") || streamUrl.includes("manifest/")) {
      console.warn(`[STREAM_VIDEO_HLS] M3U8 geldi, yönlendiriliyor...`);
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
        ...getProxyAxiosConfig({ _targetUrl: streamUrl }, videoId)
      });
    } catch (fetchErr) {
      // Proxy hatası tespiti
      if (fetchErr.response && (fetchErr.response.status === 402 || fetchErr.response.status === 407)) {
        console.warn(`[PROXY_UYARISI] 🚨 AXIOS PROXY BİTİYOR VEYA REDDEDİLDİ! Status: ${fetchErr.response.status}`);
      } else if (fetchErr.code && (fetchErr.code === 'ECONNRESET' || fetchErr.code === 'ECONNREFUSED' || fetchErr.code === 'ENOTFOUND')) {
        console.warn(`[PROXY_UYARISI] 🚨 AXIOS PROXY BAĞLANTISI KOPTU! Code: ${fetchErr.code}`);
      }

      if (fetchErr.response && (fetchErr.response.status === 403 || fetchErr.response.status === 404 || fetchErr.response.status === 502 || fetchErr.response.status === 503)) {
        console.warn(`[STREAM_VIDEO] ${fetchErr.response.status} — Proxy/CDN hatası. Direkt yt-dlp stream kullanılıyor: ${videoId}`);
        if (redis) await redis.del(cacheKey);

        // Arka planda indirme başlat
        if (!mediaLib.getReadyTrack(videoId, "mp4") && !mediaLib.isProcessing(videoId + "_video")) {
          const cookiePath = getRandomCookie();
          const proxyUrl = getRandomProxy(videoId);
          ffmpegWorker.processVideo(videoId, {}, { cookiePath, proxyUrl })
            .then(result => {
              mediaLib.upsertTrack(videoId, { mp4: result.mp4, status: "ready" });
              if (result.mp4) {
                try { mediaLib.upsertTrack(videoId, { mp4Size: fs.statSync(result.mp4).size }); } catch (e) { }
              }
            })
            .catch(err => {
              console.warn(`[FFMPEG_VIDEO_BG] *** Video işleme başarısız: ${videoId}: ${err.message}`);
            });
        }

        await ytdlpStream(videoId, "video", req, res);
        return;
      } else {
        throw fetchErr;
      }
    }

    res.status(response.status);
    if (response.headers["content-type"]) res.setHeader("Content-Type", response.headers["content-type"]);
    if (response.headers["content-length"]) res.setHeader("Content-Length", response.headers["content-length"]);
    if (response.headers["content-range"]) res.setHeader("Content-Range", response.headers["content-range"]);
    if (response.headers["accept-ranges"]) res.setHeader("Accept-Ranges", response.headers["accept-ranges"]);

    safePipe(response.data, res);

    // ARKA PLANDA: FFmpeg ile videoyu kalıcı kaydet
    if (!mediaLib.getReadyTrack(videoId, "mp4") && !mediaLib.isProcessing(videoId)) {
      const metadata = { 
        title: req.query.title || "Unknown", 
        artist: req.query.uploader || "Unknown" 
      };
      
      mediaLib.upsertTrack(videoId, { ...metadata, category: "watching", status: "processing" });
      const cookiePath = getRandomCookie();
      const proxyUrl = getRandomProxy(videoId);
      
      ffmpegWorker.processVideo(videoId, metadata, { cookiePath, proxyUrl })
        .then(result => {
          mediaLib.markReady(videoId, result);
          ffmpegWorker.downloadThumbnail(videoId).then(thumb => {
            if (thumb) mediaLib.upsertTrack(videoId, { thumbnail: thumb, status: "ready" });
          }).catch(() => { });
          console.log(`[FFMPEG_BG_VIDEO] +++ Video kütüphaneye kaydedildi: ${videoId}`);
        })
        .catch(err => {
          mediaLib.markFailed(videoId, err.message);
          console.warn(`[FFMPEG_BG_VIDEO] *** Hata: ${videoId}: ${err.message}`);
        });
    }

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

// Popüler ülkelerin Top50'sini ön-ısıtma — API quota tasarrufu için sadece en aktif 6 bölge
// Diğer bölgeler kullanıcı isteği geldiğinde lazy-load edilir ve cache'lenir
// OTOMATİK ÜLKE ISITMA — sadece gerçekten kullanan ülkeleri ısıt (proxy tasarrufu)
// Kullanıcı bir ülkeden istek atınca o ülke listeye eklenir
const activeRegions = new Set(["TR", "US"]); // Başlangıçta sadece TR ve US
const WARM_REGIONS = { get list() { return Array.from(activeRegions); } };

// Yeni ülke algılama — /top50, /stream, /search isteklerinden
function trackActiveRegion(country) {
  if (!country || country === "UNKNOWN" || country.length !== 2) return;
  const region = country.toUpperCase();
  if (!activeRegions.has(region)) {
    activeRegions.add(region);
    console.log(`[AUTO_REGION] 🌍 Yeni ülke algılandı: ${region} — Top50 ısıtmaya eklendi (toplam: ${activeRegions.size})`);
  }
}

async function warmTop50() {
  const regions = WARM_REGIONS.list;
  console.log(`[WARMUP] ${regions.length} aktif ülke ısıtılacak: ${regions.join(", ")}`);
  for (const region of regions) {
    try {
      const response = await axiosClient.get("https://www.googleapis.com/youtube/v3/videos", {
        params: {
          part: "snippet,contentDetails,statistics",
          chart: "mostPopular",
          regionCode: region,
          maxResults: 50,
          videoCategoryId: 10,
          key: YOUTUBE_API_KEY
        }
      });
      const items = filterBlockedChannels(response.data.items);
      await cacheSet(`top50:${region}`, items, CACHE_DURATION);
      console.log(`[WARMUP] Top50 ${region} cache hazır.`);

      // Top50 prewarm — popüler şarkılar cache'te hazır olsun
      if (regions.length <= 5) prewarmTop10(items);
    } catch (e) {
      console.warn(`[WARMUP] Top50 ${region} başarısız: ${e.message}`);
      // Quota aşıldıysa diğer bölgeleri de deneme
      if (e.response && (e.response.status === 403 || e.response.status === 429)) break;
    }
  }
}

// Her 50 dakikada bir arkaplanda güncelleyerek anlık gecikmelerin önüne geç (sadece primary worker)
if (isPrimaryWorker) setInterval(warmTop50, 50 * 60 * 1000);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Redis: ${redis ? "bağlı" : "in-memory fallback"}`);

  // Eski kırık thumbnail cache'ini temizle
  try {
    if (redis) {
      const searchKeys = await redis.keys("search:*");
      const top50Keys = await redis.keys("top50:*");
      const allKeys = [...searchKeys, ...top50Keys];
      if (allKeys.length > 0) {
        await redis.del(...allKeys);
        console.log(`[STARTUP] ${allKeys.length} eski cache kaydı temizlendi`);
      }
    }
    // memoryCache kaldırıldı — Redis zorunlu, yukarıdaki redis.del yeterli
  } catch (e) { console.warn("[STARTUP] Cache temizleme hatası:", e.message); }

  if (isPrimaryWorker) await warmTop50();
});

// Fix 5: playlistJobs temizleme — tamamlanmış/hatalı jobları 10dk sonra sil
setInterval(() => {
  if (!global.playlistJobs) return;
  const now = Date.now();
  for (const [id, job] of Object.entries(global.playlistJobs)) {
    if (job.status === 'completed' || job.status === 'error') {
      if (!job._doneAt) { job._doneAt = now; continue; }
      if (now - job._doneAt > 10 * 60 * 1000) {
        delete global.playlistJobs[id];
        console.log(`[PLAYLIST_CLEANUP] Job silindi: ${id}`);
      }
    }
  }
}, 60 * 1000);

// Fix 7: Graceful shutdown — SIGTERM/SIGINT
function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} alındı, bağlantılar kapatılıyor...`);
  server.close(() => {
    console.log("[SHUTDOWN] HTTP server kapatıldı.");
    if (redis) {
      redis.quit().then(() => {
        console.log("[SHUTDOWN] Redis bağlantısı kapatıldı.");
        process.exit(0);
      }).catch(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });
  // 15 saniye içinde kapanmazsa zorla kapat
  setTimeout(() => {
    console.error("[SHUTDOWN] Zorla kapatılıyor (timeout)");
    process.exit(1);
  }, 15000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/* =========================
   BAZOCAM.NET YARDIMCI FONKSİYONLAR
   converter.php API entegrasyonu için
========================= */

// Bazocam'dan MP3 dosyasını çekip Android'e pipe et
async function streamMp3FromUrl(downloadUrl, videoId, title, res) {
  const response = await axiosClient({
    method: "GET",
    url: downloadUrl,
    responseType: "stream",
    timeout: 120000,
    headers: {
      "User-Agent": getRandomUA(),
      "Accept": "audio/mpeg, audio/*, */*"
    },
    validateStatus: (status) => status === 200
  });

  // Gelen veri gerçekten audio mu kontrol et
  const contentType = response.headers['content-type'] || '';
  if (contentType.includes('text/html')) {
    throw new Error(`Bazocam download URL HTML döndürdü: ${contentType}`);
  }

  const safeTitle = (title || `audio_${videoId}`)
    .replace(/[^\w\s\-\.]/g, "")
    .trim()
    .substring(0, 100) || `audio_${videoId}`;

  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp3"`);
  res.setHeader("Content-Type", "audio/mpeg");

  if (response.headers['content-length']) {
    const cLength = parseInt(response.headers['content-length']);
    if (cLength < 50 * 1024) { // 50KB'dan küçükse hata mesajı olabilir
      throw new Error(`Bazocam dosya çok küçük (${cLength} bytes)`);
    }
    res.setHeader("Content-Length", cLength);
  }

  safePipe(response.data, res);
  try { mediaLib.recordAccess(videoId); } catch (e) { }
}

// Bazocam converter.php dönüştürme durumunu poll et
async function pollConversionStatus(statusUrl, downloadUrl, maxWaitMs = 120000) {
  const startTime = Date.now();
  const pollInterval = 2000; // 2 saniye aralıklarla kontrol

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const statusRes = await axiosClient.get(statusUrl, { timeout: 10000 });
      const data = statusRes.data;

      // Tamamlandı durumu (status/state done)
      if (data.status === "completed" || data.status === "done" || data.state === "done") {
        console.log(`[BAZOCAM_POLL] Dönüştürme tamamlandı! (state: done)`);
        // Eğer data içinde download linki varsa onu kullan, yoksa ilk istekten geleni kullan
        return data.download || downloadUrl;
      }

      // Cache'e alınmış
      if (data.status === "cached" && data.download) {
        return data.download;
      }

      // Progress %100 ise tamamlanmış sayabiliriz
      if (data.progress === 100 || data.progress === "100" || data.progress === "100.0") {
        console.log(`[BAZOCAM_POLL] Progress %100 ulaştı!`);
        return data.download || downloadUrl;
      }

      // Başarısız oldu
      if (data.status === "failed" || data.status === "error" || data.state === "error") {
        throw new Error(`Bazocam dönüştürme başarısız: ${data.error || "Bilinmeyen hata"}`);
      }

      // Hâlâ dönüştürülüyor — bekle ve tekrar dene
      const progress = data.progress || "?";
      console.log(`[BAZOCAM_POLL] Dönüştürülüyor... (%${progress}) | ${Math.round((Date.now() - startTime) / 1000)}s | keys: ${Object.keys(data).join(",")}`);

    } catch (err) {
      if (err.message.includes("başarısız")) throw err;
      console.warn(`[BAZOCAM_POLL] Poll hatası (tekrar deneniyor): ${err.message}`);
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error(`Bazocam dönüştürme zaman aşımı (${maxWaitMs / 1000} saniye)`);
}

// MP3 İndirme — Bazocam converter.php API Entegrasyonu
app.get("/download/mp3", async (req, res) => {
  try {
    const { videoId, kbps } = req.query;

    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: "Invalid or missing videoId" });
    }

    // Kalite seçimi: 128, 192 veya 320 kbps
    const quality = ["128", "192", "320"].includes(kbps) ? kbps : "128";

    // Config'den provider ayarlarını oku
    const config = getCachedConfig();
    const mp3Config = config.mp3Provider || { bazocam: true, backend: true };
    const bazocamEnabled = mp3Config.bazocam !== false;
    const backendEnabled = mp3Config.backend !== false;

    console.log(`[DOWNLOAD_MP3] Provider ayarları — Bazocam: ${bazocamEnabled}, Backend: ${backendEnabled}`);

    // BAZOCAM ile dene (açıksa)
    if (bazocamEnabled) {
      try {
        const apiUrl = `https://bazocam.net/converter.php?action=api&PASS=${BAZOCAM_PASS}&youtubeID=${videoId}&kbps=${quality}`;
        console.log(`[DOWNLOAD_MP3] Bazocam API çağrılıyor: ${videoId} (${quality}kbps)`);

        const apiResponse = await axiosClient.get(apiUrl, { timeout: 15000 });
        const data = apiResponse.data;

        console.log(`[DOWNLOAD_MP3] Bazocam yanıt: status=${data.status} | job=${data.job_id || "?"}`);

        if (data.status === "cached" && (data.download || data.download_url)) {
          console.log(`[DOWNLOAD_MP3] Bazocam CACHE HIT: ${videoId}`);
          return await streamMp3FromUrl(data.download || data.download_url, videoId, data.title, res);
        }

        if (data.status === "converting" && data.status_url && (data.download || data.download_url)) {
          console.log(`[DOWNLOAD_MP3] Bazocam dönüştürüyor: ${videoId} (job: ${data.job_id || "?"})`);
          const finalDownloadUrl = await pollConversionStatus(data.status_url, data.download || data.download_url, 120000);
          console.log(`[DOWNLOAD_MP3] Dönüştürme tamamlandı, MP3 aktarılıyor: ${videoId}`);
          return await streamMp3FromUrl(finalDownloadUrl, videoId, data.title, res);
        }

        throw new Error(`Bazocam beklenmeyen yanıt: ${JSON.stringify(data).substring(0, 200)}`);

      } catch (apiErr) {
        console.warn(`[DOWNLOAD_MP3] BAZOCAM BAŞARISIZ (${apiErr.message}).`);

        // Bazocam başarısız — backend açıksa yedek olarak devam et
        if (backendEnabled) {
          console.log(`[DOWNLOAD_MP3] Backend yedek sisteme geçiliyor...`);
          if (!res.headersSent) {
            res.setHeader("Content-Disposition", `attachment; filename=audio_${videoId}.m4a`);
            await ytdlpStream(videoId, "audio", req, res);
          }
          return;
        }

        // İkisi de çalışmadı
        if (!res.headersSent) {
          return res.status(500).json({ error: "Bazocam failed and backend fallback is disabled" });
        }
      }
    }
    // Sadece backend açıksa (bazocam kapalı)
    else if (backendEnabled) {
      console.log(`[DOWNLOAD_MP3] Bazocam kapalı, backend ile indiriliyor: ${videoId}`);
      if (!res.headersSent) {
        res.setHeader("Content-Disposition", `attachment; filename=audio_${videoId}.m4a`);
        await ytdlpStream(videoId, "audio", req, res);
      }
    }
    // İkisi de kapalı
    else {
      console.warn(`[DOWNLOAD_MP3] Her iki provider da kapalı!`);
      if (!res.headersSent) {
        return res.status(503).json({ error: "MP3 download is currently disabled" });
      }
    }

  } catch (err) {
    console.error("[DOWNLOAD_MP3] FATAL ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Audio download failed" });
    } else {
      res.end();
    }
  }
});

//mp4 - VERİ ANINDA AKAR — progress bar çalışır
app.get("/download/mp4", async (req, res) => {
  try {
    const { videoId } = req.query;

    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: "Invalid or missing videoId" });
    }

    const typeStr = "video";
    const extStr = "mp4";

    // KATMAN -1: FFmpeg Media Library (kalıcı MP4 dosyası)
    const mediaTrack = mediaLib.getReadyTrack(videoId, "mp4");
    if (mediaTrack && mediaTrack.files?.mp4 && fs.existsSync(mediaTrack.files.mp4)) {
      const fileToPipe = mediaTrack.files.mp4;
      const fStats = fs.statSync(fileToPipe);
      console.log(`[DOWNLOAD_MP4] Media Library'den sunuluyor: ${videoId} (${(fStats.size / 1024 / 1024).toFixed(2)} MB)`);
      mediaLib.recordAccess(videoId);
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", fStats.size);
      res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
      return res.sendFile(fileToPipe);
    }

    // KATMAN 0: Disk cache — iki format kontrol (video_videoId.mp4 + videoId.mp4)
    const localFile = path.join(VIDEO_CACHE_DIR, `${typeStr}_${videoId}.${extStr}`);
    const altFile = path.join(VIDEO_CACHE_DIR, `${videoId}.${extStr}`);
    const diskFile = fs.existsSync(localFile) ? localFile : (fs.existsSync(altFile) ? altFile : null);
    if (diskFile) {
      const fileStats = fs.statSync(diskFile);
      if (fileStats.size < 150 * 1024) {
        fs.unlinkSync(diskFile);
      } else {
        console.log(`[DOWNLOAD_MP4] Cache Hit! ${videoId} (${(fileStats.size / 1024 / 1024).toFixed(2)} MB)`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", fileStats.size);
        res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
        return res.sendFile(diskFile);
      }
    }

    // KATMAN 1: CLOUDFLARE R2
    const r2Key = `video/${videoId}.mp4`;
    try {
      const r2Data = await getR2Stream(r2Key);
      if (r2Data && r2Data.stream) {
        console.log(`[DOWNLOAD_MP4] R2'den sunuluyor: ${videoId}`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
        if (r2Data.contentLength) res.setHeader("Content-Length", r2Data.contentLength);
        return safePipe(r2Data.stream, res);
      }
    } catch (e) { }

    // KATMAN 2: URL CACHE
    const cacheKey = `stream:video:${videoId}`;
    const cached = await cacheGet(cacheKey);
    let streamUrl, ua;

    if (cached && cached.url) {
      streamUrl = cached.url;
      ua = cached.ua || getRandomUA();
      console.log(`[DOWNLOAD_MP4] URL Cache Hit: ${videoId}`);
    } else {
      console.log(`[DOWNLOAD_MP4] Stream URL çözümleniyor: ${videoId}`);
      ua = getRandomUA();
      const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
      const countryClient = getPlayerClientForCountry(country);

      streamUrl = await queue.add(() => resolveStreamUrlWithFallback(videoId, "video", ua, countryClient));
      await cacheSet(cacheKey, { url: streamUrl, ua }, STREAM_CACHE_DURATION);
    }

    if (!streamUrl || typeof streamUrl !== "string" || !streamUrl.startsWith("http")) {
      return res.status(500).json({ error: "Video URL çözümlenemedi" });
    }

    // 3. Stream'i direkt Android'e aktar
    console.log(`[DOWNLOAD_MP4] Stream aktarılıyor: ${videoId}`);
    const response = await axiosClient({
      method: "GET",
      url: streamUrl.toString().trim(),
      responseType: "stream",
      timeout: 120000,
      headers: { "User-Agent": ua, "Referer": "https://www.youtube.com/" },
      validateStatus: (status) => status < 400,
      ...getProxyAxiosConfig({ _targetUrl: streamUrl.toString().trim() }, videoId)
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
    if (response.headers["content-length"]) res.setHeader("Content-Length", response.headers["content-length"]);

    safePipe(response.data, res);

    // ARKA PLANDA - FFmpeg ile videoyu kalıcı kaydet
    if (!mediaLib.getReadyTrack(videoId, "mp4") && !mediaLib.isProcessing(videoId)) {
      const metadata = { title: req.query.title || "Unknown", artist: req.query.uploader || "Unknown" };
      mediaLib.upsertTrack(videoId, { ...metadata, category: "watching", status: "processing" });
      const cookiePath = getRandomCookie();
      const proxyUrl = getRandomProxy(videoId);
      ffmpegWorker.processVideo(videoId, metadata, { cookiePath, proxyUrl })
        .then(result => {
          mediaLib.markReady(videoId, result);
          ffmpegWorker.downloadThumbnail(videoId).then(thumb => {
            if (thumb) mediaLib.upsertTrack(videoId, { thumbnail: thumb, status: "ready" });
          }).catch(() => { });
        })
        .catch(err => {
          mediaLib.markFailed(videoId, err.message);
        });
    }

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

// ---------------- DISK MANAGER ----------------
// NOT: Eski Railway döneminden kalan 350MB limitli manageDiskSpace() kaldırıldı.
// Disk yönetimi artık tek noktadan yapılıyor: checkDiskSpaceAndCleanup() (10GB limit, 60 saniyede bir)
// + Media Library cleanup (50GB, 180 gün) + R2 cleanup (9GB, 60 gün)

// ==========================================
// PROXY PANEL v2 — PREMIUM YÖNETİM PANELİ
// ==========================================
// ADMIN ANASAYFA — tüm panellere tek noktadan erişim
app.get("/admin", basicAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Melodia Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #0f0f11;
      color: #fff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px;
    }
    .logo {
      font-size: 32px;
      font-weight: 800;
      background: linear-gradient(135deg, #a855f7, #6366f1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 6px;
    }
    .subtitle {
      color: #666;
      font-size: 14px;
      margin-bottom: 48px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 20px;
      width: 100%;
      max-width: 900px;
    }
    .card {
      background: #1a1a1f;
      border: 1px solid #2a2a35;
      border-radius: 16px;
      padding: 28px 24px;
      text-decoration: none;
      color: #fff;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 18px;
    }
    .card:hover {
      background: #22222a;
      border-color: #a855f7;
      transform: translateY(-2px);
      box-shadow: 0 8px 32px rgba(168,85,247,0.15);
    }
    .icon {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      flex-shrink: 0;
    }
    .card-info h3 { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
    .card-info p  { font-size: 13px; color: #888; }
    .stats {
      width: 100%;
      max-width: 900px;
      background: #1a1a1f;
      border: 1px solid #2a2a35;
      border-radius: 16px;
      padding: 20px 24px;
      margin-top: 20px;
      display: flex;
      gap: 40px;
      flex-wrap: wrap;
    }
    .stat { text-align: center; }
    .stat-value { font-size: 24px; font-weight: 700; color: #a855f7; }
    .stat-label { font-size: 12px; color: #666; margin-top: 2px; }
    .footer { margin-top: 40px; color: #444; font-size: 13px; }
  </style>
</head>
<body>
  <div class="logo">🎵 Melodia</div>
  <div class="subtitle">Admin Paneli — music.cevapla.tv</div>

  <div class="grid">
    <a class="card" href="/cache-panel">
      <div class="icon" style="background:#1e293b">💾</div>
      <div class="card-info">
        <h3>Cache Panel</h3>
        <p>Media önbelleği yönetimi</p>
      </div>
    </a>
    <a class="card" href="/proxy-panel">
      <div class="icon" style="background:#1e2a1e">🔁</div>
      <div class="card-info">
        <h3>Proxy Panel</h3>
        <p>Proxy havuzu ve ban yönetimi</p>
      </div>
    </a>
    <a class="card" href="/playlist-cache">
      <div class="icon" style="background:#2a1e1e">🎶</div>
      <div class="card-info">
        <h3>Playlist Cache</h3>
        <p>Top 50 önbellekleme</p>
      </div>
    </a>
    <a class="card" href="/converter">
      <div class="icon" style="background:#1e1e2a">🔄</div>
      <div class="card-info">
        <h3>Converter</h3>
        <p>MP3/MP4 dönüştürücü</p>
      </div>
    </a>
    <a class="card" href="/admin/stats">
      <div class="icon" style="background:#2a1e2a">📊</div>
      <div class="card-info">
        <h3>İstatistikler</h3>
        <p>Sunucu & API durumu</p>
      </div>
    </a>
    <a class="card" href="/health">
      <div class="icon" style="background:#1e2a24">❤️</div>
      <div class="card-info">
        <h3>Health Check</h3>
        <p>Sistem sağlık durumu</p>
      </div>
    </a>
    <a class="card" href="/admin/panel" style="border-color:#7c3aed">
      <div class="icon" style="background:#2d1f4e">🎛️</div>
      <div class="card-info">
        <h3>React Panel</h3>
        <p>Config, Popup & Kanal Yönetimi</p>
      </div>
    </a>
  </div>

  <div class="footer">music.cevapla.tv · Melodia Backend v1.0</div>

  <script>
    // Sunucu uptime göster
    fetch('/health').then(r=>r.json()).then(d=>{
      const h = Math.floor(d.uptimeSeconds/3600);
      const m = Math.floor((d.uptimeSeconds%3600)/60);
      document.querySelector('.subtitle').textContent =
        'Admin Paneli · Uptime: ' + h + 's ' + m + 'dk · RAM: ' + d.memoryRssMB + ' MB';
    }).catch(()=>{});
  </script>
</body>
</html>`);
});

// React Admin Panel — static dosyaları servis et
const REACT_PANEL_DIR = path.join(__dirname, "admin_panel");
app.use("/admin/panel", basicAuth, express.static(REACT_PANEL_DIR));
app.get("/admin/panel/*", basicAuth, (req, res) => {
  const indexPath = path.join(REACT_PANEL_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("React panel build bulunamadı. admin_panel/ klasörüne build dosyalarını koyun.");
  }
});

// ==========================================
// ADMIN_PASS ve basicAuth dosyanın başında tanımlı (satır ~15)
const PANEL_TEMPLATE = path.join(__dirname, "proxy_panel.html");

app.get("/proxy-panel", basicAuth, (req, res) => {
  loadProxyData();
  autoUnbanProxies();

  let html = fs.readFileSync(PANEL_TEMPLATE, "utf-8");

  // Message
  const msgHtml = req.query.msg ? `<div class="alert">${decodeURIComponent(req.query.msg)}</div>` : "";
  html = html.replace("%%MESSAGE%%", msgHtml);

  // Stats
  const activeCount = proxyData.active.length;
  const bannedCount = proxyData.banned.length;
  const totalCount = activeCount + bannedCount;
  const healthyCount = proxyData.active.filter(p => p.testResult === "ok" || !p.testResult).length;
  const healthPct = totalCount > 0 ? Math.round((healthyCount / totalCount) * 100) + "%" : "—";

  html = html.replace(/%%ACTIVE_COUNT%%/g, activeCount);
  html = html.replace(/%%BANNED_COUNT%%/g, bannedCount);
  html = html.replace(/%%TOTAL_COUNT%%/g, totalCount);
  html = html.replace(/%%HEALTH_PCT%%/g, healthPct);
  html = html.replace(/%%ADMIN_PASS%%/g, "");
  html = html.replace("%%LAST_HEALTH%%", proxyData.lastHealthCheck ? new Date(proxyData.lastHealthCheck).toLocaleString("tr-TR") : "Henüz yapılmadı");

  // Active list
  const activeHtml = proxyData.active.map(p => {
    const score = getProxyHealthScore(p);
    const scoreColor = score >= 80 ? "#10b981" : score >= 50 ? "#f59e0b" : "#ef4444";
    const dotClass = p.testResult === "ok" ? "green" : p.testResult === "banned" ? "red" : p.testResult === "error" ? "yellow" : "gray";
    const latencyClass = (p.latencyMs || 0) < 200 ? "fast" : (p.latencyMs || 0) < 500 ? "medium" : "slow";
    const totalUse = (p.successCount || 0) + (p.failCount || 0);
    const displayIp = p.ip.replace(/^https?:\/\//, "");

    return `<tr>
      <td><code>${displayIp}</code> <span data-test-ip="${p.ip}" class="test-res" onclick="testProxy('${p.ip}',this)"></span></td>
      <td><span class="dot ${dotClass}"></span>${p.testResult === "ok" ? "Aktif" : p.testResult === "banned" ? "Banlı!" : p.testResult === "error" ? "Hata" : "Belirsiz"}</td>
      <td><div class="health-bar"><div class="health-bar-fill" style="width:${score}%;background:${scoreColor}"></div></div>${score}%</td>
      <td><span class="latency ${latencyClass}">${p.latencyMs ? p.latencyMs + "ms" : "—"}</span></td>
      <td>${totalUse} istek</td>
      <td>
        <button class="btn btn-test" data-test-ip="${p.ip}" onclick="testProxy('${p.ip}',this)">Test</button>
        <button class="btn btn-ban" onclick="doAction('ban','${p.ip}')">Ban</button>
        <button class="btn btn-del" onclick="doAction('delete','${p.ip}')">Sil</button>
      </td>
    </tr>`;
  }).join("");
  html = html.replace("%%ACTIVE_LIST%%", activeHtml);
  html = html.replace("%%ACTIVE_EMPTY%%", activeCount === 0 ? '<div style="padding:20px;text-align:center;color:#52525b">Aktif proxy yok. Yukarıdan ekleyin.</div>' : "");

  // Banned list
  const bannedHtml = proxyData.banned.map(p => {
    const timeLeft = Math.max(0, Math.round((new Date(p.auto_unban_at).getTime() - Date.now()) / 60000));
    const displayIp = p.ip.replace(/^https?:\/\//, "");
    return `<tr>
      <td><code>${displayIp}</code></td>
      <td>${timeLeft > 0 ? timeLeft + " dk" : "Süresi doldu"}</td>
      <td>${p.banCount || 1}x</td>
      <td>
        <button class="btn btn-unban" onclick="doAction('unban','${p.ip}')">Ban Kaldır</button>
        <button class="btn btn-del" onclick="doAction('delete','${p.ip}')">Sil</button>
      </td>
    </tr>`;
  }).join("");
  html = html.replace("%%BANNED_LIST%%", bannedHtml);
  html = html.replace("%%BANNED_EMPTY%%", bannedCount === 0 ? '<div style="padding:20px;text-align:center;color:#52525b">Banlı proxy yok ✓</div>' : "");

  // Ban history
  const history = (proxyData.banHistory || []).slice(-30).reverse();
  html = html.replace("%%HISTORY_COUNT%%", history.length);
  const historyHtml = history.map(h => {
    const actionClass = h.action === "ban" ? "action-ban" : "action-unban";
    const actionText = h.action === "ban" ? "⛔ BANLANDI" : h.action === "auto_unban" ? "✅ Otomatik açıldı" : "✅ Manuel açıldı";
    const displayIp = h.ip.replace(/^https?:\/\//, "");
    return `<div class="history-item"><span class="time">${new Date(h.time).toLocaleString("tr-TR")}</span><code>${displayIp}</code><span class="${actionClass}">${actionText}</span>${h.reason ? `<span style="color:#71717a">(${h.reason})</span>` : ""}</div>`;
  }).join("");
  html = html.replace("%%HISTORY_LIST%%", historyHtml || '<div style="padding:20px;text-align:center;color:#52525b">Henüz geçmiş yok</div>');

  res.send(html);
});

app.post("/proxy-panel", express.urlencoded({ extended: true }), basicAuth, (req, res) => {
  if (req.body.pass !== ADMIN_PASS) return res.redirect('/proxy-panel?msg=Hatali Sifre');

  loadProxyData();
  const action = req.body.action;
  let proxyIp = (req.body.proxy_ip || '').trim();
  if (proxyIp && !proxyIp.startsWith("http")) proxyIp = "http://" + proxyIp;
  let msg = "Islem yapildi";

  if (action === 'add_bulk') {
    // Toplu ekleme: textarea'dan birden fazla proxy
    const lines = (req.body.proxy_list || '').split('\n').map(l => l.trim()).filter(l => l.length > 5);
    let added = 0;
    for (let line of lines) {
      if (!line.startsWith("http")) line = "http://" + line;
      if (!proxyData.active.find(p => p.ip === line) && !proxyData.banned.find(p => p.ip === line)) {
        proxyData.active.push({ ip: line, added: new Date().toISOString(), successCount: 0, failCount: 0, lastUsed: null, lastTested: null, latencyMs: null, banCount: 0, testResult: null });
        added++;
      }
    }
    msg = `${added} proxy eklendi`;
  } else if (action === 'add' && proxyIp) {
    if (!proxyData.active.find(p => p.ip === proxyIp) && !proxyData.banned.find(p => p.ip === proxyIp)) {
      proxyData.active.push({ ip: proxyIp, added: new Date().toISOString(), successCount: 0, failCount: 0, lastUsed: null, lastTested: null, latencyMs: null, banCount: 0, testResult: null });
      msg = "Eklendi";
    } else msg = "Zaten var";
  } else if (action === 'delete') {
    proxyData.active = proxyData.active.filter(p => p.ip !== proxyIp);
    proxyData.banned = proxyData.banned.filter(p => p.ip !== proxyIp);
    msg = "Silindi";
  } else if (action === 'ban') {
    banProxy(proxyIp);
    msg = "Banlandi";
  } else if (action === 'unban') {
    const bProxy = proxyData.banned.find(p => p.ip === proxyIp);
    if (bProxy) {
      proxyData.banned = proxyData.banned.filter(p => p.ip !== proxyIp);
      proxyData.active.push({ ip: proxyIp, added: new Date().toISOString(), successCount: 0, failCount: 0, lastUsed: null, lastTested: null, latencyMs: null, banCount: bProxy.banCount || 0, testResult: null });
      if (!proxyData.banHistory) proxyData.banHistory = [];
      proxyData.banHistory.push({ ip: proxyIp, action: "manual_unban", time: new Date().toISOString() });
      msg = "Ban Kaldirildi";
    }
  }

  saveProxyData();
  proxyPool = proxyData.active.map(p => p.ip);
  res.redirect('/proxy-panel?msg=' + encodeURIComponent(msg));
});

// Test endpoint — JSON yanıt (latency dahil)
app.get("/proxy-panel/test", basicAuth, async (req, res) => {
  const proxy = req.query.ip;
  if (!proxy) return res.json({ status: "error", error: "IP gerekli" });
  try {
    const start = Date.now();
    const response = await axiosClient.get("https://www.youtube.com", {
      proxy: false,
      httpsAgent: new HttpsProxyAgent(proxy),
      timeout: 15000,
      validateStatus: () => true
    });
    const latency = Date.now() - start;

    // proxy_data'da latency güncelle
    loadProxyData();
    const p = proxyData.active.find(x => x.ip === proxy);
    if (p) { p.latencyMs = latency; p.lastTested = new Date().toISOString(); p.testResult = response.status === 200 ? "ok" : "banned"; saveProxyData(); }

    if (response.status === 200) res.json({ status: "ok", latency, code: 200 });
    else if (response.status === 429 || response.status === 403) res.json({ status: "banned", latency, code: response.status });
    else res.json({ status: "unknown", latency, code: response.status });
  } catch (err) {
    loadProxyData();
    const p = proxyData.active.find(x => x.ip === proxy);
    if (p) { p.lastTested = new Date().toISOString(); p.testResult = "error"; saveProxyData(); }
    res.json({ status: "error", error: err.message });
  }
});

// ---------------- CONVERTER PAGE ----------------
app.get("/converter", basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "converter.html"));
});

// ---------------- PLAYLIST CACHE ----------------
app.get("/playlist-cache", basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "playlist_cache.html"));
});

app.post("/admin/cache-playlist", express.json(), basicAuth, async (req, res) => {
  const { playlistId, type } = req.body;
  if (!playlistId) return res.status(400).json({ error: "Playlist ID required" });

  res.json({ success: true, message: "Started in background" });

  global.playlistJobs = global.playlistJobs || {};
  global.playlistJobs[playlistId] = { total: 0, processed: 0, status: 'fetching', currentTitle: '' };

  // Background job
  try {
    console.log(`[PLAYLIST_CACHE] Başlatıldı: ${playlistId} (${type})`);
    
    // yt-dlp ile playlistteki videoları çek
    const result = await ytdlp(`https://www.youtube.com/playlist?list=${playlistId}`, {
      flatPlaylist: true,
      dumpSingleJson: true
    });
    
    const data = typeof result === 'object' ? result : JSON.parse(result.toString());
    const entries = data.entries || [];
    console.log(`[PLAYLIST_CACHE] ${entries.length} video bulundu.`);
    
    global.playlistJobs[playlistId].total = entries.length;
    global.playlistJobs[playlistId].status = 'downloading';
    
    for (const entry of entries) {
      const videoId = entry.id;
      const title = entry.title || "Unknown";
      
      if (!videoId) continue;
      
      global.playlistJobs[playlistId].currentTitle = title;
      
      const isVideo = type === "video";
      const ext = isVideo ? "mp4" : "m4a";
      
      if (!mediaLib.getReadyTrack(videoId, ext) && !mediaLib.isProcessing(videoId)) {
        console.log(`[PLAYLIST_CACHE] Kuyruğa ekleniyor: ${videoId} (${title})`);
        
        const metadata = { title, artist: "Playlist Cache" };
        const category = isVideo ? "watching" : "listening";
        
        mediaLib.upsertTrack(videoId, { ...metadata, category, status: "processing" });
        
        const cookiePath = getRandomCookie();
        const proxyUrl = getRandomProxy(videoId);
        
        const processPromise = isVideo 
          ? ffmpegWorker.processVideo(videoId, metadata, { cookiePath, proxyUrl })
          : ffmpegWorker.processAudio(videoId, metadata, { format: "m4a", cookiePath, proxyUrl });
          
        try {
          const result = await processPromise;
          mediaLib.markReady(videoId, result);
          console.log(`[PLAYLIST_CACHE] Başarılı: ${videoId}`);
        } catch (pErr) {
          mediaLib.markFailed(videoId, pErr.message);
          console.warn(`[PLAYLIST_CACHE] Başarısız: ${videoId}: ${pErr.message}`);
        }
        
        // YouTube'u boğmamak için araya 5 saniye gecikme koyuyoruz
        await new Promise(r => setTimeout(r, 5000));
      }
      global.playlistJobs[playlistId].processed++;
    }
    global.playlistJobs[playlistId].status = 'completed';
    console.log(`[PLAYLIST_CACHE] Tamamlandı: ${playlistId}`);
  } catch (e) {
    console.error(`[PLAYLIST_CACHE_ERR] Hata: ${e.message}`);
    if (global.playlistJobs[playlistId]) {
      global.playlistJobs[playlistId].status = 'error';
      global.playlistJobs[playlistId].error = e.message;
    }
  }
});

app.get("/admin/playlist-progress", basicAuth, (req, res) => {
  const { playlistId } = req.query;
  if (!playlistId) return res.status(400).json({ error: "Playlist ID required" });
  
  global.playlistJobs = global.playlistJobs || {};
  res.json(global.playlistJobs[playlistId] || { status: 'not_found' });
});

// ---------------- CACHE PANEL ----------------
const CACHE_PANEL_TEMPLATE = path.join(__dirname, "cache_panel.html");

app.get("/cache-panel", basicAuth, (req, res) => {
  let html = fs.readFileSync(CACHE_PANEL_TEMPLATE, "utf-8");
  const stats = mediaLib.getStats();
  const tracks = mediaLib.getAllTracks({ sortBy: "lastAccessed" });

  let tempCount = 0;
  try { if (fs.existsSync(CACHE_DIR)) tempCount = fs.readdirSync(CACHE_DIR).length; } catch (e) { }

  html = html.replace("%%TOTAL_CACHE%%", stats.readyTracks);
  html = html.replace("%%TOTAL_REQUESTS%%", stats.totalProcessed + stats.totalFailed);
  html = html.replace("%%CACHE_SIZE%%", stats.totalDiskMB);
  html = html.replace("%%TEMP_FILES%%", tempCount);
  html = html.replace(/%%ADMIN_PASS%%/g, "");

  const listHtml = tracks.map((t, idx) => {
    const totalSize = (t.fileSize?.m4a || 0) + (t.fileSize?.mp3 || 0) + (t.fileSize?.mp4 || 0);
    const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
    const date = t.processedAt ? new Date(t.processedAt).toLocaleString("tr-TR") : "—";
    const quality = t.files.mp4 ? "MP4" : t.files.mp3 ? "192 kbps" : "128 kbps";
    
    // Tür etiketi (Eski kayıtlar için otomatik tespit ekledik)
    let categoryHtml = "";
    const effectiveCategory = t.category || (t.files.mp4 ? "watching" : "listening");

    if (effectiveCategory === "listening") categoryHtml = '<span class="badge blue">🎧 Dinleme</span>';
    else if (effectiveCategory === "watching") categoryHtml = '<span class="badge red">📺 İzleme</span>';
    else categoryHtml = '<span class="badge gray">📦 Cache</span>';

    // İstek barı (maksimum 10 üzerinden oranla)
    const reqPct = Math.min(100, (t.accessCount || 0) * 10);

    return `<tr data-requests="${t.accessCount || 0}" data-size="${sizeMB}" data-date="${t.processedAt || ''}">
      <td>${idx + 1}</td>
      <td>
        <div class="track-info">
          <span class="track-title">${t.title}</span>
          <span class="track-id">${t.videoId}</span>
        </div>
      </td>
      <td>${categoryHtml}</td>
      <td><span class="badge-quality">${quality}</span></td>
      <td>
        <div class="request-bar"><div class="request-fill" style="width:${reqPct}%"></div></div>
        <span class="req-count">${t.accessCount || 0}</span>
      </td>
      <td>${sizeMB} MB</td>
      <td>${date}</td>
      <td>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteItem('${t.videoId}')">Sil</button>
      </td>
    </tr>`;
  }).join("");

  html = html.replace("%%CACHE_LIST%%", listHtml);
  html = html.replace("%%CACHE_EMPTY%%", tracks.length === 0 ? '<div style="padding:40px;text-align:center;color:#8e8e8e">Henüz cachelenmiş şarkı yok.</div>' : "");

  res.send(html);
});

app.post("/cache-panel/action", express.json(), basicAuth, (req, res) => {
  const { action, videoId, pass } = req.body;
  if (pass !== ADMIN_PASS) return res.status(403).json({ error: "Şifre hatalı" });

  if (action === "delete" && videoId) {
    mediaLib.removeTrack(videoId);
    return res.json({ ok: true });
  } else if (action === "clear_all") {
    mediaLib.clearAllTracks();
    return res.json({ ok: true });
  }

  res.status(400).json({ error: "Geçersiz işlem" });
});

app.get("/proxy-panel/health-check", basicAuth, async (req, res) => {
  await runHealthCheck();
  res.json({ ok: true, tested: proxyData.active.length });
});

/* =========================
   POPUP / DUYURU SİSTEMİ
========================= */
const ANNOUNCEMENTS_FILE = path.join(__dirname, "announcements.json");

function loadAnnouncements() {
  try {
    if (!fs.existsSync(ANNOUNCEMENTS_FILE)) fs.writeFileSync(ANNOUNCEMENTS_FILE, "[]");
    return JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, "utf-8"));
  } catch (e) {
    return [];
  }
}

function saveAnnouncements(data) {
  fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(data, null, 2));
}

// Tüm duyuruları listele (admin)
app.get("/announcements", (req, res) => {
  res.json(loadAnnouncements());
});

// Aktif duyuruları getir (Android uygulaması için, ülke filtreli)
app.get("/popup/active", (req, res) => {
  const country = (req.query.country || "").toUpperCase();
  const now = new Date();
  const all = loadAnnouncements();
  const active = all.filter(ann => {
    const start = ann.startTime ? new Date(ann.startTime) : null;
    const end = ann.endTime ? new Date(ann.endTime) : null;
    if (start && now < start) return false;
    if (end && now > end) return false;
    if (ann.countries === "all") return true;
    if (Array.isArray(ann.countries) && country) return ann.countries.includes(country);
    return true;
  });
  res.json(active);
});

// Yeni duyuru oluştur (admin)
app.post("/popup/create", express.json(), (req, res) => {
  const { title, message, buttons, countries, startTime, endTime } = req.body;
  if (!title || !message) return res.status(400).json({ error: "title ve message zorunlu" });
  if (!Array.isArray(buttons) || buttons.length === 0) return res.status(400).json({ error: "en az bir buton gerekli" });

  const all = loadAnnouncements();
  const newAnn = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title,
    message,
    buttons,
    countries: countries || "all",
    startTime: startTime || null,
    endTime: endTime || null,
    createdAt: new Date().toISOString(),
    votes: {}
  };
  all.unshift(newAnn);
  saveAnnouncements(all);
  res.json({ id: newAnn.id, ok: true });
});

// Duyuruyu sil (admin)
app.delete("/popup/:id", (req, res) => {
  const all = loadAnnouncements();
  const filtered = all.filter(a => a.id !== req.params.id);
  if (filtered.length === all.length) return res.status(404).json({ error: "Bulunamadı" });
  saveAnnouncements(filtered);
  res.json({ ok: true });
});

// Oy gönder (Android uygulaması)
app.post("/popup/vote", express.json(), (req, res) => {
  const { announcementId, buttonValue } = req.body;
  if (!announcementId || !buttonValue) return res.status(400).json({ error: "announcementId ve buttonValue zorunlu" });

  const all = loadAnnouncements();
  const ann = all.find(a => a.id === announcementId);
  if (!ann) return res.status(404).json({ error: "Duyuru bulunamadı" });

  if (!ann.votes) ann.votes = {};
  ann.votes[buttonValue] = (ann.votes[buttonValue] || 0) + 1;
  saveAnnouncements(all);
  res.json({ ok: true, votes: ann.votes });
});

/* =========================
   DEVICE ACTIONS (Cihaz Komutları)
   Admin panelden Android cihazlara komut gönderme
========================= */
const DEVICE_ACTIONS_FILE = path.join(__dirname, "device_actions.json");

function loadDeviceActions() {
  try {
    if (!fs.existsSync(DEVICE_ACTIONS_FILE)) fs.writeFileSync(DEVICE_ACTIONS_FILE, "[]");
    return JSON.parse(fs.readFileSync(DEVICE_ACTIONS_FILE, "utf-8"));
  } catch (e) {
    return [];
  }
}

function saveDeviceActions(data) {
  fs.writeFileSync(DEVICE_ACTIONS_FILE, JSON.stringify(data, null, 2));
}

// Tüm device action'ları listele (admin)
app.get("/device-actions", (req, res) => {
  res.json(loadDeviceActions());
});

// Aktif device action'ı getir (Android uygulaması polling)
app.get("/device-action/active", (req, res) => {
  const all = loadDeviceActions();
  const now = new Date();
  const active = all.find(a => {
    if (!a.active) return false;
    if (a.expiresAt && new Date(a.expiresAt) < now) return false;
    return true;
  });
  res.json(active || null);
});

// Yeni device action oluştur (admin)
app.post("/device-action/create", express.json(), (req, res) => {
  const { actionType, mode, value, label } = req.body;
  // actionType: "chrome_url" | "package_name" | "review_sheet"
  // mode: "direct" | "popup"
  // value: URL veya paket adı
  // label: popup modunda gösterilecek metin (opsiyonel)
  if (!actionType || !mode) return res.status(400).json({ error: "actionType ve mode zorunlu" });
  if (actionType !== "review_sheet" && !value) return res.status(400).json({ error: "value zorunlu" });

  const all = loadDeviceActions();
  // Önceki aktif action'ı deaktif et
  all.forEach(a => a.active = false);

  const newAction = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    actionType,
    mode,
    value: actionType === "review_sheet" ? "market://details?id=com.ringtone.master" : value,
    label: label || null,
    active: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 saat geçerli
    createdAt: new Date().toISOString(),
    executedCount: 0
  };
  all.unshift(newAction);
  saveDeviceActions(all);
  res.json({ id: newAction.id, ok: true });
});

// Device action'ı sil (admin)
app.delete("/device-action/:id", (req, res) => {
  const all = loadDeviceActions();
  const filtered = all.filter(a => a.id !== req.params.id);
  if (filtered.length === all.length) return res.status(404).json({ error: "Bulunamadı" });
  saveDeviceActions(filtered);
  res.json({ ok: true });
});

// Device action deaktif et (admin)
app.post("/device-action/:id/deactivate", (req, res) => {
  const all = loadDeviceActions();
  const action = all.find(a => a.id === req.params.id);
  if (!action) return res.status(404).json({ error: "Bulunamadı" });
  action.active = false;
  saveDeviceActions(all);
  res.json({ ok: true });
});

// Device action executed bildir (Android)
app.post("/device-action/executed", express.json(), (req, res) => {
  const { actionId } = req.body;
  if (!actionId) return res.status(400).json({ error: "actionId zorunlu" });
  const all = loadDeviceActions();
  const action = all.find(a => a.id === actionId);
  if (!action) return res.status(404).json({ error: "Bulunamadı" });
  action.executedCount = (action.executedCount || 0) + 1;
  saveDeviceActions(all);
  res.json({ ok: true, executedCount: action.executedCount });
});