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
// NOT: BAZOCAM_PASS kaldırıldı. API kimlik bilgileri artık env'de değil,
// panel'den yönetilen config.json'daki provider'larda (apiKey alanı) tutuluyor.
const ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) {
  console.error("[SECURITY] ADMIN_PASS env değişkeni zorunludur! .env dosyasına ekleyin.");
  process.exit(1);
}
const basicAuth = (req, res, next) => {
  // X-App-Key ile React admin panel erişimi (master VEYA uygulamaya özel key).
  // resolveAppFromKey aşağıda function-declaration olarak tanımlı → hoist edilir.
  const _xkey = req.headers["x-app-key"];
  if (_xkey && (_xkey === APP_SECRET || resolveAppFromKey(_xkey))) {
    return next();
  }
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
const os = require("os");
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

// Dosya R2'de VARSA yeniden yüklemez, sadece son erişim zamanını tazeler.
// Disk cache HIT yollarında uploadToR2 yerine bu kullanılır (her dinlemede
// aynı dosyayı R2'ye tekrar yüklemek Class A kotasını ve bandı tüketiyordu).
const r2InFlight = new Set();
async function ensureInR2(key, filePath) {
  if (!r2Client) return;
  if (r2InFlight.has(key)) return;
  try {
    if (await redis.hexists("r2:last_access", key)) {
      redis.hset("r2:last_access", key, Date.now().toString()).catch(() => {});
      stats.r2UploadSkipped++;
      return;
    }
    if (await existsInR2(key)) {
      await trackR2Access(key);
      stats.r2UploadSkipped++;
      return;
    }
    r2InFlight.add(key);
    try {
      await uploadToR2(key, filePath);
      stats.r2UploadDone++;
    } finally {
      r2InFlight.delete(key);
    }
  } catch (err) {
    r2InFlight.delete(key);
  }
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

// 4 GÜN (96 saat) dinlenmeyen cache dosyaları otomatik silinir. .env'de CACHE_MAX_IDLE_HOURS ile değiştirilir.
// Not: Süre uzadıkça disk daha dolu kalır ama cache isabet oranı artar → şarkılar daha hızlı açılır.
const CACHE_MAX_IDLE_MS = (parseInt(process.env.CACHE_MAX_IDLE_HOURS) || 96) * 60 * 60 * 1000;

// Cache dosyası dinlendiğinde "son erişim" zamanını GÜNCELLE (mtime = şimdi).
// Böylece 24 saat boyunca hiç dinlenmeyen dosyalar checkDiskSpaceAndCleanup ile silinir,
// düzenli dinlenenler ise diskte kalır. (R2'deki r2:last_access mantığının disk karşılığı.)
function touchCache(filePath) {
  const nowDate = new Date();
  fs.promises.utimes(filePath, nowDate, nowDate).catch(() => {});
}

// Dosya varsa stat'ını, yoksa null döner — ASENKRON.
// Hot path'te (şarkı açılırken) fs.existsSync + fs.statSync kullanılıyordu; bunlar
// event loop'u bloke ettiği için yoğun anlarda TÜM istekler sıraya giriyordu.
// Tek asenkron çağrı hem "var mı" hem "boyut" sorusunu cevaplar.
async function statOrNull(filePath) {
  if (!filePath) return null;
  try { return await fs.promises.stat(filePath); } catch (_) { return null; }
}

// Async disk temizleme — event loop'u bloke etmez
async function checkDiskSpaceAndCleanup() {
  try {
    const allDirs = [CACHE_DIR, VIDEO_CACHE_DIR];
    let allFiles = [];
    const now = Date.now();

    for (const dir of allDirs) {
      try { await fs.promises.access(dir); } catch { continue; }
      const entries = await fs.promises.readdir(dir);
      // stat'ları 64'lük gruplar halinde PARALEL al. Eskiden tek tek await ediliyordu:
      // binlerce dosyada bu, dosya sunan istekleri bekletiyordu.
      for (let i = 0; i < entries.length; i += 64) {
        const chunk = entries.slice(i, i + 64);
        const stats = await Promise.all(chunk.map(async f => {
          const p = path.join(dir, f);
          try { return { path: p, stat: await fs.promises.stat(p), name: f }; }
          catch (_) { return null; }   // dosya silinmiş olabilir
        }));
        for (const s of stats) if (s) allFiles.push(s);
      }
    }

    // Temp dosyaları temizle — TÜM klasörler tarandıktan SONRA bir kez.
    // (Eskiden klasör döngüsünün içindeydi → aynı dosyalar iki kez taranıyordu.)
    for (const file of allFiles) {
      if ((file.path.endsWith('.tmp') || file.path.endsWith('.ytdl') || file.path.includes('.part') || file.path.includes('.fallback')) && (now - file.stat.mtimeMs > 10 * 60 * 1000)) {
        try { await fs.promises.unlink(file.path); console.log(`[DISK_CLEANUP] Eski temp silindi: ${file.path}`); } catch (e) { }
      }
    }

    // ZAMAN BAZLI TEMİZLİK: 24 saattir DİNLENMEYEN cache dosyalarını sil (disk dolmasa bile).
    // mtime, dinlenince touchCache ile "şimdi"ye çekiliyor → mtime = son dinlenme zamanı.
    const survivors = [];
    let idleDeleted = 0, idleFreed = 0;
    for (const file of allFiles) {
      const isMedia = file.name.endsWith('.mp3') || file.name.endsWith('.m4a') || file.name.endsWith('.mp4');
      if (isMedia && (now - file.stat.mtimeMs > CACHE_MAX_IDLE_MS)) {
        try {
          await fs.promises.unlink(file.path);
          idleDeleted++; idleFreed += file.stat.size;
        } catch (_) { survivors.push(file); }
      } else {
        survivors.push(file);
      }
    }
    if (idleDeleted > 0) {
      console.log(`[DISK_CLEANUP] ${idleDeleted} dosya ${Math.round(CACHE_MAX_IDLE_MS / 3600000)} saattir dinlenmediği için silindi, ${(idleFreed / 1024 / 1024).toFixed(1)} MB açıldı.`);
    }
    allFiles = survivors;

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
// Temizlik 60 SANİYEDE BİR değil, 10 DAKİKADA BİR. Binlerce dosyanın stat'ını
// her dakika almak, dosya sunan isteklerle aynı I/O havuzunu tüketip kasmaya yol
// açıyordu. Disk 125GB limitli ve dolma hızı düşük — 10 dakika fazlasıyla yeterli.
if (isPrimaryWorker) setInterval(checkDiskSpaceAndCleanup, 10 * 60 * 1000);
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
  totalRequests: 0,
  r2UploadDone: 0,
  r2UploadSkipped: 0
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
app.disable("x-powered-by");

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
  allowedHeaders: ["Content-Type", "X-Timestamp", "X-Signature", "X-App-Key", "X-App-Id", "X-App-Package", "X-Country", "X-Device-Id", "Authorization", "X-Stream-Token", "X-Extractor", "X-Android-Sdk", "X-App-Version", "X-App-Mode"],
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
    if (Math.abs(Date.now() - parseInt(timestamp)) > 30 * 60 * 1000) {
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

    recordLoginIp(req, "/auth/token");
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
  // Canlı kullanıcı sayacı — uygulamadan gelen her istek burada işaretlenir (fire&forget)
  recordPresence(req).catch(() => {});   // fire&forget — isteği asla bloklamaz
  // Tamamen açık endpoint'ler (minimum tutuldu — güvenlik için)
  if (req.path === "/health" || (req.path === "/config" && req.method === "GET") || req.path === "/auth/token" ||
      (req.path === "/blocked-channels" && req.method === "GET") ||
      (req.path === "/popup/active" && req.method === "GET") ||
      (req.path === "/popup/vote" && req.method === "POST") ||
      (req.path === "/feedback" && req.method === "POST") ||
      (req.path === "/review-log" && req.method === "POST") ||
      (req.path === "/device-action/active" && req.method === "GET") ||
      (req.path === "/device-action/executed" && req.method === "POST") ||
      (req.path === "/autocomplete" && req.method === "GET") ||
      req.path.startsWith("/top50/test") ||
      req.path === "/privacy-policy.html" || req.path === "/memo-music-privacy-policy.html" ||
      req.path === "/echoes-music-privacy-policy.html" ||
      req.path === "/child-safety-standards.html" ||
      req.path === "/loadtest") {
    return next();
  }
  // Admin panel frontend (X-App-Key ile doğrulama)
  const adminPaths = ["/config", "/blocked-channels", "/send-notification", "/announcements", "/popup", "/device-actions", "/device-action", "/feedbacks", "/feedback", "/admin/apps", "/admin/app-credentials", "/admin/users"];
  const isAdminPath = adminPaths.some(p => req.path === p || req.path.startsWith(p + "/"));
  const _adminKey = req.headers["x-app-key"];
  if (isAdminPath && _adminKey && (_adminKey === APP_SECRET || resolveAppFromKey(_adminKey))) {
    return next();
  }
  // Admin panel'ler — basicAuth zaten kendi içlerinde kontrol ediyor
  if (req.path.startsWith("/proxy-panel") || req.path.startsWith("/cache-panel") ||
      req.path.startsWith("/content-filter") ||
      req.path === "/playlist-cache" || req.path === "/admin/cache-playlist" || req.path === "/admin/playlist-progress" ||
      req.path === "/admin" || req.path.startsWith("/admin/panel") || req.path === "/converter" ||
      req.path === "/admin/login" || req.path === "/admin/logout" ||
      /^\/admin\/[a-z0-9_-]+\/panel/.test(req.path) ||
      req.path.startsWith("/admin/api-") || req.path.startsWith("/admin/smart-cache") ||
      req.path === "/admin/test-provider" ||
      req.path === "/admin/youtube" || req.path === "/admin/auto-ringtone" ||
      req.path === "/admin/login-ips" || req.path === "/admin/active-users" ||
      req.path === "/admin/review-logs") {
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
  if (Math.abs(now - parseInt(timestamp)) > 30 * 60 * 1000) {
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
  // Cloudflare CDN cache'i: 1 saat tut, tarayıcıda 5dk tut
  res.setHeader("Cache-Control", "public, s-maxage=3600, max-age=300");
}


/* =========================
   FILES & CONFIG (Bellekte cache'lenir — her istekte disk okuma yok)
========================= */
const CONFIG_FILE = "config.json";
const DATA_FILE = "blockedChannels.json";

/* =========================================================================
   ÇOK UYGULAMALI (MULTI-APP) İZOLASYON
   Her uygulama (musica, Memo Music, ...) kendi config/popup/device/blocked
   dosyalarını kullanır. "default" = musica → dosyalar KÖKTE kalır (taşıma yok).
   Diğer uygulamalar → data/<appId>/ altında.
   appId kaynağı: Android "X-App-Id" header'ı VEYA panel "?appId=" query'si.
   Bilinmeyen/boş appId → "default" (fail-open: sahadaki eski istemciler bozulmaz).
========================================================================= */
const APPS_FILE = path.join(__dirname, "apps.json");
let _cachedApps = null;
function getApps() {
  if (_cachedApps) return _cachedApps;
  try {
    _cachedApps = fs.existsSync(APPS_FILE) ? JSON.parse(fs.readFileSync(APPS_FILE, "utf-8")) : {};
  } catch (e) { _cachedApps = {}; }
  // "default" her zaman bulunsun (dosya bozuk/eksik olsa bile musica çalışır)
  if (!_cachedApps.default) {
    _cachedApps.default = { id: "default", name: "Musica", packageName: "com.descargarmusica.abb" };
  }
  return _cachedApps;
}
function saveApps(data) {
  fs.writeFileSync(APPS_FILE, JSON.stringify(data, null, 2));
  _cachedApps = null;
}
// İstekten appId çöz. Sadece [a-z0-9_-] — path traversal engellenir.
function resolveAppId(req) {
  // Uygulamaya özel admin key ile gelen istek → appId KİLİTLİ.
  // ?appId= veya X-App-Id header'ı yok sayılır (çapraz-uygulama erişimi engellenir).
  const bound = resolveAppFromKey(req.headers["x-app-key"]);
  if (bound) return bound;
  // Uygulama kendi paket adını (applicationId) X-App-Package ile bildirir →
  // apps.json'daki packageName ile eşle. Böylece yeni paket eklerken Android'de
  // kod değişmez; sadece panelde app kaydı (packageName ile) yeterli olur.
  const pkg = (req.headers["x-app-package"] || "").toString().trim();
  if (pkg) {
    const apps = getApps();
    for (const id of Object.keys(apps)) {
      if (apps[id] && apps[id].packageName && apps[id].packageName === pkg) return id;
    }
  }
  const raw = (req.headers["x-app-id"] || (req.query && req.query.appId) || "").toString();
  const slug = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return getApps()[slug] ? slug : "default";
}

/* =========================================================================
   ÇOK-PANELLİ İZOLASYON — uygulamaya özel admin kimliği + panel cookie'si
   Her uygulamanın admin key'i ve panel şifresi master APP_SECRET'ten HMAC ile
   TÜRETİLİR — git'e/dosyaya hiçbir sır yazılmaz, sunucudaki APP_SECRET yeter.
   (function declaration → hoist edilir; yukarıdaki basicAuth/middleware çağırabilir.)
========================================================================= */
function perAppKey(appId) {
  return crypto.createHmac("sha256", APP_SECRET).update("appkey:" + appId).digest("hex");
}
function perAppPass(appId) {
  return crypto.createHmac("sha256", APP_SECRET).update("apppass:" + appId).digest("hex").slice(0, 14);
}
// Verilen X-App-Key hangi uygulamaya ait? default/master hariç → appId | null
function resolveAppFromKey(key) {
  if (!key || key === APP_SECRET) return null;
  const apps = getApps();
  for (const id of Object.keys(apps)) {
    if (id === "default") continue;
    if (key === perAppKey(id)) return id;
  }
  return null;
}
// İzole panel oturum cookie'si (imzalı, 12 saat) — statik varlık erişimini açar
function signPanelCookie(appId) {
  const payload = appId + "." + (Date.now() + 12 * 3600 * 1000);
  const sig = crypto.createHmac("sha256", APP_SECRET).update("panelcookie:" + payload).digest("hex").slice(0, 32);
  return payload + "." + sig;
}
function verifyPanelCookie(val) {
  if (!val) return null;
  const parts = String(val).split(".");
  if (parts.length !== 3) return null;
  const [appId, exp, sig] = parts;
  const expect = crypto.createHmac("sha256", APP_SECRET).update("panelcookie:" + appId + "." + exp).digest("hex").slice(0, 32);
  if (sig !== expect || Date.now() > Number(exp)) return null;
  if (!getApps()[appId] || appId === "default") return null;
  return appId;
}
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  const hit = raw.split(/;\s*/).find(c => c.startsWith(name + "="));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

// Sadece MASTER (süper admin) mı? Per-app key ile gelen isteklerde false.
// İzole panel yöneticileri başka uygulamaların giriş bilgilerini GÖRMEMELİ.
function isMasterRequest(req) {
  if (req.headers["x-app-key"] === APP_SECRET) return true;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const [u, p] = Buffer.from(authHeader.split(" ")[1], "base64").toString().split(":");
      if (u === "admin" && p === ADMIN_PASS) return true;
    } catch (e) {}
  }
  return false;
}
// active-users / login-ips gibi presence & IP kayıtları için KAPSAM çöz:
//   • per-app key  → o uygulama (kilitli, ?appId yok sayılır — çapraz erişim yok)
//   • master/admin → ?appId= verilmişse o uygulama; yoksa null (GLOBAL, tüm app'ler)
// resolveAppId'den farkı: master + appId yok → "default" DEĞİL, null (global) döner.
// Böylece süper panelde dropdown'dan app seçince presence/IP o app'e daralır.
function resolveScopeApp(req) {
  const bound = resolveAppFromKey(req.headers["x-app-key"]);
  if (bound) return bound;
  if (!isMasterRequest(req)) return null;
  const raw = ((req.query && req.query.appId) || "").toString().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return (raw && raw !== "default" && getApps()[raw]) ? raw : null;
}
// Bir uygulamanın izole panel giriş bilgileri (yol + kullanıcı + şifre).
function panelCredentials(appId) {
  return { id: appId, panelPath: `/admin/${appId}/panel`, user: appId, pass: perAppPass(appId) };
}

/* =========================================================================
   KİŞİSEL PANEL GİRİŞİ — kullanıcı adı + şifre. Her kullanıcının "apps" kapsamı:
     "all"            → süper (tüm uygulamalar, master key, dropdown açık)
     ["ogzmusic", ..] → sadece o uygulama(lar) (o app'in key'i, kilitli)
   Şifreler APP_SECRET ile HMAC'lenir. panel_users.json (gitignore) tutulur;
   ilk açılışta varsayılanlarla tohumlanır — şifreleri panelden değiştir.
========================================================================= */
const PANEL_USERS_FILE = path.join(__dirname, "panel_users.json");
let _cachedPanelUsers = null;
function hashPw(pw) {
  return crypto.createHmac("sha256", APP_SECRET).update("pw:" + String(pw)).digest("hex");
}
function getPanelUsers() {
  if (_cachedPanelUsers) return _cachedPanelUsers;
  try {
    if (fs.existsSync(PANEL_USERS_FILE)) {
      _cachedPanelUsers = JSON.parse(fs.readFileSync(PANEL_USERS_FILE, "utf-8"));
      return _cachedPanelUsers;
    }
  } catch (e) {}
  _cachedPanelUsers = {
    beyza: { pass: hashPw("beyza2026"), apps: "all", super: true },
    olcay: { pass: hashPw("olcay2026"), apps: "all", super: true },
    oguz:  { pass: hashPw("oguz2026"),  apps: ["ogzmusic"] }
  };
  try { fs.writeFileSync(PANEL_USERS_FILE, JSON.stringify(_cachedPanelUsers, null, 2)); } catch (e) {}
  return _cachedPanelUsers;
}
function savePanelUsers(obj) {
  fs.writeFileSync(PANEL_USERS_FILE, JSON.stringify(obj, null, 2));
  _cachedPanelUsers = obj;
}
function verifyPanelUser(username, password) {
  const u = String(username || "").toLowerCase().trim();
  const rec = getPanelUsers()[u];
  if (!rec || rec.pass !== hashPw(password)) return null;
  return { user: u, apps: rec.apps, super: !!rec.super };
}
// Oturum cookie'si (imzalı, 30 gün) — sadece kullanıcı adını taşır; yetki her seferinde dosyadan okunur.
function signSession(username) {
  const payload = username + "." + (Date.now() + 30 * 24 * 3600 * 1000);
  const sig = crypto.createHmac("sha256", APP_SECRET).update("psess:" + payload).digest("hex").slice(0, 32);
  return payload + "." + sig;
}
function verifySession(val) {
  if (!val) return null;
  const parts = String(val).split(".");
  if (parts.length !== 3) return null;
  const [user, exp, sig] = parts;
  const expect = crypto.createHmac("sha256", APP_SECRET).update("psess:" + user + "." + exp).digest("hex").slice(0, 32);
  if (sig !== expect || Date.now() > Number(exp)) return null;
  const rec = getPanelUsers()[user];
  if (!rec) return null;
  return { user, apps: rec.apps, super: !!rec.super };
}
// Oturumdan panel enjeksiyonu: {appId, appKey}
function sessionInjection(sess) {
  if (!sess) return null;
  if (sess.apps === "all" || sess.super) return { appId: "", appKey: APP_SECRET };
  const list = Array.isArray(sess.apps) ? sess.apps : [];
  if (list.length >= 1) return { appId: list[0], appKey: perAppKey(list[0]) };
  return null;
}
// Google-benzeri giriş sayfası (sunucudan render — build gerekmez)
function loginPageHtml() {
  return `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0b12">
<title>Melodia — Panel Girişi</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a11;--card:rgba(24,24,35,.72);--line:rgba(255,255,255,.08);--txt:#e8eaf2;--dim:#8b93a7;--accent:#a78bfa;--accent2:#7c3aed}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--txt);min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;overflow:hidden;position:relative}
/* arka plan ışık lekeleri */
.blob{position:fixed;border-radius:50%;filter:blur(90px);opacity:.5;pointer-events:none;z-index:0}
.b1{width:420px;height:420px;background:#7c3aed;top:-140px;left:-120px;animation:f1 18s ease-in-out infinite}
.b2{width:360px;height:360px;background:#2563eb;bottom:-130px;right:-110px;animation:f2 22s ease-in-out infinite}
.b3{width:260px;height:260px;background:#db2777;top:45%;right:18%;opacity:.28;animation:f1 26s ease-in-out infinite reverse}
@keyframes f1{0%,100%{transform:translate(0,0)}50%{transform:translate(40px,50px)}}
@keyframes f2{0%,100%{transform:translate(0,0)}50%{transform:translate(-50px,-40px)}}
.card{position:relative;z-index:1;width:100%;max-width:390px;background:var(--card);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);border:1px solid var(--line);border-radius:22px;padding:40px 34px 32px;box-shadow:0 30px 80px rgba(0,0,0,.55);animation:in .5s cubic-bezier(.2,.8,.2,1)}
@keyframes in{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}
.logo{font-size:44px;text-align:center;line-height:1;margin-bottom:14px;animation:beat 3.5s ease-in-out infinite}
@keyframes beat{0%,100%{transform:scale(1)}50%{transform:scale(1.09)}}
h1{font-size:27px;font-weight:800;text-align:center;letter-spacing:-.5px;background:linear-gradient(120deg,#c4b5fd,#a78bfa,#60a5fa);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.sub{font-size:13px;color:var(--dim);text-align:center;margin:6px 0 28px}
.err{background:rgba(190,40,60,.14);border:1px solid rgba(248,113,113,.34);color:#fca5a5;padding:11px 14px;border-radius:12px;font-size:13px;margin-bottom:16px;display:none;text-align:center}
.err.show{display:block;animation:shake .45s}
@keyframes shake{10%,90%{transform:translateX(-2px)}20%,80%{transform:translateX(4px)}30%,50%,70%{transform:translateX(-7px)}40%,60%{transform:translateX(7px)}}
label{font-size:11px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--dim);display:block;margin-bottom:7px}
.grp{margin-bottom:17px;position:relative}
.ico{position:absolute;left:14px;top:38px;font-size:15px;opacity:.5;pointer-events:none}
input{width:100%;padding:13px 14px 13px 42px;background:rgba(10,10,17,.75);border:1px solid var(--line);border-radius:13px;color:#fff;font-size:15px;outline:none;transition:border-color .18s,box-shadow .18s}
input::placeholder{color:#4b5265}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(167,139,250,.16)}
.eye{position:absolute;right:8px;top:31px;background:none;border:none;color:var(--dim);cursor:pointer;font-size:15px;padding:6px 8px;border-radius:8px;width:auto;margin:0}
.eye:hover{color:var(--txt);background:rgba(255,255,255,.06)}
button[type=submit]{width:100%;margin-top:9px;padding:14px;background:linear-gradient(120deg,var(--accent2),#6366f1);color:#fff;border:none;border-radius:13px;font-size:15px;font-weight:700;cursor:pointer;transition:transform .15s,box-shadow .2s,opacity .2s;box-shadow:0 8px 24px rgba(124,58,237,.34)}
button[type=submit]:hover{transform:translateY(-1px);box-shadow:0 12px 30px rgba(124,58,237,.46)}
button[type=submit]:active{transform:translateY(0)}
button[type=submit]:disabled{opacity:.65;cursor:wait;transform:none}
.foot{margin-top:24px;text-align:center;font-size:11.5px;color:#5a6175}
@media(max-width:420px){.card{padding:32px 22px 26px;border-radius:18px}h1{font-size:24px}}
</style></head><body>
<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
<div class="card" id="card">
  <div class="logo">🎵</div>
  <h1>Melodia</h1>
  <div class="sub">Yönetim Paneli</div>
  <div class="err" id="err"></div>
  <form id="f" autocomplete="on">
    <div class="grp">
      <label for="u">Kullanıcı Adı</label>
      <span class="ico">👤</span>
      <input id="u" name="u" placeholder="kullanıcı adınız" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus>
    </div>
    <div class="grp">
      <label for="p">Şifre</label>
      <span class="ico">🔒</span>
      <input id="p" name="p" type="password" placeholder="••••••••" autocomplete="current-password">
      <button type="button" class="eye" id="eye" title="Şifreyi göster">👁</button>
    </div>
    <button type="submit" id="btn">Giriş Yap</button>
  </form>
  <div class="foot">music.cevapla.tv</div>
</div>
<script>
(function(){
  var f=document.getElementById('f'),err=document.getElementById('err'),btn=document.getElementById('btn'),
      card=document.getElementById('card'),eye=document.getElementById('eye'),p=document.getElementById('p');
  eye.addEventListener('click',function(){
    var show=p.type==='password';
    p.type=show?'text':'password';
    eye.textContent=show?'🙈':'👁';
    p.focus();
  });
  function fail(msg){
    err.textContent=msg;
    err.classList.remove('show');
    void err.offsetWidth;          // animasyonu yeniden tetikle
    err.classList.add('show');
    card.style.animation='none';void card.offsetWidth;card.style.animation='shake .45s';
    btn.disabled=false;btn.textContent='Giriş Yap';
  }
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var u=f.u.value.trim(),pw=f.p.value;
    if(!u||!pw){fail('Kullanıcı adı ve şifre gerekli');return;}
    btn.disabled=true;btn.textContent='Giriş yapılıyor...';
    fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({u:u,p:pw})})
      .then(function(r){
        // Giriş sonrası HER ZAMAN kart ekranına (/admin) git — panele oradan tıklanarak girilir.
        if(r.ok){btn.textContent='✓ Giriş başarılı';location.href='/admin';return;}
        // 401 = gerçekten yanlış şifre. Diğer kodlar sunucu/bağlantı sorunudur;
        // ikisini karıştırmak "şifrem doğru ama kabul etmiyor" sanısına yol açıyordu.
        if(r.status===401){fail('Kullanıcı adı veya şifre hatalı');}
        else{fail('Sunucuya bağlanılamadı (HTTP '+r.status+')');}
      })
      .catch(function(){fail('Sunucuya ulaşılamadı — bağlantını kontrol et');});
  });
})();
</script>
</body></html>`;
}
// appId'ye göre veri dosyası yolu. default → kök, diğerleri → data/<appId>/
function pathFor(appId, filename) {
  if (!appId || appId === "default") return path.join(__dirname, filename);
  return path.join(__dirname, "data", appId, filename);
}
// Non-default uygulama için data/<appId>/ klasörünü garanti et
function ensureAppData(appId) {
  if (!appId || appId === "default") return;
  try { fs.mkdirSync(path.join(__dirname, "data", appId), { recursive: true }); } catch (e) {}
}

// Config ve blocked channels bellekte tutulur, 60 saniyede bir yenilenir.
// Config artık uygulama başına cache'lenir: appId -> config nesnesi.
let _cachedConfigByApp = {};
let _configMtimeByApp = {};   // appId -> config dosyasının son okunan mtime'ı
let _cachedBlockedChannels = null;

/* CLUSTER TUTARLILIĞI (kalıcı fix — 2026-08-03):
   pm2 4 worker çalıştırıyor, her birinin AYRI bellek cache'i var. Eskiden bir
   worker config yazınca yalnız KENDİ cache'ini temizliyordu; diğer 3 worker
   60 sn boyunca eski değeri sunuyordu. Panelden art arda kaydetme yapıldığında
   eski cache'li worker tüm config'i geri yazıp az önce girilen ayarı (ör. TR
   ülke) EZİYORDU → "ayarlar kaydolmuyor" bunun sonucuydu.
   Çözüm: tek sunucuda tüm worker'lar aynı diski paylaşır. Config'i dosya
   mtime'ına bağladık — bir worker yazınca mtime değişir, diğerleri BİR SONRAKİ
   okumada anında diskten tazeler. Cross-worker mesajlaşmaya gerek yok. */
function getCachedConfig(appId = "default") {
  const fp = pathFor(appId, CONFIG_FILE);
  let mtime = 0;
  try { mtime = fs.statSync(fp).mtimeMs; } catch (e) {}
  // Cache geçerli SADECE dosya o günden beri değişmediyse
  if (_cachedConfigByApp[appId] && _configMtimeByApp[appId] === mtime) {
    return _cachedConfigByApp[appId];
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch (e) { cfg = {}; }
  // ringtoneAsns: bu ASN'lerden gelen cihazlar ulke/global ayarina bakilmadan
  // dogrudan zil sesi moduna gider. Eski config.json'larda alan yok -> bos dizi.
  if (!Array.isArray(cfg.ringtoneAsns)) cfg.ringtoneAsns = [];
  // contentFilter: arama sonuçlarında canlı yayınları ve çok uzun videoları ele.
  // Eski config.json'larda alan yoksa varsayılanla doldur (panelden değiştirilebilir).
  if (!cfg.contentFilter || typeof cfg.contentFilter !== "object") {
    cfg.contentFilter = { enabled: true, maxDurationMinutes: 35, blockLive: true };
  } else {
    const cf = cfg.contentFilter;
    if (typeof cf.enabled !== "boolean") cf.enabled = true;
    if (typeof cf.blockLive !== "boolean") cf.blockLive = true;
    const m = Number(cf.maxDurationMinutes);
    cf.maxDurationMinutes = Number.isFinite(m) && m > 0 ? m : 35;
  }
  _cachedConfigByApp[appId] = cfg;
  _configMtimeByApp[appId] = mtime;
  return cfg;
}

function getCachedBlockedChannels() {
  if (_cachedBlockedChannels !== null) return _cachedBlockedChannels;
  try {
    const BLOCKED_FILE_PATH = path.join(__dirname, "blockedChannels.json");
    if (!fs.existsSync(BLOCKED_FILE_PATH)) return [];
    _cachedBlockedChannels = JSON.parse(fs.readFileSync(BLOCKED_FILE_PATH, "utf-8"));
  } catch (e) { _cachedBlockedChannels = []; }
  return _cachedBlockedChannels;
}

// Her 60 saniyede cache'i yenile (dosya değişikliklerini yakala)
setInterval(() => {
  _cachedConfigByApp = {};
  _cachedBlockedChannels = null;
}, 60000);

if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    global: { enabled: true, mode: "youtube" },
    countries: {},
    mp3Provider: { bazocam: true, backend: true },
    apiProviders: {
      providers: [
        {
          id: "bazocam",
          name: "Bazocam",
          enabled: true,
          priority: 1,
          baseUrl: "https://bazocam.net",
          apiKey: "bzc_7mK2pXr9Qw1Lz4Ny",
          endpoints: {
            mp3: "/mp3download.php?id={id}&key={key}&b={bitrate}",
            mp4: "/mp4download.php?id={id}&key={key}&q={quality}",
            search: "/searchapi.php?search={query}&key={key}",
            autocomplete: "/ototamamlamaapi.php?search={query}&key={key}"
          }
        }
      ],
      apiKey: "bzc_7mK2pXr9Qw1Lz4Ny",
      baseUrl: "https://bazocam.net",
      smartCache: { enabled: true, minRequests: 3 }
    }
  }, null, 2));
}

/* =========================
   API PROVIDER SİSTEMİ — bazocam.net üzerinden 3. parti API yönetimi
   gamma (yt2mp3.ai), cnv (y2mate), youtubemp3.ltd
========================= */

function getApiProviderConfig() {
  const config = getCachedConfig();
  // Sabit API yok — config.json'da provider yoksa boş döner.
  // Tüm API'ler panel'den (config.json) yönetilir.
  return config.apiProviders || {
    providers: [],
    apiKey: "",
    baseUrl: "",
    smartCache: { enabled: true, minRequests: 3 }
  };
}

// Akıllı Cache: İstek sayacı — sadece N+ istek gelen şarkılar cache'lenir
/* Sayacın ömrü = bir şarkının "kaç kez dinlendiği"nin hatırlanma süresi.
   ESKİDEN 24 saat: cache'lenmek için gereken 2 dinlemenin İLK dinlemeden
   itibaren 24 saat içinde olması gerekiyordu. Günde bir dinlenen şarkı 2'ye
   hiç ulaşamıyor, sayaç sıfırlanıyor ve şarkı ASLA diske inmiyordu — her
   seferinde provider'a gidiyordu.
   7 GÜN ile "hafta içinde 2 kez" dinlenenler de cache'leniyor. Redis maliyeti
   ihmal edilebilir (şarkı başına tek küçük anahtar; Redis şu an ~10 MB). */
const REQ_COUNT_TTL = 7 * 86400; // 7 gün

async function incrementRequestCount(videoId) {
  try {
    const key = `req_count:${videoId}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, REQ_COUNT_TTL);
    return count;
  } catch { return 1; }
}

async function shouldCache(videoId) {
  const providerConfig = getApiProviderConfig();
  /* Varsayılan 3 → 1: bir şarkının diske inmesi için 3 kez dinlenmesi
     gerekiyordu; üstelik sayacın ömrü 24 saat olduğu için "günde bir dinlenen"
     şarkı 3'e hiç ulaşamıyor ve HER seferinde provider'a gidiyordu. 1 ile her
     şarkı ilk dinlemede diske iner, ikinci dinlemeden itibaren anında gelir.
     Disk buna müsait (%37 dolu, 92 GB boş, 125 GB tavan + 96 saat idle silme).
     NOT: Panelde smartCache.minRequests ayarlıysa O KAZANIR — burası sadece
     panelde değer yoksa geçerli olan varsayılan. */
  const minReq = providerConfig.smartCache?.minRequests || 1;
  if (!providerConfig.smartCache?.enabled) return true;
  try {
    const count = parseInt(await redis.get(`req_count:${videoId}`) || "0");
    return count >= minReq;
  } catch {
    /* Redis okunamadıysa eskiden false dönüyordu → cache HİÇ dolmuyordu.
       Artık true: Redis geçici olarak düşse bile şarkılar diske inmeye devam
       eder. Atomik yazma sayesinde riski yok. */
    return true;
  }
}

/* NEGATİF CACHE — provider'ın çeviremediği videolar.
   Tüm provider'lar başarısız olunca videoId kısa süre işaretlenir; bu sürede
   gelen istekler 100 saniyelik retry zincirini yeniden başlatmak yerine anında
   503 alır. Süre kısa tutuldu: geçici bir provider kesintisi uzun sürmesin.
   Not: bu kontrol TÜM cache katmanlarından SONRA çalışır — diske/R2'ye inmiş
   bir şarkı işaretli olsa bile normal şekilde sunulmaya devam eder. */
const API_FAIL_TTL = parseInt(process.env.API_FAIL_TTL_SEC) || 600;

// Redis çağrısını istek akışını bloklayamaz hale getirir (yanıt gecikirse eski davranış).
function redisFast(promise, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => setTimeout(() => resolve(fallback), 500))
  ]);
}

async function isApiFailed(kind, videoId) {
  return (await redisFast(redis.exists(`fail:${kind}:${videoId}`), 0)) === 1;
}

function markApiFailed(kind, videoId) {
  try {
    redis.set(`fail:${kind}:${videoId}`, "1", "EX", API_FAIL_TTL).catch(() => {});
  } catch (e) {}
}

// ───────────────────────────────────────────────────────────────────────────
// KÜME GENELİ TEK-AKIŞ (single-flight) — aynı videoId için aynı anda TEK dönüştürme.
// pm2 çok worker çalıştırıyor; her worker'ın belleği AYRI olduğu için aynı uncached
// şarkı birden fazla worker'da PARALEL çevriliyor ve bazocam'ın tek çalışan
// sağlayıcısını (gamma/ytmp3.gl) boğuyordu → "HTML/JSON döndürdü" ve 500 hataları.
// Bu kilit Redis'te (paylaşımlı) tutulur → tüm cluster bir şarkı için TEK çeviri yapar.
// FARKLI şarkılar etkilenmez (kilit videoId başına) — hepsi paralel devam eder.
//
// GÜVENLİK ("asla bozma"): Redis erişilemez/timeout olursa kilit "alınmış" sayılır
// (fallback "OK") → sistem BUGÜNKÜ gibi davranır, hiçbir isteği bloklamaz.
// TTL, bir worker çökse bile şarkının sonsuza dek kilitli kalmamasını garanti eder.
const CONVERT_LOCK_TTL_MS = parseInt(process.env.CONVERT_LOCK_TTL_MS) || 75000;
async function acquireConvertLock(kind, videoId) {
  try {
    const r = await redisFast(
      redis.set(`convlock:${kind}:${videoId}`, String(process.pid), "PX", CONVERT_LOCK_TTL_MS, "NX"),
      "OK" // Redis hata/timeout → kilit alınmış say → engelleme YOK, eski davranış
    );
    return r === "OK";
  } catch (e) {
    return true; // her ihtimale karşı: asla bloklama
  }
}
function releaseConvertLock(kind, videoId) {
  try { redis.del(`convlock:${kind}:${videoId}`).catch(() => {}); } catch (e) {}
}

/* Negatif cache yanıtı bilerek GECİKTİRİLİR.
   MusicService.onPlayerError sahadaki APK'da hata alınca aynı videoyu SINIRSIZ
   yeniden deniyor. Bugün provider retry zinciri ~35 sn sürdüğü için bu döngü
   yavaş. Anında 503 dönersek döngü saniyeler seviyesine iner ve sunucu kendi
   kendini döver. Bekleme, provider'a hiç gitmediği için ücretsiz (sadece timer);
   istemcinin gördüğü süre bugünküyle aynı kalır. */
const API_FAIL_DELAY_MS = parseInt(process.env.API_FAIL_DELAY_MS) || 25000;

function sendApiFailResponse(req, res, message) {
  const timer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", String(API_FAIL_TTL));
    res.status(503).json({ error: message, retryable: true });
  }, API_FAIL_DELAY_MS);
  timer.unref();
  req.on("close", () => clearTimeout(timer));
}

// bazocam.net API çağrıları — yeni endpoint'ler
//
// ÖNEMLİ: bazocam başarısız olduğunda HTTP 200 + content-type "audio/mpeg" ile
// "Not Found" (9 byte) gibi BOŞ yanıt dönebiliyor. Bunu gerçek dosya sanıp
// diske/R2'ye kaydetmek sonsuz "kaydet→bozuk→sil→tekrar" döngüsüne yol açar.
// Bu yüzden stream'in ilk byte'larını kontrol edip gerçek medya mı diye doğruluyoruz.
//   - MP3 gerçek dosya: "ID3" etiketi (49 44 33) veya frame sync (0xFF 0xEx) ile başlar
//   - MP4 gerçek dosya: 4-8. byte'larda "ftyp" kutusu bulunur
function validateMediaStream(srcStream, kind) {
  return new Promise((resolve, reject) => {
    const { PassThrough } = require("stream");
    let head = Buffer.alloc(0);
    let done = false;

    const cleanup = () => {
      srcStream.removeListener("data", onData);
      srcStream.removeListener("end", onEnd);
      srcStream.removeListener("error", onErr);
    };
    const fail = (msg) => {
      if (done) return;
      done = true;
      cleanup();
      try { srcStream.destroy(); } catch {}
      reject(new Error(msg));
    };
    const ok = () => {
      if (done) return;
      done = true;
      cleanup();
      const out = new PassThrough();
      out.write(head);          // doğrulama için tükettiğimiz baş kısmı geri yaz
      srcStream.pipe(out);      // gerisi normal aksın
      resolve(out);
    };
    const check = () => {
      if (kind === "audio") {
        if (head.slice(0, 3).toString("latin1") === "ID3") return ok();
        if (head.length >= 2 && head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) return ok();
      } else {
        if (head.length >= 8 && head.slice(4, 8).toString("latin1") === "ftyp") return ok();
      }
      // Geçerli imza yok; karar vermek için yeterli byte geldiyse reddet
      if (head.length >= 12) {
        const preview = head.slice(0, 16).toString("latin1").replace(/[^ -~]/g, ".");
        return fail(`Geçersiz medya yanıtı (${kind}): "${preview}"`);
      }
    };
    const onData = (chunk) => { head = Buffer.concat([head, chunk]); check(); };
    const onEnd = () => {
      check();
      const preview = head.toString("latin1").slice(0, 40);
      fail(`API yanıtı çok küçük/bozuk (${head.length} byte): "${preview}"`);
    };
    const onErr = (e) => fail(e.message);

    srcStream.on("data", onData);
    srcStream.on("end", onEnd);
    srcStream.on("error", onErr);
  });
}

// ─────────────────────────────────────────────────────────────
// ÇOKLU API PROVIDER SİSTEMİ
// Her provider kendi baseUrl + apiKey + endpoint şablonlarına sahip.
// Panelden yeni API eklenince backend otomatik kullanır — UYGULAMA GÜNCELLENMEZ.
// İstekler priority sırasına göre denenir; biri çökerse sonrakine geçilir.
// Şablon değişkenleri: {id} {key} {bitrate} {quality} {query}
// ─────────────────────────────────────────────────────────────
const DEFAULT_ENDPOINTS = {
  mp3: "/mp3download.php?id={id}&key={key}&b={bitrate}",
  mp4: "/mp4download.php?id={id}&key={key}&q={quality}",
  search: "/searchapi.php?search={query}&key={key}",
  autocomplete: "/ototamamlamaapi.php?search={query}&key={key}"
};

// Config'i normalize et — eski (tek baseUrl) ve yeni (provider başına baseUrl) şemayı destekler
function normalizeProviders(includeDisabled = false) {
  const cfg = getApiProviderConfig();
  // ═══════════════════════════════════════════════════════════════════════
  //  KANIT #3 — API ve KEY bilgisi NEREDEN geliyor?
  //  cfg = getApiProviderConfig() → config.json'u okur (PANELİN yazdığı dosya).
  //  Yani tüm API adresleri + key'ler config.json'da; kodda SABİT değil.
  //  Panelden API/key değiştirince config.json değişir → bu fonksiyon yeni
  //  değeri okur → uygulamaya hiç dokunulmaz (APK güncellenmez).
  // ═══════════════════════════════════════════════════════════════════════
  const fallbackBase = (cfg.baseUrl || "").replace(/\/+$/, "");
  const fallbackKey = cfg.apiKey || "";
  let list = (cfg.providers || []).map(p => ({
    id: p.id,
    name: p.name || p.id,
    enabled: p.enabled !== false,
    priority: (p.priority != null) ? p.priority : 99,
    baseUrl: (p.baseUrl || fallbackBase).replace(/\/+$/, ""),  // ← panelden gelen API adresi
    apiKey: p.apiKey || fallbackKey,                            // ← panelden gelen KEY
    endpoints: { ...DEFAULT_ENDPOINTS, ...(p.endpoints || {}) } // ← panelden gelen URL şablonları
  }));
  if (list.length === 0) {
    list.push({
      id: "default", name: "Default", enabled: true, priority: 1,
      baseUrl: fallbackBase, apiKey: fallbackKey, endpoints: { ...DEFAULT_ENDPOINTS }
    });
  }
  if (!includeDisabled) list = list.filter(p => p.enabled);
  return list.sort((a, b) => a.priority - b.priority);
}

// ═══════════════════════════════════════════════════════════════════════════
//  KANIT #4 — API + KEY tam burada birleşiyor (otomatik).
//  provider.baseUrl + provider.apiKey ikisi de config.json'dan (panelden) geldi.
//  Şablondaki {key} → provider.apiKey, {id}/{query} → istek parametreleri.
//  Üretilen URL örneği:  https://[PANEL_BASEURL]/mp3download.php?id=X&key=[PANEL_KEY]&b=320
//  → Panelden ne girersen URL otomatik ona göre oluşur. Kod sabit değil.
// ═══════════════════════════════════════════════════════════════════════════
function buildProviderUrl(provider, type, params) {
  const tpl = provider.endpoints[type] || DEFAULT_ENDPOINTS[type]; // panelden gelen şablon
  const all = { key: provider.apiKey, ...params };                 // {key} = panel'deki API key
  const path = tpl.replace(/\{(\w+)\}/g, (m, k) => {
    const v = all[k];
    return v === undefined ? "" : encodeURIComponent(v);
  });
  return provider.baseUrl + path;  // panel'deki Base URL + key'li yol = tam istek adresi
}

// Provider (bazocam vb.) cache'inde OLMAYAN şarkıda dönüştürmeye başlar ve iş bitene
// kadar HTML/JSON ("işleniyor") döner ya da hiç yanıt vermez. Eski ayar (2 deneme,
// aralarında 1.2 sn) dönüşüm sürerken pes ediyordu → yeni/az dinlenen şarkılarda
// sürekli 503. Deneme sayısı ve aralar dönüşüme zaman tanıyacak şekilde artırıldı.
const API_RETRY_DELAYS_MS = [15000, 20000]; // 1.→2. deneme arası, 2.→3. arası
async function apiStreamMp3(videoId, bitrate = 320) {
  const providers = normalizeProviders(); //panelden apileri çek
  const ATTEMPTS = 3;
  let lastErr;
  for (const provider of providers) { // her gelen apiyi sırayla dene 
    const url = buildProviderUrl(provider, "mp3", { id: videoId, bitrate });
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        console.log(`[API_PROVIDER:${provider.id}] MP3 stream: ${videoId} (${bitrate}kbps) — deneme ${attempt}/${ATTEMPTS}`);

        const response = await axiosClient({
          method: "GET",
          url,
          responseType: "stream",
          timeout: 120000,
          validateStatus: (status) => status === 200,
          headers: { "User-Agent": getRandomUA() }
        });

        const contentType = response.headers["content-type"] || "";
        if (contentType.includes("text/html") || contentType.includes("json")) {
          try { response.data.destroy(); } catch {}
          throw new Error("API HTML/JSON döndürdü — MP3 dosyası bekleniyor");
        }

        const cacheHeader = response.headers["x-cache"] || "";
        const validStream = await validateMediaStream(response.data, "audio");
        console.log(`[API_PROVIDER:${provider.id}] MP3 yanıt OK: ${videoId} | cache=${cacheHeader}`);

        return {
          stream: validStream,
          contentType: response.headers["content-type"],
          contentLength: response.headers["content-length"],
          cacheHit: cacheHeader === "HIT"
        };
      } catch (err) {
        lastErr = err;
        console.warn(`[API_PROVIDER:${provider.id}] MP3 deneme ${attempt}/${ATTEMPTS} başarısız: ${videoId} — ${err.message}`);
        if (attempt < ATTEMPTS) await new Promise(r => setTimeout(r, API_RETRY_DELAYS_MS[attempt - 1] || 20000));
      }
    }
    console.warn(`[API_PROVIDER:${provider.id}] MP3 tüm denemeler başarısız — sonraki provider'a geçiliyor`);
  }
  throw lastErr || new Error("Tüm API provider'ları başarısız (MP3)");
}

async function apiStreamMp4(videoId, quality = 720) {
  const providers = normalizeProviders();
  const ATTEMPTS = 3; // MP3 ile aynı gerekçe: dönüşüm süresine zaman tanı
  let lastErr;
  for (const provider of providers) {
    const url = buildProviderUrl(provider, "mp4", { id: videoId, quality });
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        console.log(`[API_PROVIDER:${provider.id}] MP4 stream: ${videoId} (${quality}p) — deneme ${attempt}/${ATTEMPTS}`);

        const response = await axiosClient({
          method: "GET",
          url,
          responseType: "stream",
          timeout: 120000,
          validateStatus: (status) => status === 200,
          headers: { "User-Agent": getRandomUA() }
        });

        const contentType = response.headers["content-type"] || "";
        if (contentType.includes("text/html") || contentType.includes("json")) {
          try { response.data.destroy(); } catch {}
          throw new Error("API HTML/JSON döndürdü — MP4 dosyası bekleniyor");
        }

        const validStream = await validateMediaStream(response.data, "video");

        return {
          stream: validStream,
          contentType: response.headers["content-type"],
          contentLength: response.headers["content-length"]
        };
      } catch (err) {
        lastErr = err;
        console.warn(`[API_PROVIDER:${provider.id}] MP4 deneme ${attempt}/${ATTEMPTS} başarısız: ${videoId} — ${err.message}`);
        if (attempt < ATTEMPTS) await new Promise(r => setTimeout(r, API_RETRY_DELAYS_MS[attempt - 1] || 20000));
      }
    }
    console.warn(`[API_PROVIDER:${provider.id}] MP4 tüm denemeler başarısız — sonraki provider'a geçiliyor`);
  }
  throw lastErr || new Error("Tüm API provider'ları başarısız (MP4)");
}

async function apiSearch(query) {
  const providers = normalizeProviders();
  let lastErr;
  for (const provider of providers) {
    const url = buildProviderUrl(provider, "search", { query });
    try {
      console.log(`[API_PROVIDER:${provider.id}] Arama: "${query}"`);
      const response = await axiosClient.get(url, { timeout: 10000 });
      if (response.data) return response.data;
      throw new Error("Boş arama yanıtı");
    } catch (err) {
      lastErr = err;
      console.warn(`[API_PROVIDER:${provider.id}] Arama başarısız: ${err.message}`);
    }
  }
  throw lastErr || new Error("Tüm API provider'ları başarısız (arama)");
}

async function apiAutocomplete(query) {
  const providers = normalizeProviders();
  for (const provider of providers) {
    const url = buildProviderUrl(provider, "autocomplete", { query });
    try {
      const response = await axiosClient.get(url, { timeout: 5000 });
      if (response.data) return response.data;
    } catch (err) {
      console.warn(`[API_PROVIDER:${provider.id}] Otomatik tamamlama başarısız: ${err.message}`);
    }
  }
  return []; // autocomplete kritik değil — hepsi çökse boş dön
}

// API Provider sağlık kontrolü — her provider kendi baseUrl'ünden test edilir
async function checkProviderHealth() {
  const providers = normalizeProviders(true); // pasifleri de göster
  const results = [];
  for (const provider of providers) {
    try {
      const testUrl = buildProviderUrl(provider, "mp3", { id: "test", bitrate: 128 });
      const resp = await axiosClient.get(testUrl, { timeout: 8000, validateStatus: () => true });
      results.push({
        ...provider,
        status: resp.status < 500 ? "online" : "offline",
        httpStatus: resp.status,
        checkedAt: new Date().toISOString()
      });
    } catch (err) {
      results.push({
        ...provider,
        status: "offline",
        error: err.message,
        checkedAt: new Date().toISOString()
      });
    }
  }
  return results;
}

// ========== ADMIN: API Provider Yönetim Endpoint'leri ==========

// API Provider ayarlarını getir
app.get("/admin/api-providers", basicAuth, async (req, res) => {
  try {
    const cfg = getApiProviderConfig();
    const health = await checkProviderHealth();
    res.json({ ...cfg, providerHealth: health });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API Provider ayarlarını güncelle
app.post("/admin/api-providers", basicAuth, async (req, res) => {
  try {
    const config = getCachedConfig();
    config.apiProviders = { ...getApiProviderConfig(), ...req.body };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    _cachedConfigByApp = {};
    res.json({ success: true, apiProviders: config.apiProviders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API Provider sağlık kontrolü
app.get("/admin/api-health", basicAuth, async (req, res) => {
  try {
    const health = await checkProviderHealth();
    res.json({ providers: health, proxyCount: 20, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TEK PROVIDER'I GERÇEKTEN TEST ET — 4 özelliği de (mp3/mp4/arama/tamamlama) dener
// Panelden gelen provider config'i (kaydetmeden) canlı dener, her özellik için OK/FAIL döner.
app.post("/admin/test-provider", basicAuth, async (req, res) => {
  const p = req.body || {};
  // Eski şema provider'larında baseUrl/apiKey boş olabilir — global ayara düş
  const cfg = getApiProviderConfig();
  const provider = {
    id: p.id || "test",
    name: p.name || p.id || "test",
    baseUrl: ((p.baseUrl && p.baseUrl.trim()) || cfg.baseUrl || "").replace(/\/+$/, ""),
    apiKey: (p.apiKey && p.apiKey.trim()) || cfg.apiKey || "",
    endpoints: { ...DEFAULT_ENDPOINTS, ...(p.endpoints || {}) }
  };
  const testVideoId = p.videoId || "GcGPedcPsOs"; // bilinen, çalışan bir video ID
  const testQuery = "test";
  const results = {};

  // mp3 + mp4: "key geçerli + erişilebilir mi" diye bak. Tam dönüşümü beklemeyiz (çok yavaş).
  // 3 durum: ok=medya geldi | reachable=ulaşıldı ama dönüşüm sürüyor (key OK) | fail=403/ağ hatası (gerçek sorun)
  for (const [type, kind] of [["mp3", "audio"], ["mp4", "video"]]) {
    const url = buildProviderUrl(provider, type, { id: testVideoId, bitrate: 320, quality: 720 });
    const t0 = Date.now();
    try {
      const r = await axiosClient({ method: "GET", url, responseType: "stream", timeout: 20000, validateStatus: () => true, headers: { "User-Agent": getRandomUA() } });
      const ct = r.headers["content-type"] || "";
      // 401/403 = key geçersiz → gerçek hata
      if (r.status === 401 || r.status === 403) { try { r.data.destroy(); } catch {} throw new Error(`API key reddedildi (HTTP ${r.status})`); }
      // 200 + gerçek medya = tam çalışıyor
      if (r.status === 200 && !ct.includes("text/html") && !ct.includes("json")) {
        try {
          await validateMediaStream(r.data, kind);
          try { r.data.destroy(); } catch {}
          results[type] = { ok: true, ms: Date.now() - t0, note: "medya geldi ✓" };
          continue;
        } catch (_) { try { r.data.destroy(); } catch {} }
      }
      try { r.data.destroy(); } catch {}
      // Ulaşıldı (200/JSON/processing) ama medya henüz hazır değil → key geçerli, dönüşüm sürüyor
      results[type] = { ok: true, reachable: true, ms: Date.now() - t0, note: "ulaşıldı, dönüşüm sürüyor (key geçerli)" };
    } catch (err) {
      const msg = err.message || "";
      // timeout = sunucuya ulaşıldı ama yavaş → key muhtemelen geçerli, dönüşüm uzun
      if (msg.includes("timeout")) {
        results[type] = { ok: true, reachable: true, ms: Date.now() - t0, note: "yavaş dönüşüm (key geçerli, video cache'siz)" };
      } else {
        results[type] = { ok: false, ms: Date.now() - t0, error: msg, url };
      }
    }
  }

  // arama + otomatik tamamlama: JSON/veri dönmeli
  for (const type of ["search", "autocomplete"]) {
    const url = buildProviderUrl(provider, type, { query: testQuery });
    const t0 = Date.now();
    try {
      const r = await axiosClient.get(url, { timeout: 15000, validateStatus: () => true });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      if (!r.data) throw new Error("Boş yanıt");
      results[type] = { ok: true, ms: Date.now() - t0 };
    } catch (err) {
      results[type] = { ok: false, ms: Date.now() - t0, error: err.message, url };
    }
  }

  const okCount = Object.values(results).filter(x => x.ok).length;
  res.json({ provider: provider.name, videoId: testVideoId, okCount, total: 4, results });
});

// Akıllı Cache ayarları
app.get("/admin/smart-cache", basicAuth, async (req, res) => {
  try {
    const cfg = getApiProviderConfig();
    const cacheStats = {
      smartCache: cfg.smartCache || { enabled: true, minRequests: 3 },
      diskUsage: "N/A",
      r2Usage: "N/A"
    };
    try {
      const { execSync } = require("child_process");
      const du = execSync(`du -sh ${CACHE_DIR} 2>/dev/null || echo "0"`).toString().trim();
      cacheStats.diskUsage = du.split("\t")[0] || du;
    } catch {}
    res.json(cacheStats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/smart-cache", basicAuth, async (req, res) => {
  try {
    const config = getCachedConfig();
    if (!config.apiProviders) config.apiProviders = getApiProviderConfig();
    config.apiProviders.smartCache = { ...config.apiProviders.smartCache, ...req.body };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    _cachedConfigByApp = {};
    res.json({ success: true, smartCache: config.apiProviders.smartCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ADMIN: YouTube & Top50 Yönetim Endpoint'leri ==========

let warmupIntervalMs = 6 * 60 * 60 * 1000; // varsayılan 6 saat (yük azaltma: eskiden 50dk — Top50 gün içinde pek değişmez)
let warmupTimer = null;
let youtubeApiCallCount = 0; // sunucu başladığından beri yapılan API çağrı sayısı

// YouTube API çağrılarını say
function trackYoutubeApiCall() { youtubeApiCallCount++; }

app.get("/admin/youtube", basicAuth, async (req, res) => {
  try {
    const regions = Array.from(activeRegions);
    const cachedRegions = [];
    for (const r of regions) {
      const cached = await cacheGet(`top50:${r}`);
      cachedRegions.push({ region: r, cached: !!cached, trackCount: cached ? cached.length : 0 });
    }
    res.json({
      youtubeApiKey: YOUTUBE_API_KEY ? `${YOUTUBE_API_KEY.substring(0, 8)}...${YOUTUBE_API_KEY.slice(-4)}` : "YOK",
      youtubeApiKeyFull: YOUTUBE_API_KEY || "",
      status: youtubeApiStatus,
      quotaExceeded: stats.youtubeApiQuotaExceeded,
      apiCallCount: youtubeApiCallCount,
      activeRegions: cachedRegions,
      warmupIntervalMin: Math.round(warmupIntervalMs / 60000),
      cacheDurationMin: Math.round(CACHE_DURATION / 60),
      searchCacheDurationMin: Math.round(SEARCH_CACHE_DURATION / 60)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/youtube", basicAuth, async (req, res) => {
  try {
    const { warmupInterval, addRegion, removeRegion, forceWarmup } = req.body;

    if (warmupInterval && warmupInterval >= 10 && warmupInterval <= 1440) {
      warmupIntervalMs = warmupInterval * 60 * 1000;
      if (warmupTimer) clearInterval(warmupTimer);
      warmupTimer = setInterval(warmTop50, warmupIntervalMs);
      console.log(`[ADMIN] Warmup aralığı değiştirildi: ${warmupInterval} dakika`);
    }

    if (addRegion && addRegion.length === 2) {
      activeRegions.add(addRegion.toUpperCase());
      console.log(`[ADMIN] Ülke eklendi: ${addRegion.toUpperCase()}`);
    }

    if (removeRegion && removeRegion.length === 2) {
      activeRegions.delete(removeRegion.toUpperCase());
      await redis.del(`top50:${removeRegion.toUpperCase()}`);
      console.log(`[ADMIN] Ülke kaldırıldı: ${removeRegion.toUpperCase()}`);
    }

    if (forceWarmup) {
      warmTop50();
      console.log(`[ADMIN] Top50 manuel ısıtma başlatıldı`);
    }

    res.json({ success: true, activeRegions: Array.from(activeRegions), warmupIntervalMin: Math.round(warmupIntervalMs / 60000) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== AUTO RINGTONE ADMIN =====
app.get("/admin/auto-ringtone", basicAuth, (req, res) => {
  const appId = resolveAppId(req);
  const config = getCachedConfig(appId);
  const ar = config.autoRingtone || { enabled: false };
  res.json(ar);
});

app.post("/admin/auto-ringtone", basicAuth, (req, res) => {
  try {
    const appId = resolveAppId(req);
    const config = { ...getCachedConfig(appId) };
    if (!config.autoRingtone) config.autoRingtone = { enabled: false };
    if (req.body.enabled !== undefined) config.autoRingtone.enabled = !!req.body.enabled;
    ensureAppData(appId);
    fs.writeFileSync(pathFor(appId, CONFIG_FILE), JSON.stringify(config, null, 2));
    delete _cachedConfigByApp[appId];
    console.log(`[ADMIN] Auto-ringtone (${appId}) ${config.autoRingtone.enabled ? "açıldı" : "kapatıldı"}`);
    res.json({ success: true, autoRingtone: config.autoRingtone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Autocomplete endpoint (yeni)
app.get("/autocomplete", async (req, res) => {
  try {
    const query = req.query.q?.trim();
    if (!query) return res.status(400).json({ error: "Query required" });

    const cacheKey = `autocomplete:${query}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const results = await apiAutocomplete(query);
    await cacheSet(cacheKey, results, 3600);
    res.json(results);
  } catch (err) {
    console.error("[AUTOCOMPLETE]", err.message);
    res.status(500).json({ error: "Autocomplete failed" });
  }
});

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
const CACHE_DURATION = 8 * 60 * 60; // 8 saat (yük azaltma: eskiden 1 saat) — warmup 6 saatte bir olduğu için cache hep sıcak kalır, soğuk-miss yaşanmaz
const STREAM_CACHE_DURATION = 5.5 * 60 * 60; // 5.5 saat (YouTube URL max 6 saat, cache'i son ana kadar kullan)
const SEARCH_CACHE_DURATION = parseInt(process.env.SEARCH_CACHE_TTL || "3600"); // config'den yönetilebilir

const BLOCKED_FILE = path.join(__dirname, "blockedChannels.json");

function getBlockedChannels() {
  return getCachedBlockedChannels();
}

// ===== İÇERİK FİLTRESİ (canlı yayın + süre) =====
// Arama sonuçlarında canlı yayınları ve çok uzun videoları eler.
// Değerler config.json > contentFilter'dan gelir; panelden değiştirilebilir.

function getContentFilter() {
  const cf = getCachedConfig().contentFilter || {};
  return {
    enabled: cf.enabled !== false,
    maxDurationMinutes: Number(cf.maxDurationMinutes) > 0 ? Number(cf.maxDurationMinutes) : 35,
    blockLive: cf.blockLive !== false
  };
}

// Süreyi saniyeye çevir: 275 (sayı), "3:45", "1:02:03", "PT3M45S" (ISO8601) desteklenir.
// Bilinmiyorsa/çözülemezse -1 döner (süre bilgisi yok anlamında).
function parseDurationToSeconds(val) {
  if (val === null || val === undefined) return -1;
  if (typeof val === "number") return Number.isFinite(val) && val > 0 ? Math.floor(val) : -1;
  const s = String(val).trim();
  if (!s) return -1;
  // ISO8601 (PT#H#M#S)
  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (iso) {
    const h = parseInt(iso[1] || "0", 10), m = parseInt(iso[2] || "0", 10), sec = parseInt(iso[3] || "0", 10);
    const total = h * 3600 + m * 60 + sec;
    return total > 0 ? total : -1;
  }
  // "H:MM:SS" veya "M:SS"
  if (s.includes(":")) {
    const parts = s.split(":").map(p => parseInt(p, 10));
    if (parts.some(n => Number.isNaN(n))) return -1;
    let total = 0;
    for (const n of parts) total = total * 60 + n;
    return total > 0 ? total : -1;
  }
  // Düz sayı (saniye)
  const num = parseFloat(s);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : -1;
}

// Canlı yayın mı? Provider'lar farklı alan adları kullanabilir → hepsini kontrol et.
function isLiveResult(item) {
  if (!item || typeof item !== "object") return false;
  const snippet = item.snippet || {};
  if (item.isLive === true || item.is_live === true || item.live === true || item.liveNow === true) return true;
  const lbc = (item.liveBroadcastContent || snippet.liveBroadcastContent || item.live_status || "").toString().toLowerCase();
  if (lbc === "live" || lbc === "upcoming" || lbc === "is_live") return true;
  const durTxt = (item.duration || item.lengthText || item.length || "").toString().toLowerCase();
  if (durTxt === "live" || durTxt === "canlı" || durTxt === "canli") return true;
  // Bazı scraper'lar rozet (badge) döner
  const badges = item.badges || snippet.badges;
  if (Array.isArray(badges) && badges.some(b => (b || "").toString().toLowerCase().includes("live"))) return true;
  // BAŞLIK BAZLI: bazocam provider'ı canlı yayınları hiçbir işaretle göndermiyor,
  // sadece başlıkta "Canlı Yayın" / "7/24" yazıyor. Bu kalıpları yakala.
  // NOT: "canlı performans", "canlı konser" gibi KAYIT videoları eşleşmez (kasıtlı).
  const title = (item.title || item.name || snippet.title || "").toString().toLowerCase();
  const livePatterns = [
    "canlı yayın", "canli yayin", "canlı yayin", "canli yayın",
    "7/24", "24/7", "7 24", "🔴", "live stream", "livestream", "live now",
    "canlı izle", "canli izle", "canlı tv", "canli tv", "en vivo", "en direct"
  ];
  if (livePatterns.some(p => title.includes(p))) return true;
  return false;
}

// Arama sonuçlarına içerik filtresini uygula (canlı + süre).
function applyContentFilter(items) {
  if (!Array.isArray(items) || !items.length) return items;
  const cf = getContentFilter();
  if (!cf.enabled) return items;
  const maxSec = cf.maxDurationMinutes * 60;
  let removedLive = 0, removedLong = 0, removedNoDur = 0;
  const out = items.filter(item => {
    if (cf.blockLive && isLiveResult(item)) { removedLive++; return false; }
    // Süre: YouTube'dan gelen GERÇEK süre varsa onu kullan (provider'ınki güvenilmez),
    // yoksa provider'ın verdiğine düş.
    const durSec = (typeof item._ytDurationSec === "number")
      ? item._ytDurationSec
      : parseDurationToSeconds(item.duration ?? item.lengthSeconds ?? item.length);
    // KRİTİK: bazocam provider'ı canlı yayınları süre=0 ile döndürüyor; gerçek şarkılar
    // HER ZAMAN süreli geliyor. Bu yüzden blockLive açıkken süresiz (0/bilinmeyen) içerikleri
    // de canlı/geçersiz kabul edip ele. (Müzik uygulamasında süresiz sonuç zaten indirilemez.)
    // AMA YouTube kesin "none" (canlı değil) dediyse, süre 0 olsa bile koru — yanlış eleme olmasın.
    const ytConfirmedNotLive = item.liveBroadcastContent === "none";
    if (cf.blockLive && durSec < 0 && !ytConfirmedNotLive) { removedNoDur++; return false; }
    // Süre biliniyorsa ve limitin üstündeyse ele.
    if (durSec >= 0 && durSec >= maxSec) { removedLong++; return false; }
    return true;
  });
  if (removedLive || removedLong || removedNoDur) {
    console.log(`[CONTENT_FILTER] elenen → canlı:${removedLive} süresiz(muhtemel-canlı):${removedNoDur} uzun(≥${cf.maxDurationMinutes}dk):${removedLong} | kalan:${out.length}/${items.length}`);
  }
  return out;
}

// YouTube'un RESMİ canlı işaretiyle zenginleştir. Provider (bazocam) canlı bilgisi
// vermiyor; video ID'lerini YouTube Data API'ye sorup her sonuca gerçek
// `liveBroadcastContent` ("live"/"upcoming"/"none") değerini ekliyoruz.
// YOUTUBE_API_KEY yoksa veya çağrı başarısızsa dokunmaz → başlık/süre sezgisi devreye girer.
// NOT: provider'ın `duration` alanına DOKUNMUYORUZ (Android süre gösterimi bozulmasın).
async function enrichWithYouTubeDetails(items) {
  if (!YOUTUBE_API_KEY || !Array.isArray(items) || !items.length) return items;
  try {
    const ids = items.map(it => it.id || it.videoId).filter(Boolean);
    if (!ids.length) return items;
    const byId = {};
    for (let i = 0; i < ids.length; i += 50) { // videos.list en fazla 50 ID
      const chunk = ids.slice(i, i + 50).join(",");
      const resp = await axiosClient.get("https://www.googleapis.com/youtube/v3/videos", {
        params: { part: "snippet,contentDetails", id: chunk, key: YOUTUBE_API_KEY },
        timeout: 8000
      });
      for (const v of (resp.data.items || [])) byId[v.id] = v;
    }
    let liveFound = 0, durFixed = 0;
    for (const it of items) {
      const v = byId[it.id || it.videoId];
      if (!v) continue;
      const lbc = v.snippet?.liveBroadcastContent || "none";
      it.liveBroadcastContent = lbc; // "live" / "upcoming" / "none" — kesin canlı işareti
      if (lbc === "live" || lbc === "upcoming") liveFound++;
      // GERÇEK süre (provider'ın süresi güvenilmez; YouTube'unki kesin). Ayrı alanda tut,
      // provider'ın `duration`'ına dokunma (Android süre gösterimi bozulmasın).
      if (v.contentDetails?.duration) {
        const real = parseDurationToSeconds(v.contentDetails.duration); // ISO8601 → sn
        if (real >= 0) { it._ytDurationSec = real; durFixed++; }
      }
    }
    if (liveFound || durFixed) console.log(`[CONTENT_FILTER] YouTube ile ${liveFound} canlı + ${durFixed} gerçek süre alındı`);
  } catch (e) {
    console.warn(`[CONTENT_FILTER] YouTube zenginleştirme başarısız (sezgiye düşülüyor): ${e.message}`);
  }
  return items;
}

function filterBlockedChannels(items, country = "all") {
  const blockedGroups = getBlockedChannels();
  if (!blockedGroups.length) return items;
  return items.filter(item => {
    const snippet = item.snippet || item;
    const channelTitle = (snippet.channelTitle || snippet.uploaderName || item.uploader || snippet.channel || "").toLowerCase();
    const videoTitle = (snippet.title || item.title || "").toLowerCase();
    const videoId = (typeof item.id === "object" ? item.id?.videoId : null) || item.videoId || snippet.videoId || item.id || item.url?.split("v=")[1] || "";
    const uploaderUrl = snippet.uploaderUrl || item.uploaderUrl || snippet.channelUrl || item.channelUrl || "";
    const channelId = snippet.channelId || item.channelId || item.uploaderId || (uploaderUrl.includes("/channel/") ? uploaderUrl.split("/channel/")[1] : "");

    const isBlocked = blockedGroups.some(group => {
      const ruleCountries = group.countries || "all";
      if (ruleCountries !== "all") {
        const countriesArray = Array.isArray(ruleCountries) ? ruleCountries : ruleCountries.split(",");
        if (!countriesArray.includes(country)) return false;
      }

      if (!group.channels || !Array.isArray(group.channels)) return false;
      const type = group.type || "channel";

      return group.channels.some(blockedValue => {
        const val = blockedValue.trim();
        let matched = false;
        if (type === "keyword") {
          matched = videoTitle.includes(val.toLowerCase());
        } else if (type === "channelId") {
          // Kullanıcı UC ID, @handle veya tam kanal URL'i yapıştırabilir → hepsini normalize edip eşleştir
          const norm = s => (s || "").toLowerCase()
            .replace(/^https?:\/\/(www\.)?youtube\.com\//, "")
            .replace(/^@/, "").replace(/^channel\//, "").replace(/\/+$/, "").trim();
          const target = norm(val);
          const cu = norm(uploaderUrl); // oEmbed'den çözülen kanal url'i (/@handle veya channel/UC...)
          matched = !!target && ((channelId || "").toLowerCase() === target || (cu.length > 3 && cu.includes(target)));
        } else if (type === "videoId") {
          // Kullanıcı ham ID (CTckqh0TFrg) VEYA tam link (watch?v=..., youtu.be/..., shorts/...) yapıştırabilir
          const extractId = s => {
            s = (s || "").trim();
            const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
            return m ? m[1] : s;
          };
          matched = !!videoId && extractId(videoId) === extractId(val);
        } else {
          matched = channelTitle.includes(val.toLowerCase());
        }
        return matched;
      });
    });

    return !isBlocked;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// KANAL ADI ZENGİNLEŞTİRME (enrichment)
// Arama kaynağı (bazocam) sonuçlarda kanal/uploader adını VERMİYOR (boş gelir).
// Bu yüzden "Kanal Adı" engelleme çalışmıyordu. YouTube'un ÜCRETSİZ oEmbed
// endpoint'i (API key/kota YOK) ile video ID'den kanal adını çekip dolduruyoruz.
// Kanal adı değişmez → Redis'te 30 gün cache. Böylece kanal bazlı engelleme çalışır.
// ─────────────────────────────────────────────────────────────────────────
// oEmbed'den kanal ADI + kanal URL'i çeker (ikisi de cache'lenir).
// author_url, kanalın formatına göre /channel/UCxxxx VEYA /@handle döner — ikisini de saklarız.
async function getChannelInfo(videoId) {
  if (!videoId) return { name: "", url: "" };
  const cacheKey = `chinfo:${videoId}`;
  const cached = await cacheGet(cacheKey);
  if (cached !== null) return cached; // {name:"",url:""} da geçerli (bilinen-boş → tekrar deneme)
  let info = { name: "", url: "" };
  try {
    const r = await axiosClient.get(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { timeout: 3000, headers: { "User-Agent": getRandomUA() }, validateStatus: s => s === 200 }
    );
    if (r.data) info = { name: String(r.data.author_name || ""), url: String(r.data.author_url || "") };
  } catch (e) { /* özel/silinmiş/erişilemez video → boş bırak */ }
  await cacheSet(cacheKey, info, info.name ? 2592000 : 3600); // başarı 30 gün, başarısız 1 saat
  return info;
}

// Arama sonuçlarındaki boş "uploader" + "channelUrl/channelId" alanlarını doldur (paralel).
// Hem kanal ADI hem kanal ID (/@handle veya /channel/UC...) engellemesi bu sayede çalışır.
async function enrichUploaders(items) {
  if (!Array.isArray(items) || !items.length) return;
  await Promise.all(items.map(async it => {
    if (!it) return;
    const hasName = it.uploader && String(it.uploader).trim();
    const hasUrl = it.channelUrl && String(it.channelUrl).trim();
    if (hasName && hasUrl) return; // ikisi de doluysa atla
    const vid = (typeof it.id === "object" ? it.id && it.id.videoId : it.id) || it.videoId || "";
    const info = await getChannelInfo(vid);
    if (info.name && !hasName) it.uploader = info.name;
    if (info.url && !hasUrl) {
      it.channelUrl = info.url;
      const m = info.url.match(/\/channel\/(UC[\w-]+)/i); // UC kanal ID'sini ayıkla (varsa)
      if (m) it.channelId = m[1];
    }
  }));
}

// Engelli listede "kanal adı" / "kanal ID" tipi kural var mı? (enrichment sadece gerekince yapılır)
function hasChannelTypeRule() {
  try {
    return getBlockedChannels().some(g => { const t = g.type || "channel"; return t === "channel" || t === "channelId"; });
  } catch { return false; }
}

// Kendi sunucumuzda Top25'e çıkarıldı + FFmpeg ile kalıcı disk kaydı eklendi
function prewarmTop10(items) {
  if (!items || !Array.isArray(items)) return;
  // Bazocam API'yi boğmamak için sadece en popüler 15'i ön-ısıt (geri kalanı ilk
  // dinlemede çözülüp cache'lenir). Çok agresif prewarm bazocam'ın alt servislerini
  // tüketip "Not Found / Tüm API'ler başarısız" hatalarına yol açıyordu.
  const topItems = items.slice(0, 15);
  console.log(`[PREWARM] ${topItems.length} şarkı ön-ısıtma başlatılıyor (API Provider)...`);

  topItems.forEach((item, index) => {
    const videoId = typeof item.id === "object" ? item.id.videoId : item.id;
    if (!videoId) return;

    // Zaten diskte/cache'te varsa atla
    const cacheFile = path.join(CACHE_DIR, `audio_${videoId}.mp3`);
    if (fs.existsSync(cacheFile) || mediaLib.getReadyTrack(videoId, "mp3") || mediaLib.isProcessing(videoId)) {
      return;
    }

    // Küçük gecikmelerle kuyruğa ekle (API'yi boğmamak için)
    setTimeout(() => {
      queue.add(async () => {
        const title = item.snippet?.title || "Unknown";
        const artist = item.snippet?.channelTitle || "Unknown";
        try {
          mediaLib.upsertTrack(videoId, { title, artist, category: "listening", status: "processing" });

          // ★ API Provider (bazocam) ile MP3 çek — yt-dlp YOK
          const apiResult = await apiStreamMp3(videoId, 320);
          const writeStream = fs.createWriteStream(cacheFile);
          await new Promise((resolve, reject) => {
            apiResult.stream.pipe(writeStream);
            writeStream.on("finish", resolve);
            writeStream.on("error", reject);
            apiResult.stream.on("error", reject);
          });

          // Boyut kontrolü — bozuk/boş dosyayı reddet
          const size = fs.statSync(cacheFile).size;
          if (size < 20 * 1024) {
            try { fs.unlinkSync(cacheFile); } catch {}
            throw new Error(`Dosya çok küçük (${size} byte)`);
          }

          mediaLib.markReady(videoId, { mp3: cacheFile });
          uploadToR2(`audio/${videoId}.mp3`, cacheFile).catch(() => {});
          console.log(`[PREWARM_SUCCESS] ✅ ${videoId} API'den diske kaydedildi (${(size / 1024 / 1024).toFixed(2)} MB)`);
        } catch (err) {
          try { if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile); } catch {}
          mediaLib.markFailed(videoId, err.message);
          console.warn(`[PREWARM] ⚠️ ${videoId} başarısız: ${err.message}`);
        }
      }).catch(() => { });
    }, index * 5000); // Her bir arasına 5 saniye koy — bazocam'ı yormamak için
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

/* =========================================================================
   ÇOK UYGULAMALI YÖNETİM — panel uygulama seçicisi buradan beslenir
========================================================================= */
// Kayıtlı uygulamaları listele (panel dropdown'u).
// Uygulamaya özel key ile gelinirse SADECE o uygulama döner (izolasyon).
app.get("/admin/apps", basicAuth, (req, res) => {
  const bound = resolveAppFromKey(req.headers["x-app-key"]);
  if (bound) {
    const apps = getApps();
    return res.json({ [bound]: apps[bound] });
  }
  res.json(getApps());
});

// Uygulama ekle/güncelle + veri klasörünü tohumla
app.post("/admin/apps", basicAuth, express.json(), async (req, res) => {
  try {
    if (!isMasterRequest(req)) return res.status(403).json({ error: "Sadece süper admin uygulama ekleyebilir" });
    const { id, name, packageName, brandPrimary, policySlug, onesignalAppId, onesignalRestKey } = req.body || {};
    const slug = String(id || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!slug) return res.status(400).json({ error: "geçerli id zorunlu (a-z0-9_-)" });
    if (!name) return res.status(400).json({ error: "name zorunlu" });

    const apps = { ...getApps() };
    const existing = apps[slug] || {};
    apps[slug] = {
      id: slug,
      name,
      packageName: packageName || existing.packageName || "",
      brandPrimary: brandPrimary || existing.brandPrimary || "#2E6BF6",
      policySlug: policySlug || existing.policySlug || "",
      onesignalAppId: onesignalAppId !== undefined ? onesignalAppId : (existing.onesignalAppId || ""),
      onesignalRestKey: onesignalRestKey !== undefined ? onesignalRestKey : (existing.onesignalRestKey || "")
    };
    saveApps(apps);

    // Yeni uygulama için veri klasörünü tohumla — default config'i kopyala, reklamları KAPAT
    if (slug !== "default") {
      ensureAppData(slug);
      const cfgPath = pathFor(slug, CONFIG_FILE);
      if (!fs.existsSync(cfgPath)) {
        let seed = {};
        try { seed = JSON.parse(fs.readFileSync(pathFor("default", CONFIG_FILE), "utf-8")); } catch (e) {}
        for (const k of ["downloadAd", "bannerAd", "bottomBannerAd"]) {
          if (seed[k] && typeof seed[k] === "object") seed[k].enabled = false;
        }
        seed.global = { enabled: true, mode: "youtube" };
        fs.writeFileSync(cfgPath, JSON.stringify(seed, null, 2));
      }
      for (const f of ["announcements.json", "device_actions.json", "blockedChannels.json", "feedbacks.json", "review_logs.json"]) {
        const p = pathFor(slug, f);
        if (!fs.existsSync(p)) fs.writeFileSync(p, "[]");
      }
    }
    // Yeni/güncel uygulamanın izole panel giriş bilgileri — SADECE master'a döner.
    const resp = { ok: true, app: apps[slug] };
    if (slug !== "default" && isMasterRequest(req)) resp.credentials = panelCredentials(slug);
    res.json(resp);
  } catch (e) {
    res.status(500).json({ error: "Apps write failed: " + e.message });
  }
});

// Tüm uygulamaların izole panel giriş bilgileri — SADECE master (süper panel).
// İzole panel yöneticileri (per-app key) burayı göremez → 403.
app.get("/admin/app-credentials", basicAuth, (req, res) => {
  if (!isMasterRequest(req)) return res.status(403).json({ error: "Sadece süper admin" });
  const apps = getApps();
  const list = Object.keys(apps)
    .filter(id => id !== "default")
    .map(id => ({ ...panelCredentials(id), name: apps[id].name, packageName: apps[id].packageName || "" }));
  res.json({ apps: list });
});

// KİŞİSEL PANEL KULLANICILARI — sadece süper admin yönetir (şifre asla döndürülmez)
app.get("/admin/users", basicAuth, (req, res) => {
  if (!isMasterRequest(req)) return res.status(403).json({ error: "Sadece süper admin" });
  const users = getPanelUsers();
  res.json({ users: Object.keys(users).map(u => ({ username: u, apps: users[u].apps, super: !!users[u].super })) });
});
app.post("/admin/users", basicAuth, express.json(), (req, res) => {
  if (!isMasterRequest(req)) return res.status(403).json({ error: "Sadece süper admin" });
  const { username, password, apps, super: isSuper } = req.body || {};
  const u = String(username || "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "");
  if (!u) return res.status(400).json({ error: "geçerli kullanıcı adı zorunlu (a-z0-9_)" });
  const users = { ...getPanelUsers() };
  const existing = users[u] || {};
  if (!existing.pass && !password) return res.status(400).json({ error: "yeni kullanıcı için şifre zorunlu" });
  const isAll = (apps === "all" || !!isSuper);
  const scope = isAll ? "all" : (Array.isArray(apps) ? apps.filter(Boolean) : (existing.apps || []));
  users[u] = { pass: password ? hashPw(password) : existing.pass, apps: scope, super: isAll };
  savePanelUsers(users);
  res.json({ ok: true, username: u, apps: users[u].apps, super: users[u].super });
});
app.delete("/admin/users/:username", basicAuth, (req, res) => {
  if (!isMasterRequest(req)) return res.status(403).json({ error: "Sadece süper admin" });
  const u = String(req.params.username || "").toLowerCase();
  const users = { ...getPanelUsers() };
  if (!users[u]) return res.status(404).json({ error: "kullanıcı yok" });
  delete users[u];
  savePanelUsers(users);
  res.json({ ok: true });
});

app.get("/config", (req, res) => {
  recordLoginIp(req, "/config");
  const appId = resolveAppId(req);
  const config = { ...getCachedConfig(appId) };
  config.watch_base = "https://www.youtube.com/watch?v=";
  if (!config.autocompleteSource) config.autocompleteSource = "google";
  res.json(config);
});

app.post("/config", async (req, res) => {
  try {
    const appId = resolveAppId(req);
    const body = { ...req.body };
    // ringtoneAsns normalize: "AS15169" / "15169" / 15169 -> 15169, tekrarlari at
    if (body.ringtoneAsns !== undefined) {
      body.ringtoneAsns = [...new Set(
        (Array.isArray(body.ringtoneAsns) ? body.ringtoneAsns : [])
          .map(v => parseInt(String(v).replace(/\D/g, ""), 10))
          .filter(n => Number.isInteger(n) && n > 0)
      )];
    }
    ensureAppData(appId);
    await fs.promises.writeFile(pathFor(appId, CONFIG_FILE), JSON.stringify(body, null, 2));
    delete _cachedConfigByApp[appId]; // Sadece bu uygulamanın cache'ini invalidate et
    res.json({ message: "Config updated successfully" });
  } catch (e) {
    res.status(500).json({ error: "Config write failed: " + e.message });
  }
});

app.get("/blocked-channels", (req, res) => {
  try {
    const blockedFile = pathFor(resolveAppId(req), "blockedChannels.json");
    if (!fs.existsSync(blockedFile)) return res.json([]);
    const data = fs.readFileSync(blockedFile, "utf-8");
    res.type("json").send(data || "[]");
  } catch (e) { res.json([]); }
});

app.post("/blocked-channels", async (req, res) => {
  try {
    const appId = resolveAppId(req);
    const blockedFile = pathFor(appId, "blockedChannels.json");
    let blocked = [];
    if (fs.existsSync(blockedFile)) {
      blocked = JSON.parse(await fs.promises.readFile(blockedFile, "utf-8") || "[]");
    }
    const { id, channels, countries, type } = req.body;

    const existingIndex = blocked.findIndex(b => b.id === id);
    if (existingIndex >= 0) {
      blocked[existingIndex] = { id, channels, countries, type: type || "channel" };
    } else {
      const newId = id || Date.now().toString() + "-" + Math.random().toString(36).substring(2, 9);
      blocked.push({ id: newId, channels: channels || [], countries: countries || "all", type: type || "channel" });
    }

    ensureAppData(appId);
    await fs.promises.writeFile(blockedFile, JSON.stringify(blocked, null, 2));
    if (appId === "default") _cachedBlockedChannels = null;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Write failed" }); }
});

app.delete("/blocked-channels/:id", async (req, res) => {
  try {
    const appId = resolveAppId(req);
    const blockedFile = pathFor(appId, "blockedChannels.json");
    if (!fs.existsSync(blockedFile)) return res.json({ success: true });
    let blocked = JSON.parse(await fs.promises.readFile(blockedFile, "utf-8") || "[]");
    blocked = blocked.filter(ch => ch.id !== req.params.id);
    await fs.promises.writeFile(blockedFile, JSON.stringify(blocked, null, 2));
    if (appId === "default") _cachedBlockedChannels = null;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Delete failed" }); }
});

// ONESIGNAL BİLDİRİM GÖNDERME (fetch — exec/curl kaldırıldı, güvenli)
const COUNTRY_TO_LANG = {
  TR: "tr", US: "en", GB: "en", DE: "de", FR: "fr", IT: "it", ES: "es",
  NL: "nl", BR: "pt", RU: "ru", JP: "ja", KR: "ko", IN: "hi", SA: "ar",
  AE: "ar", AU: "en", CA: "en", MX: "es", AR: "es", PL: "pl", SE: "sv", AZ: "az"
};

async function translateText(text, targetLang) {
  if (!text || targetLang === "tr") return text;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=tr&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    return data[0].map(s => s[0]).join("");
  } catch (e) {
    console.error("[Translate] Hata:", e.message);
    return text;
  }
}

app.post("/send-notification", basicAuth, async (req, res) => {
  const { appId: bodyAppId, restKey: bodyRestKey, title, message, imageUrl, actionUrl, sendAt, targetCountry, targetMode } = req.body;
  if (!title || !message) {
    return res.status(400).json({ error: "Başlık ve mesaj gereklidir" });
  }

  // Uygulama başına OneSignal: önce body (panel açıkça gönderirse), sonra kayıt
  // defterindeki seçili uygulamanın kimliği, en son env varsayılanı (musica).
  const _targetAppId = resolveAppId(req);
  const _appEntry = getApps()[_targetAppId] || {};
  const appId = bodyAppId || _appEntry.onesignalAppId || process.env.ONESIGNAL_APP_ID || "9a255882-6fc4-43e6-af33-24f5f69642cf";
  const restKey = bodyRestKey || _appEntry.onesignalRestKey || process.env.ONESIGNAL_REST_KEY || "";

  if (!restKey) {
    return res.status(400).json({ success: false, details: "REST API Key boş. Panelden veya apps.json'daki uygulama kaydından tanımlayın." });
  }

  try {
    const targetLang = targetCountry && targetCountry !== "all" ? (COUNTRY_TO_LANG[targetCountry] || "en") : null;
    let translatedTitle = title;
    let translatedMessage = message;

    if (targetLang && targetLang !== "tr") {
      translatedTitle = await translateText(title, targetLang);
      translatedMessage = await translateText(message, targetLang);
      console.log(`[Translate] ${targetCountry}(${targetLang}): "${title}" → "${translatedTitle}"`);
    }

    const notifPayload = {
      app_id: appId,
      headings: { en: translatedTitle, tr: title },
      contents: { en: translatedMessage, tr: message },
      included_segments: ["All"]
    };

    // Hedef mod filtresi (youtube | ringtone). "both"/boş = mevcut davranış (mod filtresi yok).
    const modeFilter = (targetMode && targetMode !== "both" && targetMode !== "all")
      ? { field: "tag", key: "app_mode", relation: "=", value: targetMode }
      : null;

    if (targetCountry && targetCountry !== "all") {
      delete notifPayload.included_segments;
      notifPayload.filters = [
        { field: "country", value: targetCountry }
      ];
      if (modeFilter) notifPayload.filters.push({ operator: "AND" }, modeFilter);
    } else if (modeFilter) {
      delete notifPayload.included_segments;
      notifPayload.filters = [modeFilter];
    }

    if (imageUrl) notifPayload.big_picture = imageUrl;
    if (actionUrl) notifPayload.url = actionUrl;
    if (sendAt) notifPayload.send_after = sendAt;

    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Key ${restKey}`
      },
      body: JSON.stringify(notifPayload)
    });

    const data = await response.json();
    console.log("[OneSignal]", JSON.stringify(data));

    if (data.errors && data.errors.length > 0) {
      return res.status(400).json({ success: false, details: data.errors[0] });
    }

    const result = { success: true, data };
    if (targetLang && targetLang !== "tr") {
      result.translated = { lang: targetLang, title: translatedTitle, message: translatedMessage };
    }
    return res.json(result);
  } catch (error) {
    console.error("[OneSignal] Hata:", error.message);
    res.status(500).json({ success: false, details: error.message });
  }
});

// TOP 50

/* YANIT KÜÇÜLTME — mobilde açılışı hızlandırır, APK güncellemesi GEREKMEZ.
   Android fetchTop50() sadece şunları okur:
     id, snippet.title, snippet.channelTitle,
     snippet.thumbnails.(high|medium|default).url, contentDetails.duration
   YouTube ise ayrıca description, localized (başlık+açıklama tekrarı), tags,
   statistics ve 5 boy küçük resim gönderiyor. Ölçüm: 121 KB yanıtın 106 KB'ı
   uygulamanın hiç bakmadığı alanlar (%88). Kesilince telefon çok daha az veri
   indirip parse ediyor.
   NOT: channelId KALIR — engelli kanal filtresi onu kullanıyor. */
function slimTop50(items) {
  if (!Array.isArray(items)) return items;
  return items.map(it => {
    if (!it || typeof it !== "object") return it;
    const sn = it.snippet || {};
    const th = sn.thumbnails || {};
    const slimTh = {};
    for (const k of ["high", "medium", "default"]) if (th[k]) slimTh[k] = th[k];
    const out = {
      id: it.id,
      snippet: { title: sn.title, channelTitle: sn.channelTitle, channelId: sn.channelId, thumbnails: slimTh }
    };
    const dur = (it.contentDetails || {}).duration;
    if (dur) out.contentDetails = { duration: dur };
    return out;
  });
}

app.get("/top50", async (req, res) => {
  // Ülke tespiti: Cloudflare header > Android X-Country header > fallback US
  const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "US";
  const region = country.toUpperCase();
  const cacheKey = `top50:${region}`;

  try {
    // Redis cache kontrol (ülke bazlı)
    const cached = await cacheGet(cacheKey);
    if (cached) {
      trackActiveRegion(region);
      const filtered = Array.isArray(cached) ? filterBlockedChannels(cached, country) : cached;
      return res.json({ source: "cache", region, data: slimTop50(filtered) });
    }

    let items;
    /* Küçük pazarlarda (MZ, vb.) "mostPopular + videoCategoryId=10" grafiği yok;
       YouTube 400 videoChartNotFound döner. O bölgeler için kategori filtresi
       kaldırılıp tekrar denenir ve durum işaretlenir (bir daha boşuna denenmesin). */
    const ytParams = {
      part: "snippet,contentDetails,statistics",
      chart: "mostPopular",
      regionCode: region,
      maxResults: 50,
      key: YOUTUBE_API_KEY
    };
    if (!(await redisFast(redis.exists(`top50:nocat:${region}`), 0))) ytParams.videoCategoryId = 10;

    try {
      const response = await axiosClient.get("https://www.googleapis.com/youtube/v3/videos", { params: ytParams });
      items = filterBlockedChannels(response.data.items, country);
      youtubeApiStatus = "ok";
    } catch (apiError) {
      if (apiError.response && apiError.response.status === 400 && ytParams.videoCategoryId) {
        delete ytParams.videoCategoryId;
        try {
          const retryRes = await axiosClient.get("https://www.googleapis.com/youtube/v3/videos", { params: ytParams });
          items = filterBlockedChannels(retryRes.data.items, country);
          youtubeApiStatus = "ok";
          redis.set(`top50:nocat:${region}`, "1", "EX", 7 * 86400).catch(() => {});
          console.log(`[TOP50] ${region}: kategori grafiği yok, kategorisiz listeye geçildi`);
        } catch (retryErr) {
          // Bu bölgede hiç grafik yok → US listesini bu bölgenin anahtarına 1 saat
          // yaz. Kullanıcı boş ekran görmez ve YouTube'a tekrar tekrar gidilmez.
          const fb = await cacheGet("top50:US");
          if (Array.isArray(fb) && fb.length) {
            await cacheSet(cacheKey, fb, 3600);
            console.warn(`[TOP50] ${region}: grafik yok, US listesi 1 saat yedek olarak sunuluyor`);
            return res.json({ source: "fallback", region, data: slimTop50(filterBlockedChannels(fb, country)) });
          }
          throw retryErr;
        }
      } else if (apiError.response && (apiError.response.status === 403 || apiError.response.status === 429)) {
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

    // İÇERİK FİLTRESİ (canlı + 35dk üstü) — /search ile aynı kural Top50'ye de uygulanır.
    // YouTube'un gerçek süresi contentDetails.duration'da; filtreye besle (applyContentFilter
    // onu _ytDurationSec'ten okur). Chart öğeleri canlı değil → süresiz (Piped yedeği)
    // şarkılar yanlışlıkla elenmesin diye liveBroadcastContent'i "none"a sabitle.
    if (Array.isArray(items)) {
      for (const it of items) {
        if (!it) continue;
        if (it.contentDetails && it.contentDetails.duration) {
          const s = parseDurationToSeconds(it.contentDetails.duration);
          if (s >= 0) it._ytDurationSec = s;
        }
        if (it.liveBroadcastContent === undefined) {
          it.liveBroadcastContent = (it.snippet && it.snippet.liveBroadcastContent) || "none";
        }
      }
      items = applyContentFilter(items);
    }

    // Cache'e de küçültülmüş hâli yazılır → Redis belleği de ~%88 azalır.
    items = slimTop50(items);
    await cacheSet(cacheKey, items, CACHE_DURATION);
    // Isıtma listesine SADECE gerçekten liste alınabilen bölgeler girer —
    // aksi halde hata veren bölge her denemede skorunu artırıp çalışan
    // bölgeleri ilk 10'dan düşürüyordu.
    trackActiveRegion(region);

    // Top50 prewarm İPTAL: her /top50 isteğinde 15 şarkının MP3'ünü arka planda
    // dış provider'dan çözmeye çalışıyordu; provider 500 döndüğünde log'u hata seline
    // boğuyor ve zaten zorlanan provider'a ekstra yük biniyordu. Şarkılar ilk gerçek
    // dinlemede zaten çözülüp cache'leniyor.
    // prewarmTop10(items);

    res.setHeader("Cache-Control", `public, max-age=${CACHE_DURATION}`);
    res.json({ source: "youtube", region, data: slimTop50(items) });
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

  if (cached) {
    const titles = cached.slice(0, 10).map((item, i) => `${i+1}. ${item.snippet?.title || "?"}`);
    return res.json({ region, source: "cache", totalCached: cached.length, first10: titles });
  }

  // Cache boşsa YouTube API'den çek ama cache'leme
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
    const items = response.data.items || [];
    const titles = items.slice(0, 10).map((item, i) => `${i+1}. ${item.snippet?.title || "?"}`);
    res.json({ region, source: "youtube_live", totalFetched: items.length, first10: titles });
  } catch (e) {
    res.json({ region, source: "error", message: e.message });
  }
});

// SEARCH
app.get("/search", searchLimiter, async (req, res) => {
  const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "UNKNOWN";
  try {
    const query = req.query.q?.toLowerCase().trim();
    if (!query) return res.status(400).json({ error: "Query required" });

    const cacheKey = `search_bazocam:${query}`;

    // Redis cache kontrol — engelleme sonrası da filtrelenmeli
    const cached = await cacheGet(cacheKey);
    if (cached) {
      const cachedData = cached.data || cached;
      if (Array.isArray(cachedData)) {
        if (hasChannelTypeRule()) await enrichUploaders(cachedData);
        const filtered = applyContentFilter(filterBlockedChannels(cachedData, country));
        return res.json({ ...cached, data: filtered });
      }
      return res.json(cached);
    }

    // ADIM 1: Yeni API Provider (searchapi.php)
    let searchResult = null;
    try {
      console.log(`[SEARCH] API Provider kullanılıyor: "${query}"`);
      const apiData = await apiSearch(query);
      const results = apiData.results || apiData.data || apiData || [];
      const resultsArr = Array.isArray(results) ? results : [];
      // Kanal bazlı engelleme kuralı varsa, boş uploader'ları kanal adıyla doldur
      if (hasChannelTypeRule()) await enrichUploaders(resultsArr);
      // YouTube'un resmi canlı işaretiyle zenginleştir (provider vermiyor) → kesin canlı tespiti
      await enrichWithYouTubeDetails(resultsArr);
      const filteredData = applyContentFilter(filterBlockedChannels(resultsArr, country));
      searchResult = { data: filteredData, nextPageToken: null };
    } catch (apiError) {
      logError("SEARCH_API_FAIL", null, `API Provider arama başarısız: ${apiError.message}`);
      // Sabit bazocam fallback kaldırıldı — arama tamamen panel'deki provider'lardan gelir.
      // apiSearch zaten tüm aktif provider'ları sırayla deniyor. Hepsi çökerse YouTube API'ye düşülür.
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
          // search.list süre döndürmez; canlı bilgisini snippet'ten taşı (aşağıda süre ile zenginleştirilir)
          liveBroadcastContent: item.snippet.liveBroadcastContent || "none",
          snippet: {
            title: item.snippet.title,
            channelTitle: item.snippet.channelTitle,
            channelId: item.snippet.channelId || "",
            liveBroadcastContent: item.snippet.liveBroadcastContent || "none"
          }
        }));

        // search.list süre içermez → içerik filtresinin (≥35dk) çalışması için videos.list ile
        // gerçek süreleri (contentDetails.duration, ISO8601) ve canlı durumunu çek. Fallback nadir
        // çalıştığı için tek ek istek yeterli; başarısız olursa canlı filtresi yine snippet'ten çalışır.
        try {
          const ytIds = ytItems.map(i => i.id).filter(Boolean).join(",");
          if (ytIds) {
            const detailResp = await axiosClient.get("https://www.googleapis.com/youtube/v3/videos", {
              params: { part: "contentDetails,snippet", id: ytIds, key: YOUTUBE_API_KEY },
              timeout: 8000
            });
            const byId = {};
            for (const v of (detailResp.data.items || [])) byId[v.id] = v;
            for (const it of ytItems) {
              const v = byId[it.id];
              if (!v) continue;
              if (v.contentDetails?.duration) it.duration = v.contentDetails.duration; // "PT3M45S"
              const lbc = v.snippet?.liveBroadcastContent || it.liveBroadcastContent;
              it.liveBroadcastContent = lbc;
              it.snippet.liveBroadcastContent = lbc;
            }
          }
        } catch (detErr) {
          console.warn(`[SEARCH] videos.list süre zenginleştirme başarısız: ${detErr.message}`);
        }

        const filteredYt = applyContentFilter(filterBlockedChannels(ytItems, country));
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
// NOT: Sabit bazocam.net'e giden getBazocamCdnUrl fonksiyonu kaldırıldı.
// Tüm API çağrıları artık panel'den yönetilen provider sistemi üzerinden gidiyor
// (normalizeProviders + buildProviderUrl). Backend'de sabit kodlanmış API URL'i yok.

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
    // API Provider + smart cache + prewarm "audio_videoId.mp3" formatında kaydeder
    const mp3File = typeStr === "audio" ? path.join(targetCacheDir, `audio_${videoId}.mp3`) : null;

    //  KATMAN -1: FFMPEG MEDIA LIBRARY (En hızlı — kendi diskimiz)
    const mediaTrack = mediaLib.getReadyTrack(videoId, extStr === "m4a" ? "m4a" : "mp4");
    if (mediaTrack && mediaTrack.files) {
      const mediaFile = mediaTrack.files[extStr === "m4a" ? "m4a" : "mp4"];
      const mediaStat = await statOrNull(mediaFile);
      if (mediaStat) {
        console.log(`[MEDIA_LIB_HIT] 🎵 Kendi diskimizden sunuluyor: ${videoId}`);
        mediaLib.recordAccess(videoId);
        const fSize = mediaStat.size;
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
    // Üç olası dosya adını ASENKRON dene — ilk bulunanın stat'ı zaten elimizde olur.
    let diskFile = null, stats = null;
    for (const cand of [localFile, altFile, mp3File]) {
      const st = await statOrNull(cand);
      if (st) { diskFile = cand; stats = st; break; }
    }
    if (diskFile) {
      const minSize = typeStr === "video" ? 100 * 1024 : 20 * 1024;
      if (stats.size < minSize) {
        console.warn(`[DISK_CACHE_ERR] Bozuk dosya, siliniyor: ${diskFile}`);
        await fs.promises.unlink(diskFile).catch(() => {});
      } else {
        console.log(`[DISK_CACHE_HIT]  Diskten anında sunuluyor: ${videoId} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        touchCache(diskFile); // dinlendi → 24sa idle sayacını sıfırla
        const isMp3 = diskFile.endsWith(".mp3");
        if (req.path.includes("download")) {
          res.setHeader("Content-Disposition", `attachment; filename=${typeStr}_${videoId}.${isMp3 ? "mp3" : extStr}`);
        }
        res.setHeader("Content-Type", typeStr === "video" ? "video/mp4" : (isMp3 ? "audio/mpeg" : "audio/m4a"));
        res.setHeader("Content-Length", stats.size);
        res.setHeader("Accept-Ranges", "bytes");
        // Arka planda R2'ye yedekle (doğru uzantıyla)
        const actualR2Key = isMp3 ? `audio/${videoId}.mp3` : r2Key;
        ensureInR2(actualR2Key, diskFile).catch(() => { });
        return res.sendFile(diskFile, (err) => {
          if (err && err.status === 416) return res.status(416).end();
          if (err && !res.headersSent) res.status(500).end();
        });
      }
    }

    /*  KATMAN 1: CLOUDFLARE R2
        ⚠️ ANAHTAR UYUŞMAZLIĞI DÜZELTMESİ:
        Ses dosyaları R2'ye "audio/<id>.mp3" adıyla YAZILIYOR (uploadToR2
        çağrılarına bak), ama burada r2Key "audio/<id>.m4a" olarak kuruluyordu
        (extStr = "m4a"). Yani yazdığımız dosyayı hiç aramıyorduk → R2'deki
        679 dosya / 6.7 GB hazır cache tamamen ıskalanıyor, her istek
        bazocam'a gidiyordu.
        Artık ses için önce .mp3 (bizim yazdığımız), sonra .m4a (eski kayıtlar)
        deneniyor. Video tarafı zaten tutarlıydı (video/<id>.mp4), ona dokunulmadı. */
    const r2Candidates = typeStr === "audio"
      ? [`audio/${videoId}.mp3`, `audio/${videoId}.m4a`]
      : [r2Key];
    for (const key of r2Candidates) {
      try {
        const r2Data = await getR2Stream(key);
        if (r2Data && r2Data.stream) {
          console.log(`[R2_CACHE_HIT] --> Cloudflare'den sunuluyor: ${videoId} (${key})`);
          if (r2Data.contentType) res.setHeader("Content-Type", r2Data.contentType);
          if (r2Data.contentLength) res.setHeader("Content-Length", r2Data.contentLength);
          res.setHeader("Accept-Ranges", "bytes");
          safePipe(r2Data.stream, res);
          return;
        }
      } catch (r2Err) { /* bu anahtar yok — sıradakini dene */ }
    }

    /* NEGATİF CACHE KALDIRILDI (2026-08-08).
       Eskiden bir şarkı bir kez başarısız olunca `fail:mp3:<id>` yazılıp 10 dakika
       boyunca provider'a HİÇ gidilmiyordu. Provider (bazocam) iyileştikten sonra
       bile o şarkı 10 dakika daha hata vermeye devam ediyordu: aynı link tarayıcıda
       inerken uygulamada "başarısız" görünüyordu. Aşırı yüke karşı koruma zaten
       aşağıdaki tek-akış (single-flight) kilidiyle sağlanıyor. */

    // Akıllı cache: istek sayacını artır
    await incrementRequestCount(videoId);

    // Aynı şarkı başka bir worker'da ZATEN çevriliyorsa ikinci zinciri kurma.
    // (Aksi halde tek şarkı için bazocam'a 3-5 kat paralel istek gidiyordu.)
    if (!(await acquireConvertLock("mp3", videoId))) {
      console.log(`[STREAM] Tek-akış: ${videoId} zaten çevriliyor — bu istek atlandı`);
      return sendApiFailResponse(req, res, "Stream hazırlanıyor, lütfen tekrar deneyin");
    }

    // ★ YENİ BİRİNCİL YOL: API Provider (bazocam mp3download.php)
    // Cache katmanlarında bulunamadıysa, API'den direkt MP3 stream et
    try {
      console.log(`[STREAM] API Provider ile stream deneniyor: ${videoId}`);
      const apiResult = await apiStreamMp3(videoId, 320);
      // Dönüşüm başarılı → kilidi HEMEN bırak. Kilidin görevi "aynı şarkıyı paralel
      // çevirmeyi önlemek"ti; bazocam artık dönüştürdü (24sa cache'ledi). Kilidi 75sn
      // tutmak, aynı şarkının indirmesini/çalmasını boşuna bloke ediyordu.
      releaseConvertLock("mp3", videoId);

      res.setHeader("Content-Type", apiResult.contentType || "audio/mpeg");
      if (apiResult.contentLength) res.setHeader("Content-Length", apiResult.contentLength);
      res.setHeader("Accept-Ranges", "bytes");
      setDrmHeaders(res);

      // Akıllı cache: 3+ istek gelen şarkıyı TEK API çağrısıyla hem kullanıcıya
      // hem diske yaz (çift bazocam isteği yok — bazocam'ı yormamak için)
      const cacheFile = path.join(CACHE_DIR, `audio_${videoId}.mp3`);
      if ((await shouldCache(videoId)) && !fs.existsSync(cacheFile)) {
        const { PassThrough } = require("stream");
        const userStream = new PassThrough();
        const diskStream = new PassThrough();
        /* ⚠️ ATOMİK YAZMA — doğrudan son dosyaya yazma!
           ÖNCEDEN: createWriteStream(cacheFile) ile hedef dosyaya doğrudan
           yazılıyordu. İki sorun:
             1) pm2 4 worker çalıştırıyor. `!fs.existsSync(cacheFile)` kontrolü
                ile yazma arasında yarış var — iki worker aynı anda "yok" görüp
                aynı dosyaya yazabiliyor, içerik iç içe geçip bozuluyor.
             2) Aktarım yarıda kesilirse (timeout/abort) yarım dosya HEDEF
                adla diskte kalıyor ve sonraki istekte gerçek cache sanılıyor.
           Sonuç loglarda görülüyordu: "[DISK_CACHE_ERR] Bozuk dosya, siliniyor".
           ŞİMDİ: önce worker'a özel .tmp dosyasına yaz, boyut doğrulanınca
           rename ile yerine koy. rename atomiktir — yarım dosya asla görünmez.
           (Aynı desen kodun başka yerlerinde zaten kullanılıyor, bkz. satır ~835) */
        const tmpFile = `${cacheFile}.${process.pid}.tmp`;
        const writer = fs.createWriteStream(tmpFile);
        diskStream.pipe(writer);
        writer.on("finish", () => {
          try {
            const size = fs.statSync(tmpFile).size;
            if (size > 20 * 1024) {
              fs.renameSync(tmpFile, cacheFile);   // ← atomik yerine koyma
              console.log(`[SMART_CACHE] Diske kaydedildi: ${videoId} (${(size / 1024 / 1024).toFixed(2)} MB)`);
              uploadToR2(`audio/${videoId}.mp3`, cacheFile).catch(() => {});
            } else {
              fs.unlinkSync(tmpFile); // bozuk/küçük dosya hedefe hiç taşınmaz
            }
          } catch (e) { try { fs.unlinkSync(tmpFile); } catch {} }
        });
        writer.on("error", () => { try { fs.unlinkSync(tmpFile); } catch {} });
        apiResult.stream.on("data", (chunk) => { userStream.write(chunk); diskStream.write(chunk); });
        apiResult.stream.on("end", () => { userStream.end(); diskStream.end(); });
        apiResult.stream.on("error", (err) => { userStream.destroy(err); diskStream.destroy(err); });
        safePipe(userStream, res);
      } else {
        safePipe(apiResult.stream, res);
      }
      return;
    } catch (apiErr) {
      console.warn(`[STREAM] API Provider başarısız: ${videoId} — ${apiErr.message}`);
      // Negatif cache yazımı kaldırıldı — bir başarısızlık şarkıyı 10 dk kilitlemesin.
      releaseConvertLock("mp3", videoId); // başarısızlıkta hemen bırak (başarıda TTL düşürür)
      if (!res.headersSent) {
        res.setHeader("Cache-Control", "no-store");
        res.status(503).json({ error: "Stream geçici olarak kullanılamıyor" });
      }
      return;
    }

    res.status(200);
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
        touchCache(diskVideoFile); // dinlendi → 24sa idle sayacını sıfırla
        ensureInR2(r2Key, diskVideoFile).catch(() => { });

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

    /* NEGATİF CACHE KALDIRILDI (2026-08-08) — MP3 tarafındaki gerekçenin aynısı:
       tek başarısızlık videoyu 10 dakika kilitliyordu, provider iyileşse bile. */

    // ★ KATMAN 2: API PROVIDER (bazocam MP4) — proxy/yt-dlp'ye gerek kalmadan video stream
    try {
      console.log(`[VIDEO_API] API Provider ile video stream deneniyor: ${videoId}`);
      const apiResult = await apiStreamMp4(videoId, 720);
      if (apiResult && apiResult.stream) {
        console.log(`[VIDEO_API_HIT] ✅ Video API Provider'dan sunuluyor: ${videoId}`);
        res.setHeader("Content-Type", "video/mp4");
        if (apiResult.contentLength) res.setHeader("Content-Length", apiResult.contentLength);
        res.setHeader("Accept-Ranges", "bytes");

        // Aynı stream'i hem response'a hem diske yaz (tek API çağrısı)
        const cachePath = path.join(VIDEO_CACHE_DIR, `video_${videoId}.mp4`);
        const shouldCache = !fs.existsSync(cachePath);
        if (shouldCache) {
          const { PassThrough } = require("stream");
          const teeStream = new PassThrough();
          const diskStream = new PassThrough();
          const writer = fs.createWriteStream(cachePath);
          diskStream.pipe(writer);
          writer.on("finish", () => {
            try {
              const size = fs.statSync(cachePath).size;
              if (size > 100 * 1024) {
                console.log(`[VIDEO_API_CACHE] Video disk cache'e kaydedildi: ${videoId} (${(size / 1024 / 1024).toFixed(2)} MB)`);
                mediaLib.upsertTrack(videoId, { mp4: cachePath, status: "ready", category: "watching", mp4Size: size });
                uploadToR2(`video/${videoId}.mp4`, cachePath).catch(() => {});
              } else {
                fs.unlinkSync(cachePath);
              }
            } catch (e) {}
          });
          writer.on("error", () => { try { fs.unlinkSync(cachePath); } catch (e) {} });
          apiResult.stream.on("data", (chunk) => {
            teeStream.write(chunk);
            diskStream.write(chunk);
          });
          apiResult.stream.on("end", () => {
            teeStream.end();
            diskStream.end();
          });
          apiResult.stream.on("error", (err) => {
            teeStream.destroy(err);
            diskStream.destroy(err);
          });
          safePipe(teeStream, res);
        } else {
          safePipe(apiResult.stream, res);
        }
        return;
      }
    } catch (apiErr) {
      console.warn(`[VIDEO_API] API Provider başarısız: ${videoId} — ${apiErr.message}`);
      // Negatif cache yazımı kaldırıldı.
      if (!res.headersSent) {
        res.setHeader("Cache-Control", "no-store");
        res.status(503).json({ error: "Video stream geçici olarak kullanılamıyor" });
      }
      return;
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
/* PM2 cluster'da 4 worker var ve her birinin KENDİ activeRegions Set'i vardı.
   Isıtmayı ise yalnızca worker 0 yapıyor → worker 2'ye düşen Brezilyalı kullanıcının
   ülkesi worker 0'a hiç ulaşmıyor, o ülke HİÇ ısıtılmıyordu. Sonuç: TR/US dışındaki
   her ülkede ilk kullanıcı tam YouTube API turu bekliyordu (yavaş açılışın sebebi).
   Çözüm: bölgeler Redis'te ortak sorted set'te (skor = son görülme zamanı).
   Sorted set aynı zamanda listeyi sınırlı tutar — rastgele/VPN ülkeleri zamanla düşer,
   YouTube kotası şişmez. */
const REGIONS_ZKEY = "top50:active_regions";        // skor = ülkeden gelen TOPLAM istek sayısı (hacim önceliği)
const REGIONS_SEEN_HKEY = "top50:region_lastseen";  // ülke → son görülme zamanı (7 gün inaktif prune için)
const WARM_REGION_LIMIT = 10;   // en ÇOK istek gelen bu kadar ülke ısıtılır (yük azaltma: eskiden 25)

function trackActiveRegion(country) {
  if (!country || country === "UNKNOWN" || country.length !== 2) return;
  const region = country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return;
  if (!activeRegions.has(region)) {
    activeRegions.add(region);
    console.log(`[AUTO_REGION] 🌍 Yeni ülke algılandı: ${region} — Top50 ısıtmaya eklendi (toplam: ${activeRegions.size})`);
  }
  // Tüm worker'ların gördüğü ülkeler burada birleşir (fire&forget — isteği asla bozmaz).
  // ÖNCELİK = HACİM: her istekte sayaç +1 → en çok istek gelen ülkeler warmup'ta öne geçer.
  // Son görülme zamanı ayrı hash'te tutulur (7 gün inaktif ülkeleri düşürmek için).
  try {
    redis.zincrby(REGIONS_ZKEY, 1, region).catch(() => {});
    redis.hset(REGIONS_SEEN_HKEY, region, Date.now()).catch(() => {});
  } catch (e) {}
}

async function warmTop50() {
  // Ortak listeyi Redis'ten al → diğer worker'ların gördüğü ülkeler de ısıtılır.
  // En ÇOK istek gelen WARM_REGION_LIMIT ülke ile sınırlı (hacim önceliği + kota koruması).
  let regions = WARM_REGIONS.list; // Redis yoksa fallback: yerel görülen ülkeler (TR/US tabanı dahil)
  try {
    // En ÇOK istek gelen ülkeler önce (skor = toplam istek sayısı, ZREVRANGE azalan sırada döner).
    const shared = await redis.zrevrange(REGIONS_ZKEY, 0, WARM_REGION_LIMIT - 1);
    if (Array.isArray(shared) && shared.length) {
      regions = shared; // tamamen hacme göre öncelik
    }
    // 7 günden beri HİÇ istek gelmeyen ülkeleri hem sayaç setinden hem son-görülme hash'inden düşür
    // (skor artık zaman değil sayaç olduğu için eski zremrangebyscore mantığı yerine son-görülme hash'i kullanılır).
    const seen = await redis.hgetall(REGIONS_SEEN_HKEY);
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const stale = Object.entries(seen || {}).filter(([, ts]) => Number(ts) < cutoff).map(([r]) => r);
    if (stale.length) {
      await redis.zrem(REGIONS_ZKEY, ...stale).catch(() => {});
      await redis.hdel(REGIONS_SEEN_HKEY, ...stale).catch(() => {});
    }
  } catch (e) { /* Redis yoksa yerel liste ile devam */ }
  console.log(`[WARMUP] ${regions.length} aktif ülke ısıtılacak: ${regions.join(", ")}`);
  for (const region of regions) {
    try {
      // /top50 ile aynı mantık: kategori grafiği olmayan bölgelerde kategorisiz dene.
      const wParams = {
        part: "snippet,contentDetails,statistics",
        chart: "mostPopular",
        regionCode: region,
        maxResults: 50,
        key: YOUTUBE_API_KEY
      };
      if (!(await redisFast(redis.exists(`top50:nocat:${region}`), 0))) wParams.videoCategoryId = 10;

      let response;
      try {
        response = await axiosClient.get("https://www.googleapis.com/youtube/v3/videos", { params: wParams });
      } catch (wErr) {
        if (wErr.response && wErr.response.status === 400 && wParams.videoCategoryId) {
          delete wParams.videoCategoryId;
          response = await axiosClient.get("https://www.googleapis.com/youtube/v3/videos", { params: wParams });
          redis.set(`top50:nocat:${region}`, "1", "EX", 7 * 86400).catch(() => {});
        } else {
          throw wErr;
        }
      }
      trackYoutubeApiCall();
      // Isıtmada da küçültülmüş hâli cache'lenir (yanıt %88 küçülür, Redis belleği de).
      const items = slimTop50(filterBlockedChannels(response.data.items));
      await cacheSet(`top50:${region}`, items, CACHE_DURATION);
      console.log(`[WARMUP] Top50 ${region} cache hazır.`);

      // Top50 prewarm İPTAL (yukarıdaki /top50 ile aynı gerekçe): MP3 ön-ısıtma dış
      // provider'ı boğup 500 seline yol açıyordu. Liste cache'i (yukarıda) korunuyor.
      // if (regions.length <= 5) prewarmTop10(items);
    } catch (e) {
      console.warn(`[WARMUP] Top50 ${region} başarısız: ${e.message}`);
      // Quota aşıldıysa diğer bölgeleri de deneme
      if (e.response && (e.response.status === 403 || e.response.status === 429)) break;
    }
  }
}

// Her warmupIntervalMs'de bir arkaplanda güncelleyerek anlık gecikmelerin önüne geç (sadece primary worker)
if (isPrimaryWorker) warmupTimer = setInterval(warmTop50, warmupIntervalMs);

/* =========================
   FEEDBACK (Rating Funnel)
========================= */
const FEEDBACK_FILE = "feedbacks.json";  // pathFor ile per-app: default→kök, diğerleri→data/<appId>/

function loadFeedbacks(appId = "default") {
  try {
    const file = pathFor(appId, FEEDBACK_FILE);
    if (!fs.existsSync(file)) { ensureAppData(appId); fs.writeFileSync(file, "[]"); }
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return [];
  }
}

function saveFeedbacks(data, appId = "default") {
  ensureAppData(appId);
  fs.writeFileSync(pathFor(appId, FEEDBACK_FILE), JSON.stringify(data, null, 2));
}

app.post("/feedback", express.json(), (req, res) => {
  const { rating, text, deviceId, country } = req.body;
  if (!rating) return res.status(400).json({ error: "rating zorunlu" });

  const appId = resolveAppId(req);
  const all = loadFeedbacks(appId);
  all.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    rating: Number(rating),
    text: text || "",
    deviceId: deviceId || "",
    country: country || "",
    createdAt: new Date().toISOString()
  });
  saveFeedbacks(all, appId);
  res.json({ ok: true });
});

app.get("/feedbacks", (req, res) => {
  res.json(loadFeedbacks(resolveAppId(req)));
});

app.delete("/feedback/:id", (req, res) => {
  const appId = resolveAppId(req);
  const all = loadFeedbacks(appId);
  const filtered = all.filter(f => f.id !== req.params.id);
  if (filtered.length === all.length) return res.status(404).json({ error: "Bulunamadı" });
  saveFeedbacks(filtered, appId);
  res.json({ ok: true });
});

/* =========================
   GOOGLE IN-APP REVIEW LOGLARI
   ÖNEMLİ SINIR: Google, kullanıcının kaç yıldız verdiğini ASLA bildirmez.
   Buradaki loglar sadece şunu ölçer:
     request_ok   → Google isteği kabul etti, kart hazır
     request_fail → Google reddetti (errorCode ile), kart KESİNLİKLE açılmadı
     flow_done    → akış bitti; durationMs kısa ise kart görünmemiş demektir
   Gerçek yıldız ortalaması yalnızca Play Console'da görülür.
========================= */
const REVIEW_LOG_FILE = "review_logs.json";  // pathFor ile per-app
const REVIEW_LOG_MAX = 2000;

function loadReviewLogs(appId = "default") {
  try {
    const file = pathFor(appId, REVIEW_LOG_FILE);
    if (!fs.existsSync(file)) { ensureAppData(appId); fs.writeFileSync(file, "[]"); }
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return [];
  }
}

function saveReviewLogs(data, appId = "default") {
  ensureAppData(appId);
  fs.writeFileSync(pathFor(appId, REVIEW_LOG_FILE), JSON.stringify(data.slice(0, REVIEW_LOG_MAX), null, 2));
}

const REVIEW_EVENTS = ["popup_shown", "button_tap", "request_ok", "request_fail", "flow_done"];

app.post("/review-log", express.json(), (req, res) => {
  const { event, detail, errorCode, durationMs, deviceId, appVersion } = req.body;
  if (!REVIEW_EVENTS.includes(event)) return res.status(400).json({ error: "gecersiz event" });

  const appId = resolveAppId(req);
  const all = loadReviewLogs(appId);
  all.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    event,
    detail: detail || "",
    errorCode: errorCode !== undefined && errorCode !== null ? String(errorCode) : "",
    durationMs: Number(durationMs) || 0,
    deviceId: deviceId || "",
    appVersion: appVersion || "",
    country: req.headers["cf-ipcountry"] || req.headers["x-country"] || "?",
    sdk: req.headers["x-android-sdk"] || "",
    ip: req.ip || "",
    createdAt: new Date().toISOString()
  });
  saveReviewLogs(all, appId);
  res.json({ ok: true });
});

app.get("/admin/review-logs", basicAuth, (req, res) => {
  const all = loadReviewLogs(resolveAppId(req));
  const counts = { popup_shown: 0, button_tap: 0, request_ok: 0, request_fail: 0, flow_done: 0 };
  const errorCodes = {};
  // Google kartın gösterilip gösterilmediğini bildirmez. İstemci bunu pencere
  // odağı üzerinden ölçüyor: kart açılırsa uygulama odağı kaybeder. Sonuç
  // flow_done kaydının detail alanına yazılır. Eski süre tahmini KULLANILMIYOR.
  //   card_shown     → kart gerçekten ekrana geldi
  //   card_not_shown → akış çalıştı ama kart hiç açılmadı (çoğunlukla Play'den
  //                    kurulmamış cihaz veya Google kotası)
  //   unknown        → ölçüm güvenilir değildi, hiçbir sayıya katılmaz
  let cardShown = 0, cardNotShown = 0, cardUnknown = 0;
  for (const l of all) {
    if (counts[l.event] !== undefined) counts[l.event]++;
    if (l.event === "request_fail" && l.errorCode) {
      errorCodes[l.errorCode] = (errorCodes[l.errorCode] || 0) + 1;
    }
    if (l.event === "flow_done") {
      if (l.detail === "card_shown") cardShown++;
      else if (l.detail === "card_not_shown") cardNotShown++;
      else cardUnknown++;   // eski sürümlerden gelen detailsiz kayıtlar da buraya düşer
    }
  }
  res.json({
    total: all.length,
    counts,
    errorCodes,
    cardShown,
    cardNotShown,
    cardUnknown,
    logs: all.slice(0, 300)
  });
});

app.delete("/admin/review-logs", basicAuth, (req, res) => {
  saveReviewLogs([], resolveAppId(req));
  res.json({ ok: true });
});

/* =========================
   GİRİŞ YAPAN IP'LER (Admin Panel) — Redis tabanlı
   Not: Sunucu PM2 cluster (çok worker) ile çalışıyor. Eski dosya+hafıza
   yöntemi worker'lar arası tutarsızdı ve "temizle" kalıcı olmuyordu
   (başka worker eski listeyi geri yazıyordu). Redis tüm worker'larda
   ortak olduğu için kayıt/temizleme artık atomik ve kalıcı.
========================= */
const LOGIN_IPS_MAX = 500;              // en fazla 500 IP tutulur (en eskisi düşer)
const LOGIN_IPS_ZKEY = "login:ips:z";   // sorted set: member=ip, score=lastSeen(ms)
const loginIpKey = (ip) => `login:ip:${ip}`;
/* UYGULAMA BAŞINA İZOLASYON — her paket kendi giriş IP'lerini görür.
   default/boş → eski global anahtarlar (mevcut veri korunur, süper panel hepsini görür). */
const loginIpsZKeyApp = (appId) => appId && appId !== "default" ? `login:ips:z:app:${appId}` : LOGIN_IPS_ZKEY;
const loginIpKeyApp = (ip, appId) => appId && appId !== "default" ? `login:ip:app:${appId}:${ip}` : loginIpKey(ip);

async function recordLoginIp(req, endpoint) {
  try {
    const ip = req.ip || "?";
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "?";
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    // Uygulama kendi paket adını X-App-Package ile bildirir → kendi listesine yazılır
    const appId = resolveAppId(req);
    const zkey = loginIpsZKeyApp(appId);
    const key = loginIpKeyApp(ip, appId);

    const pipe = redis.pipeline();
    pipe.hincrby(key, "count", 1);
    pipe.hset(key, { lastSeen: nowIso, endpoint, userAgent: req.headers["user-agent"] || "" });
    if (country !== "?") pipe.hset(key, "country", country);
    // İlk görülme / id / ip yalnızca yoksa yazılır
    pipe.hsetnx(key, "firstSeen", nowIso);
    pipe.hsetnx(key, "id", nowMs.toString(36) + Math.random().toString(36).slice(2, 6));
    pipe.hsetnx(key, "ip", ip);
    pipe.zadd(zkey, nowMs, ip);
    await pipe.exec();

    // 500 sınırı: fazlaysa en eski kayıtları at (yalnızca primary worker yapar)
    if (isPrimaryWorker) {
      const total = await redis.zcard(zkey);
      if (total > LOGIN_IPS_MAX) {
        const stale = await redis.zrange(zkey, 0, total - LOGIN_IPS_MAX - 1);
        if (stale.length) {
          const delPipe = redis.pipeline();
          stale.forEach(sip => delPipe.del(loginIpKeyApp(sip, appId)));
          delPipe.zremrangebyrank(zkey, 0, stale.length - 1);
          await delPipe.exec();
        }
      }
    }
  } catch (e) {
    console.error("[LOGIN_IPS] Kayıt hatası:", e.message);
  }
}

app.get("/admin/login-ips", basicAuth, async (req, res) => {
  try {
    // İzole panelden gelindiyse SADECE o uygulamanın IP'leri; master ise global liste
    const boundApp = resolveScopeApp(req);
    const zkey = loginIpsZKeyApp(boundApp);
    const ips = await redis.zrevrange(zkey, 0, -1); // en yeni önce
    if (!ips.length) return res.json({ total: 0, ips: [] });
    const pipe = redis.pipeline();
    ips.forEach(ip => pipe.hgetall(loginIpKeyApp(ip, boundApp)));
    const results = await pipe.exec();
    const list = results
      .map(([err, h]) => (err || !h || !h.ip) ? null : { ...h, count: Number(h.count) || 0 })
      .filter(Boolean);
    res.json({ total: list.length, ips: list });
  } catch (e) {
    console.error("[LOGIN_IPS] Listeleme hatası:", e.message);
    res.status(500).json({ error: "Listeleme hatası: " + e.message });
  }
});

app.delete("/admin/login-ips", basicAuth, async (req, res) => {
  try {
    // Sadece kendi uygulamasının listesini temizler — diğer uygulamalara dokunmaz
    const boundApp = resolveScopeApp(req);
    const zkey = loginIpsZKeyApp(boundApp);
    const ips = await redis.zrange(zkey, 0, -1);
    const pipe = redis.pipeline();
    ips.forEach(ip => pipe.del(loginIpKeyApp(ip, boundApp)));
    pipe.del(zkey);
    await pipe.exec();
    console.log(`[LOGIN_IPS] Liste temizlendi (${ips.length} kayıt, istek IP: ${req.ip})`);
    res.json({ ok: true, cleared: ips.length });
  } catch (e) {
    console.error("[LOGIN_IPS] Temizleme hatası:", e.message);
    res.status(500).json({ error: "Temizlenemedi: " + e.message });
  }
});

/* =========================
   CANLI (AKTİF) KULLANICILAR — Redis tabanlı presence
   Uygulamada heartbeat yok; "aktif" = son N dakikada backend'e istek atmış cihaz.
   Kimlik önceliği: X-Device-Id > Bearer token > ip+userAgent hash'i.
   Cluster'da tutarlı olsun diye tüm veri Redis'te (login-ips ile aynı gerekçe).
========================= */
const PRESENCE_ZKEY = "presence:z";              // sorted set: member=uid, score=lastSeen(ms)
const PRESENCE_RETENTION_MS = 60 * 60 * 1000;    // 1 saatten eski kayıtlar düşer
const PRESENCE_THROTTLE_MS = 30 * 1000;          // aynı cihaz için en fazla 30 sn'de bir Redis yazımı
const PRESENCE_LIST_LIMIT = 300;                 // panele en fazla bu kadar satır gönderilir
const presenceLastWrite = new Map();             // worker-local throttle: uid -> ms
const presenceKey = (uid) => `presence:u:${uid}`;
const presenceMinKey = (ms) => "presence:min:" + new Date(ms).toISOString().slice(0, 16).replace(/[-:T]/g, "");

/* --- Çıkarıcı (NewPipe / Backend) ayrımı ---
   Uygulama iki yoldan biriyle içerik çözer:
     Android 13+ (SDK>=33) → NewPipe Extractor, cihaz üzerinde
     Android 12- (SDK<33)  → backend'in /search + /stream API'leri
   Bu ayrım SUNUCUDAN ANLAŞILAMAZ: uygulamadaki tüm istekler aynı sabit
   tarayıcı User-Agent'ını kullanıyor. Bu yüzden uygulama X-Extractor
   header'ıyla kendisi bildirir; eski APK'lar için X-Android-Sdk'dan türetilir. */
const EXTRACTORS = ["newpipe", "backend", "unknown"];
const PRESENCE_EXTRACTOR_ZKEY = (ex) => `presence:z:${ex}`;

/* appId-kapsamlı presence anahtarları — izole panelde canlı-kullanıcı sayımı
   sadece o uygulamayı göstersin diye. appId boş/"default" → GLOBAL (süper panel,
   eski davranış aynen korunur). Non-default trafik hem global hem per-app havuza yazılır. */
const presenceZKeyApp = (appId) => appId ? `presence:z:app:${appId}` : PRESENCE_ZKEY;
const presenceExtractorZKeyApp = (ex, appId) => appId ? `presence:z:app:${appId}:${ex}` : PRESENCE_EXTRACTOR_ZKEY(ex);
const presenceMinKeyApp = (ms, appId) => appId
  ? "presence:min:app:" + appId + ":" + new Date(ms).toISOString().slice(0, 16).replace(/[-:T]/g, "")
  : presenceMinKey(ms);

function normalizeExtractor(req) {
  const raw = String(req.headers["x-extractor"] || "").toLowerCase().trim();
  if (raw === "newpipe" || raw === "np") return "newpipe";
  if (raw === "backend" || raw === "api") return "backend";
  // Eski APK: X-Extractor yok ama SDK varsa kuraldan türet
  const sdk = parseInt(req.headers["x-android-sdk"]);
  if (Number.isFinite(sdk) && sdk > 0) return sdk >= 33 ? "newpipe" : "backend";
  return "unknown";
}

/* ─────────────────────────────────────────────────────────────────────────
   IP → (cihaz, uygulama) HAFIZASI  —  canlı kullanıcı izolasyonu

   Sorun: ExoPlayer'ın /stream ve /stream/video istekleri OkHttp interceptor'ını
   ATLAR (DefaultHttpDataSource), bu yüzden X-App-Package / X-Device-Id TAŞIMAZ.
   Kullanıcı müzik dinlerken akan tek trafik bu olduğundan presence "default"
   havuzuna yazılıyor, izole panelde (ogzmusic/memomusic) canlı kullanıcı hep
   boş görünüyordu — giriş IP'leri ise kalıcı liste olduğu için görünüyordu.

   Çözüm (APK değişmeden): kimlik taşıyan isteklerde (/config, /search, /top50)
   IP → "uid|appId" eşlemesini hatırla; kimliksiz istekte (stream) aynı IP'den
   son bilinen cihaz+uygulamayı kullan. uid'i de devraldığımız için aynı cihaz
   mükerrer sayılmaz. Eşleme yoksa eski davranış korunur (regresyon yok).
   ───────────────────────────────────────────────────────────────────────── */
const APP_BY_IP_TTL = 7200;                       // 2 saat
const appByIpKey = (ip) => `app:byip:${ip}`;

function presenceUid(req) {
  const dev = req.headers["x-device-id"];
  if (typeof dev === "string" && dev.length >= 6) return "d:" + dev.slice(0, 64);
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) {
    return "t:" + crypto.createHash("sha1").update(auth.substring(7)).digest("hex").slice(0, 16);
  }
  const raw = (req.ip || "?") + "|" + (req.headers["user-agent"] || "");
  return "i:" + crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

// Sayılmayacak istekler: admin paneli, statik dosyalar, sağlık kontrolü, load test
function isPresenceCountable(req) {
  const p = req.path;
  if (req.headers["x-app-key"]) return false;   // admin panel (master VEYA per-app key) — son kullanıcı değil
  if (p === "/health" || p === "/favicon.ico" || p === "/loadtest") return false;
  if (p.startsWith("/admin") || p.startsWith("/proxy-panel") || p.startsWith("/cache-panel")) return false;
  if (p === "/converter" || p === "/playlist-cache") return false;
  if (p.endsWith(".html") || p.endsWith(".js") || p.endsWith(".css") || p.endsWith(".map") ||
      p.endsWith(".png") || p.endsWith(".ico") || p.endsWith(".json")) return false;
  return true;
}

async function recordPresence(req) {
  try {
    if (!isPresenceCountable(req)) return;
    let uid = presenceUid(req);
    const nowMs = Date.now();

    // Throttle — aynı cihaz 30 sn içinde tekrar yazılmaz (yoğun trafikte Redis'i korur)
    const last = presenceLastWrite.get(uid);
    if (last && nowMs - last < PRESENCE_THROTTLE_MS) return;
    presenceLastWrite.set(uid, nowMs);
    if (presenceLastWrite.size > 20000) {
      for (const [k, t] of presenceLastWrite) {
        if (nowMs - t > PRESENCE_THROTTLE_MS) presenceLastWrite.delete(k);
      }
    }

    const ip = req.ip || "?";
    const country = req.headers["cf-ipcountry"] || req.headers["x-country"] || "?";

    // ── Uygulama kimliği: header varsa KESİN, yoksa IP hafızasından devral ──
    let appId = resolveAppId(req);
    const hasAppIdentity = !!(req.headers["x-app-package"] || req.headers["x-app-id"]);
    const hasDeviceId = typeof req.headers["x-device-id"] === "string" && req.headers["x-device-id"].length >= 6;
    if (hasAppIdentity && hasDeviceId) {
      // Kimliği kesin bilinen istek → bu IP'nin cihaz+uygulamasını hatırla.
      // "default" (Musica) da yazılır; böylece Musica kullanıcısı IP paylaşsa bile
      // yanlışlıkla başka bir uygulamaya sayılmaz.
      redis.set(appByIpKey(ip), uid + "|" + appId, "EX", APP_BY_IP_TTL).catch(() => {});
    } else if (!hasAppIdentity) {
      // Kimliksiz istek (ExoPlayer /stream) → aynı IP'den son bilineni kullan
      const rec = await redis.get(appByIpKey(ip)).catch(() => null);
      if (rec) {
        const sep = rec.indexOf("|");
        const mUid = sep > 0 ? rec.slice(0, sep) : "";
        const mApp = sep > 0 ? rec.slice(sep + 1) : "";
        if (mUid) uid = mUid;                               // mükerrer cihaz sayımını önler
        if (mApp && getApps()[mApp]) appId = mApp;
      }
    }

    const key = presenceKey(uid);
    const minKey = presenceMinKey(nowMs);

    // Çıkarıcı (extractor) tespiti — Android 13+ NewPipe, altı backend API kullanır.
    // Uygulama X-Extractor gönderir; göndermiyorsa (eski APK) X-Android-Sdk'dan türetilir.
    // İkisi de yoksa "unknown" — sunucu tarafında güvenilir başka sinyal yok.
    const extractor = normalizeExtractor(req);
    const sdk = parseInt(req.headers["x-android-sdk"]);

    const pipe = redis.pipeline();
    pipe.hset(key, { ip, lastSeen: nowMs.toString(), endpoint: req.path, userAgent: req.headers["user-agent"] || "" });
    if (country !== "?") pipe.hset(key, "country", country);
    if (extractor !== "unknown") pipe.hset(key, "extractor", extractor);
    if (Number.isFinite(sdk) && sdk > 0) pipe.hset(key, "sdk", String(sdk));
    // Cihaz tek bir çıkarıcı kümesinde bulunmalı — APK güncellemesiyle
    // "unknown" → "newpipe" geçişinde çift sayılmasın diye diğerlerinden çıkar.
    pipe.zadd(PRESENCE_EXTRACTOR_ZKEY(extractor), nowMs, uid);
    EXTRACTORS.filter(ex => ex !== extractor)
      .forEach(ex => pipe.zrem(PRESENCE_EXTRACTOR_ZKEY(ex), uid));
    pipe.hsetnx(key, "firstSeen", nowMs.toString());
    pipe.hincrby(key, "hits", 1);
    pipe.expire(key, 3600);
    pipe.zadd(PRESENCE_ZKEY, nowMs, uid);
    pipe.pfadd(minKey, uid);      // dakikalık benzersiz sayım (grafik için)
    pipe.expire(minKey, 7200);

    // İZOLE PANEL: non-default uygulama trafiğini ayrıca per-app havuza yaz.
    // appId yukarıda çözüldü: header'dan (kesin) veya IP hafızasından (stream).
    if (appId && appId !== "default") {
      pipe.hset(key, "appId", appId);
      pipe.zadd(presenceZKeyApp(appId), nowMs, uid);
      pipe.zadd(presenceExtractorZKeyApp(extractor, appId), nowMs, uid);
      EXTRACTORS.filter(ex => ex !== extractor)
        .forEach(ex => pipe.zrem(presenceExtractorZKeyApp(ex, appId), uid));
      const minKeyApp = presenceMinKeyApp(nowMs, appId);
      pipe.pfadd(minKeyApp, uid);
      pipe.expire(minKeyApp, 7200);
    }
    pipe.exec().catch(() => {});
  } catch (e) {
    // presence asla isteği bozmamalı — sessizce yut
  }
}

// Eski kayıtların temizliği — yalnızca primary worker
if (isPrimaryWorker) {
  setInterval(async () => {
    try {
      const cutoff = Date.now() - PRESENCE_RETENTION_MS;
      const stale = await redis.zrangebyscore(PRESENCE_ZKEY, 0, cutoff);
      const pipe = redis.pipeline();
      stale.forEach(uid => pipe.del(presenceKey(uid)));
      pipe.zremrangebyscore(PRESENCE_ZKEY, 0, cutoff);
      // Çıkarıcı kümeleri de aynı pencereyle budanır
      EXTRACTORS.forEach(ex => pipe.zremrangebyscore(PRESENCE_EXTRACTOR_ZKEY(ex), 0, cutoff));
      // Per-app (izole panel) kümeleri de budanır
      Object.keys(getApps()).filter(id => id !== "default").forEach(id => {
        pipe.zremrangebyscore(presenceZKeyApp(id), 0, cutoff);
        EXTRACTORS.forEach(ex => pipe.zremrangebyscore(presenceExtractorZKeyApp(ex, id), 0, cutoff));
      });
      await pipe.exec();
    } catch (e) {
      console.error("[PRESENCE] Temizlik hatası:", e.message);
    }
  }, 5 * 60 * 1000).unref();
}

app.get("/admin/active-users", basicAuth, async (req, res) => {
  try {
    const nowMs = Date.now();
    const windowMin = Math.min(Math.max(parseInt(req.query.window) || 5, 1), 60);
    const winFrom = nowMs - windowMin * 60 * 1000;

    // İZOLE PANEL kapsamı: per-app key ile gelindiyse SADECE o uygulama;
    // master key (süper panel) ile gelindiyse null → GLOBAL (tüm uygulamalar).
    const boundApp = resolveScopeApp(req);
    const ZKEY = presenceZKeyApp(boundApp);
    const EXKEY = (ex) => presenceExtractorZKeyApp(ex, boundApp);
    const MINKEY = (ms) => presenceMinKeyApp(ms, boundApp);

    const [c5, c15, c60] = await Promise.all([
      redis.zcount(ZKEY, nowMs - 5 * 60 * 1000, "+inf"),
      redis.zcount(ZKEY, nowMs - 15 * 60 * 1000, "+inf"),
      redis.zcount(ZKEY, nowMs - 60 * 60 * 1000, "+inf"),
    ]);

    // Çıkarıcı bazlı sayaçlar (NewPipe / Backend / Bilinmiyor) — 5 dk, 15 dk, 1 sa
    const exPipe = redis.pipeline();
    EXTRACTORS.forEach(ex => {
      exPipe.zcount(EXKEY(ex), nowMs - 5 * 60 * 1000, "+inf");
      exPipe.zcount(EXKEY(ex), nowMs - 15 * 60 * 1000, "+inf");
      exPipe.zcount(EXKEY(ex), nowMs - 60 * 60 * 1000, "+inf");
    });
    const exRes = await exPipe.exec();
    const byExtractor = {};
    EXTRACTORS.forEach((ex, i) => {
      const num = (r) => (r && !r[0] ? Number(r[1]) || 0 : 0);
      byExtractor[ex] = {
        online5m: num(exRes[i * 3]),
        online15m: num(exRes[i * 3 + 1]),
        online1h: num(exRes[i * 3 + 2]),
      };
    });

    // Pencere içindeki cihazlar (en yeni önce)
    const uids = await redis.zrevrangebyscore(ZKEY, "+inf", winFrom);
    let users = [];
    const byCountryMap = {};
    const windowByExtractor = { newpipe: 0, backend: 0, unknown: 0 };
    if (uids.length) {
      const pipe = redis.pipeline();
      uids.forEach(uid => pipe.hgetall(presenceKey(uid)));
      const results = await pipe.exec();
      results.forEach(([err, h], i) => {
        if (err || !h || !h.ip) return;
        const country = h.country || "?";
        byCountryMap[country] = (byCountryMap[country] || 0) + 1;
        const ex = EXTRACTORS.includes(h.extractor) ? h.extractor : "unknown";
        windowByExtractor[ex]++;
        if (users.length < PRESENCE_LIST_LIMIT) {
          users.push({
            uid: uids[i],
            ip: h.ip,
            country,
            extractor: ex,
            sdk: h.sdk ? Number(h.sdk) : null,
            endpoint: h.endpoint || "",
            hits: Number(h.hits) || 0,
            firstSeen: new Date(Number(h.firstSeen) || nowMs).toISOString(),
            lastSeen: new Date(Number(h.lastSeen) || nowMs).toISOString(),
            secondsAgo: Math.max(0, Math.round((nowMs - (Number(h.lastSeen) || nowMs)) / 1000)),
          });
        }
      });
    }

    const byCountry = Object.entries(byCountryMap)
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count);

    // Son 60 dakikanın dakika bazlı benzersiz cihaz sayısı (grafik)
    const tlPipe = redis.pipeline();
    const minutes = [];
    for (let i = 59; i >= 0; i--) {
      const ms = nowMs - i * 60 * 1000;
      minutes.push(new Date(ms).toISOString().slice(11, 16));
      tlPipe.pfcount(MINKEY(ms));
    }
    const tlRes = await tlPipe.exec();
    const timeline = tlRes.map(([err, v], i) => ({ t: minutes[i], count: err ? 0 : (Number(v) || 0) }));

    res.json({
      online: c5,                              // varsayılan "şu an aktif" = son 5 dk
      online5m: c5,
      online15m: c15,
      online1h: c60,
      window: windowMin,
      windowCount: uids.length,
      listed: users.length,
      byExtractor,             // {newpipe|backend|unknown: {online5m, online15m, online1h}}
      windowByExtractor,       // seçili pencere içindeki kırılım
      byCountry,
      timeline,
      users,
      updatedAt: new Date(nowMs).toISOString(),
    });
  } catch (e) {
    console.error("[PRESENCE] Listeleme hatası:", e.message);
    res.status(500).json({ error: "Listeleme hatası: " + e.message });
  }
});

// ─── LOAD TEST SAYFASI ────────────────────────────────────────────────────────
app.get("/loadtest", (req, res) => {
  if (req.query.key !== APP_SECRET) return res.status(403).json({ error: "Unauthorized" });
  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Load Test</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:#0d0d0d;color:#e0e0e0;min-height:100vh;padding:24px}
h1{color:#fff;font-size:22px;margin-bottom:20px}
.controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:20px}
input[type=number]{background:#1a1a1a;border:1px solid #333;color:#fff;padding:8px 12px;border-radius:6px;width:90px;font-size:14px}
label{font-size:13px;color:#aaa}
button{padding:10px 24px;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;transition:.2s}
#btnStart{background:#4caf50;color:#fff}
#btnStart:hover{background:#43a047}
#btnStart:disabled{background:#333;color:#666;cursor:not-allowed}
.summary{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:20px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:14px}
.card .val{font-size:22px;font-weight:700;color:#fff}
.card .lbl{font-size:11px;color:#888;margin-top:4px}
.card.ok .val{color:#4caf50}
.card.fail .val{color:#f44336}
table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px}
th{background:#1a1a1a;color:#aaa;font-weight:600;padding:8px 10px;text-align:left;border-bottom:1px solid #2a2a2a}
td{padding:7px 10px;border-bottom:1px solid #1e1e1e}
tr:hover td{background:#161616}
.bar{height:6px;background:#4caf50;border-radius:3px;margin-top:4px}
.bar.fail{background:#f44336}
#log{background:#111;border:1px solid #222;border-radius:8px;padding:12px;height:240px;overflow-y:auto;font-size:12px;font-family:monospace;color:#ccc}
.log-ok{color:#4caf50}
.log-fail{color:#f44336}
.log-info{color:#888}
progress{width:100%;height:6px;margin-bottom:16px;accent-color:#4caf50}
</style>
</head>
<body>
<h1>🚀 Load Test</h1>
<div class="controls">
  <div><label>Kullanıcı sayısı</label><br><input type="number" id="users" value="20" min="1" max="200"></div>
  <div style="padding-top:18px"><button id="btnStart" onclick="startTest()">Başlat</button></div>
</div>
<progress id="prog" value="0" max="100"></progress>
<div class="summary">
  <div class="card"><div class="val" id="sTotal">—</div><div class="lbl">Toplam istek</div></div>
  <div class="card ok"><div class="val" id="sOk">—</div><div class="lbl">Başarılı</div></div>
  <div class="card fail"><div class="val" id="sFail">—</div><div class="lbl">Başarısız</div></div>
  <div class="card"><div class="val" id="sRate">—</div><div class="lbl">Başarı oranı</div></div>
  <div class="card"><div class="val" id="sAvg">—</div><div class="lbl">Ort gecikme</div></div>
  <div class="card"><div class="val" id="sP90">—</div><div class="lbl">P90 gecikme</div></div>
  <div class="card"><div class="val" id="sMax">—</div><div class="lbl">Max gecikme</div></div>
  <div class="card"><div class="val" id="sTime">—</div><div class="lbl">Toplam süre</div></div>
</div>
<table id="tbl">
<thead><tr><th>Endpoint</th><th>OK</th><th>FAIL</th><th>Ort(ms)</th><th>P90(ms)</th><th>Başarı</th></tr></thead>
<tbody id="tbody"></tbody>
</table>
<div id="log"></div>

<script>
const BASE = "";
const APP_SECRET = "RINGTONE_MASTER_V2_SECRET_2026";

const VIDEO_IDS = [
  "dQw4w9WgXcQ","kJQP7kiw5Fk","9bZkp7q19f0","OPf0YbXqDm0","hT_nvWreIhg",
  "YQHsXMglC9A","JGwWNGJdvx8","fRh_vgS2dFE","RgKAFK5djSk","CevxZvSJLk8",
  "M7lc1UVf-VE","WA4iX5D9Z9c","60ItHLz5WEA","nfWlot6h_JM","4NRXx6pxIVE",
  "tVj0ZTS4WF4","e-ORhEE9VVg","n8X9_MgEdCg","ZbZSe6N_BXs","lp-EBohGJDA",
];
const SEARCH_TERMS = ["eminem","taylor swift","dua lipa","weeknd","billie eilish","ed sheeran","türkçe pop","rap","slow şarkılar","2024 hits"];
const USER_TYPES = [
  {type:"listener",w:30},{type:"searcher",w:20},{type:"mp3_dl",w:15},
  {type:"mp4_dl",w:10},{type:"video_watch",w:15},{type:"mixed",w:10}
];

function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function pickType(){
  const tot=USER_TYPES.reduce((s,t)=>s+t.w,0);
  let r=Math.random()*tot;
  for(const t of USER_TYPES){r-=t.w;if(r<=0)return t.type;}
  return "listener";
}

async function hmacSign(path){
  const ts = Date.now().toString();
  const payload = ts + ":" + path;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return {"X-Timestamp":ts,"X-Signature":b64,"X-Country":"TR"};
}

const epStats = {};
const allLatencies = [];
let done = 0, totalReqs = 0;

function getEp(path){
  if(path.startsWith("/stream/video")) return "stream/video";
  if(path.startsWith("/stream")) return "stream/audio";
  if(path.startsWith("/download/mp3")) return "download/mp3";
  if(path.startsWith("/download/mp4")) return "download/mp4";
  if(path.startsWith("/search")) return "search";
  if(path.startsWith("/autocomplete")) return "autocomplete";
  if(path.startsWith("/top50")) return "top50";
  return path;
}

async function doReq(path){
  const ep = getEp(path);
  if(!epStats[ep]) epStats[ep]={ok:0,fail:0,lat:[]};
  const headers = await hmacSign(path.split("?")[0]);
  const t0 = performance.now();
  try{
    const r = await fetch(BASE+path, {headers, signal:AbortSignal.timeout(20000)});
    const ms = Math.round(performance.now()-t0);
    allLatencies.push(ms);
    epStats[ep].lat.push(ms);
    if(r.ok||r.status===302||r.status===301){
      epStats[ep].ok++;
      log(\`<span class="log-ok">✅ \${ep} \${r.status} \${ms}ms</span>\`);
    } else {
      epStats[ep].fail++;
      log(\`<span class="log-fail">❌ \${ep} \${r.status} \${ms}ms</span>\`);
    }
  } catch(e){
    const ms=Math.round(performance.now()-t0);
    allLatencies.push(ms);
    epStats[ep].lat.push(ms);
    epStats[ep].fail++;
    log(\`<span class="log-fail">❌ \${ep} ERR \${ms}ms \${e.message}</span>\`);
  }
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function simulateUser(id){
  const type = pickType();
  await sleep(Math.random()*1500);
  const vid = pick(VIDEO_IDS);
  const q = encodeURIComponent(pick(SEARCH_TERMS));

  if(type==="listener"){
    await doReq(\`/stream?videoId=\${pick(VIDEO_IDS)}&type=audio\`);
    await sleep(300); await doReq(\`/stream?videoId=\${pick(VIDEO_IDS)}&type=audio\`);
    await sleep(300); await doReq(\`/stream?videoId=\${pick(VIDEO_IDS)}&type=audio\`);
  } else if(type==="searcher"){
    await doReq(\`/autocomplete?q=\${q}\`);
    await sleep(200); await doReq(\`/search?q=\${q}\`);
    await sleep(300); await doReq(\`/stream?videoId=\${vid}&type=audio\`);
    await sleep(300); await doReq(\`/search?q=\${encodeURIComponent(pick(SEARCH_TERMS))}\`);
    await sleep(300); await doReq(\`/stream?videoId=\${pick(VIDEO_IDS)}&type=audio\`);
  } else if(type==="mp3_dl"){
    await doReq(\`/search?q=\${q}\`);
    await sleep(400); await doReq(\`/download/mp3?videoId=\${vid}\`);
    await sleep(500); await doReq(\`/download/mp3?videoId=\${pick(VIDEO_IDS)}\`);
  } else if(type==="mp4_dl"){
    await doReq(\`/search?q=\${q}\`);
    await sleep(400); await doReq(\`/download/mp4?videoId=\${vid}\`);
  } else if(type==="video_watch"){
    await doReq(\`/search?q=\${q}\`);
    await sleep(400); await doReq(\`/stream/video?videoId=\${vid}\`);
    await sleep(500); await doReq(\`/stream/video?videoId=\${pick(VIDEO_IDS)}\`);
  } else {
    await doReq(\`/top50\`);
    await sleep(200); await doReq(\`/search?q=\${q}\`);
    await sleep(300); await doReq(\`/stream?videoId=\${vid}&type=audio\`);
    await sleep(300); await doReq(\`/download/mp3?videoId=\${vid}\`);
    await sleep(400); await doReq(\`/stream/video?videoId=\${pick(VIDEO_IDS)}\`);
    await sleep(200); await doReq(\`/autocomplete?q=\${q}\`);
  }

  done++;
  document.getElementById("prog").value = Math.round((done/totalUsers)*100);
  updateSummary();
  updateTable();
}

let totalUsers = 0;

function pct(arr,p){
  if(!arr.length)return 0;
  const s=[...arr].sort((a,b)=>a-b);
  return s[Math.max(0,Math.ceil(p/100*s.length)-1)];
}
function avg(arr){ return arr.length?Math.round(arr.reduce((a,b)=>a+b,0)/arr.length):0; }

function updateSummary(){
  const ok=Object.values(epStats).reduce((s,e)=>s+e.ok,0);
  const fail=Object.values(epStats).reduce((s,e)=>s+e.fail,0);
  const tot=ok+fail;
  document.getElementById("sTotal").textContent=tot;
  document.getElementById("sOk").textContent=ok;
  document.getElementById("sFail").textContent=fail;
  document.getElementById("sRate").textContent=tot?Math.round(ok/tot*100)+"%":"—";
  document.getElementById("sAvg").textContent=allLatencies.length?avg(allLatencies)+"ms":"—";
  document.getElementById("sP90").textContent=allLatencies.length?pct(allLatencies,90)+"ms":"—";
  document.getElementById("sMax").textContent=allLatencies.length?Math.max(...allLatencies)+"ms":"—";
}

function updateTable(){
  const tbody=document.getElementById("tbody");
  tbody.innerHTML="";
  for(const [ep,s] of Object.entries(epStats)){
    const tot=s.ok+s.fail;
    const rate=tot?Math.round(s.ok/tot*100):0;
    tbody.innerHTML+=\`<tr>
      <td>\${ep}</td>
      <td style="color:#4caf50">\${s.ok}</td>
      <td style="color:#f44336">\${s.fail}</td>
      <td>\${avg(s.lat)}ms</td>
      <td>\${pct(s.lat,90)}ms</td>
      <td><div style="font-size:12px">\${rate}%</div><div class="bar \${rate<50?"fail":""}" style="width:\${rate}%"></div></td>
    </tr>\`;
  }
}

function log(msg){
  const el=document.getElementById("log");
  el.innerHTML+=msg+"<br>";
  el.scrollTop=el.scrollHeight;
}

let running=false;
let t0global;

async function startTest(){
  if(running)return;
  running=true;
  const btn=document.getElementById("btnStart");
  btn.disabled=true;
  btn.textContent="Çalışıyor...";
  Object.keys(epStats).forEach(k=>delete epStats[k]);
  allLatencies.length=0;
  done=0;
  document.getElementById("log").innerHTML="";
  document.getElementById("prog").value=0;
  totalUsers=parseInt(document.getElementById("users").value)||20;
  t0global=performance.now();

  log(\`<span class="log-info">🚀 Test başlıyor — \${totalUsers} kullanıcı</span>\`);

  await Promise.all(Array.from({length:totalUsers},(_,i)=>simulateUser(i+1)));

  const elapsed=((performance.now()-t0global)/1000).toFixed(1);
  document.getElementById("sTime").textContent=elapsed+"s";
  log(\`<span class="log-info">✅ Test tamamlandı — \${elapsed}s</span>\`);
  btn.disabled=false;
  btn.textContent="Tekrar Başlat";
  running=false;
}
</script>
</body>
</html>`);
});

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

// MP3 İndirme — Yeni API Provider sistemi (mp3download.php)
app.get("/download/mp3", async (req, res) => {
  try {
    const { videoId, kbps } = req.query;

    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: "Invalid or missing videoId" });
    }

    const quality = ["128", "192", "320"].includes(kbps) ? kbps : "320";

    /* KATMAN 0 — HAZIR CACHE (indirme de çalma gibi ÖNCE cache'e baksın).
       ÖNCEDEN: /download/mp3 doğrudan bazocam'a gidiyor, diskteki/R2'deki hazır
       dosyayı YOK SAYIYORDU. Sonuç: bir şarkı çalınınca /stream onu diske+R2'ye
       kaydediyor ama İNDİRMEK istenince bazocam'dan yeniden isteniyordu — bazocam
       o an takılırsa "çalıyor ama inmiyor" oluyordu. Artık indirme de önce cache'e
       bakar; bulursa anında verir, bazocam'a HİÇ gitmez. */
    const dlTitle = (req.query.title || `audio_${videoId}`)
      .replace(/[^\w\s\-\.]/g, "").trim().substring(0, 100) || `audio_${videoId}`;

    // 0a) Disk cache (/stream'in smart-cache yazdığı dosya)
    const dlDiskFile = path.join(CACHE_DIR, `audio_${videoId}.mp3`);
    const dlStat = await statOrNull(dlDiskFile);
    if (dlStat && dlStat.size > 20 * 1024) {
      console.log(`[DOWNLOAD_MP3] Disk cache HIT: ${videoId} (${(dlStat.size/1024/1024).toFixed(2)} MB)`);
      touchCache(dlDiskFile);
      res.setHeader("Content-Disposition", `attachment; filename="${dlTitle}.mp3"`);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", dlStat.size);
      return safePipe(fs.createReadStream(dlDiskFile), res);
    }

    // 0b) R2 (Cloudflare) cache — çalma sırasında yüklenen dosya
    for (const key of [`audio/${videoId}.mp3`, `audio/${videoId}.m4a`]) {
      try {
        const r2 = await getR2Stream(key);
        if (r2 && r2.stream) {
          console.log(`[DOWNLOAD_MP3] R2 cache HIT: ${videoId} (${key})`);
          res.setHeader("Content-Disposition", `attachment; filename="${dlTitle}.mp3"`);
          res.setHeader("Content-Type", r2.contentType || "audio/mpeg");
          if (r2.contentLength) res.setHeader("Content-Length", r2.contentLength);
          return safePipe(r2.stream, res);
        }
      } catch (e) { /* bu anahtar yok — sıradakini dene */ }
    }

    // Aynı şarkı başka bir worker'da zaten çevriliyorsa ikinci zinciri kurma
    // (bazocam'a paralel kopya istek gitmesin — bkz. acquireConvertLock).
    if (!(await acquireConvertLock("mp3", videoId))) {
      console.log(`[DOWNLOAD_MP3] Tek-akış: ${videoId} zaten çevriliyor — bu istek atlandı`);
      if (!res.headersSent) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Retry-After", "20");
        return res.status(503).json({ error: "MP3 hazırlanıyor, lütfen birazdan tekrar deneyin", retryable: true });
      }
      return;
    }

    // ★ BİRİNCİL: Yeni API Provider (mp3download.php)
    try {
      console.log(`[DOWNLOAD_MP3] API Provider ile indiriliyor: ${videoId} (${quality}kbps)`);
      const apiResult = await apiStreamMp3(videoId, parseInt(quality));
      // Dönüşüm başarılı → kilidi HEMEN bırak (çalma/indirme birbirini kilitlemesin).
      releaseConvertLock("mp3", videoId);

      const safeTitle = (req.query.title || `audio_${videoId}`)
        .replace(/[^\w\s\-\.]/g, "").trim().substring(0, 100) || `audio_${videoId}`;

      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp3"`);
      res.setHeader("Content-Type", apiResult.contentType || "audio/mpeg");
      if (apiResult.contentLength) res.setHeader("Content-Length", apiResult.contentLength);

      safePipe(apiResult.stream, res);
      return;
    } catch (apiErr) {
      console.warn(`[DOWNLOAD_MP3] API Provider başarısız: ${apiErr.message}`);
      releaseConvertLock("mp3", videoId); // başarısızlıkta hemen bırak
    }

    // Sabit bazocam converter.php fallback kaldırıldı — indirme tamamen panel'deki
    // provider'lardan gelir. apiStreamMp3 zaten tüm aktif provider'ları sırayla deniyor.

    // Tüm yöntemler başarısız
    console.warn(`[DOWNLOAD_MP3] Tüm API yöntemleri başarısız: ${videoId}`);
    if (!res.headersSent) {
      res.status(503).json({ error: "MP3 indirme şu an kullanılamıyor, lütfen tekrar deneyin" });
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
        touchCache(diskFile); // indirildi → 24sa idle sayacını sıfırla
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

    // ★ KATMAN 2: API PROVIDER (bazocam MP4)
    try {
      console.log(`[DOWNLOAD_MP4] API Provider ile deneniyor: ${videoId}`);
      const apiResult = await apiStreamMp4(videoId, 720);
      if (apiResult && apiResult.stream) {
        console.log(`[DOWNLOAD_MP4] ✅ API Provider'dan indiriliyor: ${videoId}`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename=video_${videoId}.mp4`);
        if (apiResult.contentLength) res.setHeader("Content-Length", apiResult.contentLength);
        safePipe(apiResult.stream, res);
        return;
      }
    } catch (apiErr) {
      console.warn(`[DOWNLOAD_MP4] API Provider başarısız: ${apiErr.message}`);
    }

    // Tüm yöntemler başarısız
    console.warn(`[DOWNLOAD_MP4] Tüm API yöntemleri başarısız: ${videoId}`);
    if (!res.headersSent) {
      res.status(503).json({ error: "MP4 indirme şu an kullanılamıyor, lütfen tekrar deneyin" });
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
app.get("/admin", (req, res) => {
  // KİŞİSEL GİRİŞ: oturum yoksa giriş sayfası
  const sess = verifySession(readCookie(req, "psess"));
  if (!sess) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(loginPageHtml());
  }
  const _esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const apps = getApps();
  const isSuper = (sess.apps === "all" || sess.super);
  // Kullanıcının görebileceği uygulamalar (süper → hepsi, değilse → yetkili olduğu)
  const scopeIds = isSuper
    ? Object.keys(apps).filter(id => id !== "default")
    : (Array.isArray(sess.apps) ? sess.apps.filter(id => apps[id]) : []);
  const appCards = scopeIds.map(id => {
    const a = apps[id];
    return `
    <a class="card" href="/admin/${_esc(id)}/panel" style="border-color:${_esc(a.brandPrimary || "#22c55e")}">
      <div class="icon" style="background:#15271d">📱</div>
      <div class="card-info">
        <h3>${_esc(a.name || id)}</h3>
        <p>${_esc(a.packageName || "")} · Panel</p>
      </div>
    </a>`;
  }).join("");
  // Altyapı kartları — SADECE süper kullanıcılar (beyza/olcay) görür
  const superCards = !isSuper ? "" : `
    <a class="card" href="/cache-panel"><div class="icon" style="background:#1e293b">💾</div><div class="card-info"><h3>Cache Panel</h3><p>Media önbelleği yönetimi</p></div></a>
    <a class="card" href="/proxy-panel"><div class="icon" style="background:#1e2a1e">🔁</div><div class="card-info"><h3>Proxy Panel</h3><p>Proxy havuzu ve ban yönetimi</p></div></a>
    <a class="card" href="/playlist-cache"><div class="icon" style="background:#2a1e1e">🎶</div><div class="card-info"><h3>Playlist Cache</h3><p>Top 50 önbellekleme</p></div></a>
    <a class="card" href="/converter"><div class="icon" style="background:#1e1e2a">🔄</div><div class="card-info"><h3>Converter</h3><p>MP3/MP4 dönüştürücü</p></div></a>
    <a class="card" href="/content-filter"><div class="icon" style="background:#2a1a1a">🎚️</div><div class="card-info"><h3>İçerik Filtresi</h3><p>Canlı yayın engeli & süre limiti</p></div></a>
    <a class="card" href="/admin/stats"><div class="icon" style="background:#2a1e2a">📊</div><div class="card-info"><h3>İstatistikler</h3><p>Sunucu & API durumu</p></div></a>
    <a class="card" href="/health"><div class="icon" style="background:#1e2a24">❤️</div><div class="card-info"><h3>Health Check</h3><p>Sistem sağlık durumu</p></div></a>
    <a class="card" href="/admin/panel" style="border-color:#7c3aed"><div class="icon" style="background:#2d1f4e">🎛️</div><div class="card-info"><h3>React Panel</h3><p>Config, Popup & Kanal Yönetimi (Tümü)</p></div></a>`;
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
  <div style="margin-bottom:32px;color:#94a3b8;font-size:14px">👤 <b style="color:#e2e8f0">${_esc(sess.user)}</b> · <a href="/admin/logout" style="color:#f87171;text-decoration:none">Çıkış Yap</a></div>

  <div class="grid">
    ${superCards}${appCards}
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

// index.html'i appId/appKey enjekte ederek servis et.
// appId="" (süper panel) → dropdown açık, master key; appId dolu → izole/kilitli.
function sendPanelIndex(res, appId, appKey) {
  const indexPath = path.join(REACT_PANEL_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    return res.status(404).send("React panel build bulunamadı. admin_panel/ klasörüne build dosyalarını koyun.");
  }
  let html = fs.readFileSync(indexPath, "utf-8");
  const inject = `<script>window.__APP_ID__=${JSON.stringify(appId || "")};window.__APP_KEY__=${JSON.stringify(appKey || "")};</script>`;
  html = html.includes("</head>") ? html.replace("</head>", inject + "</head>") : inject + html;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
}

// Statik varlıklar (JS/CSS/chunk): master basicAuth VEYA master key VEYA geçerli izole-panel cookie'si.
// Cookie, /admin/<appId>/panel girişinde set edilir → tarayıcı /admin/panel/static isteklerine de yollar.
function panelAssetAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const [u, p] = Buffer.from(authHeader.split(" ")[1], "base64").toString().split(":");
      if (u === "admin" && p === ADMIN_PASS) return next();
    } catch (e) {}
  }
  if (req.headers["x-app-key"] === APP_SECRET) return next();
  if (verifyPanelCookie(readCookie(req, "pnl"))) return next();
  if (verifySession(readCookie(req, "psess"))) return next();   // kişisel giriş oturumu
  res.setHeader("WWW-Authenticate", 'Basic realm="Secure Area"');
  return res.status(401).send("Authentication required");
}

// İzole panel girişi: kullanıcı=<appId>, şifre=perAppPass(appId) (master APP_SECRET'ten türetilir)
function perAppPanelAuth(req, res, next) {
  const appId = String(req.params.appId || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!getApps()[appId] || appId === "default") return res.status(404).send("Bilinmeyen uygulama paneli");
  const realm = appId + " panel";
  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const [u, p] = Buffer.from(authHeader.split(" ")[1], "base64").toString().split(":");
      if (u === appId && p === perAppPass(appId)) { req._panelAppId = appId; return next(); }
    } catch (e) {}
  }
  res.setHeader("WWW-Authenticate", `Basic realm="${realm}"`);
  return res.status(401).send("Giriş gerekli");
}

// --- Statik varlıklar (önce kaydedilir; /admin/panel/* get'ten önce eşleşir) ---
app.use("/admin/panel/static", panelAssetAuth, express.static(path.join(REACT_PANEL_DIR, "static")));

// --- KİŞİSEL GİRİŞ: kullanıcı adı+şifre → oturum cookie'si ---
app.post("/admin/login", express.json(), (req, res) => {
  const { u, p } = req.body || {};
  const sess = verifyPanelUser(u, p);
  if (!sess) return res.status(401).json({ ok: false });
  res.setHeader("Set-Cookie", `psess=${encodeURIComponent(signSession(sess.user))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
  res.json({ ok: true, user: sess.user });
});
app.get("/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "psess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.redirect("/admin/panel");
});

// --- PANEL: oturum yoksa giriş sayfası; varsa kullanıcının yetkisine göre enjekte edilmiş panel ---
function servePanelBySession(req, res, isSpa) {
  const sess = verifySession(readCookie(req, "psess"));
  if (!sess) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(loginPageHtml());
  }
  if (isSpa) {
    const rel = req.params[0] || "";
    const fp = path.join(REACT_PANEL_DIR, rel);
    if (rel && !rel.includes("..") && fs.existsSync(fp) && fs.statSync(fp).isFile()) return res.sendFile(fp);
  }
  const inj = sessionInjection(sess);
  if (!inj) { res.setHeader("Content-Type", "text/html; charset=utf-8"); return res.send(loginPageHtml()); }
  return sendPanelIndex(res, inj.appId, inj.appKey);
}
app.get(["/admin/panel", "/admin/panel/"], (req, res) => servePanelBySession(req, res, false));
app.get("/admin/panel/*", (req, res) => servePanelBySession(req, res, true));

// --- İZOLE PER-APP PANEL — ayrı giriş + kilitli appId + oturum cookie'si ---
function _issuePanelCookie(res, appId) {
  res.setHeader("Set-Cookie", `pnl=${encodeURIComponent(signPanelCookie(appId))}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=43200`);
}
// Per-app panel: önce kişisel oturum (o uygulamaya yetkiliyse), yoksa eski per-app basic auth
function servePerAppPanel(req, res, isSpa) {
  const appId = String(req.params.appId || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!getApps()[appId] || appId === "default") return res.status(404).send("Bilinmeyen uygulama paneli");
  const sess = verifySession(readCookie(req, "psess"));
  let ok = !!(sess && (sess.apps === "all" || sess.super || (Array.isArray(sess.apps) && sess.apps.includes(appId))));
  if (!ok) {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try { const [u, p] = Buffer.from(authHeader.split(" ")[1], "base64").toString().split(":"); if (u === appId && p === perAppPass(appId)) ok = true; } catch (e) {}
    }
    if (!ok) { res.setHeader("WWW-Authenticate", `Basic realm="${appId} panel"`); return res.status(401).send("Giriş gerekli"); }
  }
  if (isSpa) {
    const rel = req.params[0] || "";
    const fp = path.join(REACT_PANEL_DIR, rel);
    if (rel && !rel.includes("..") && fs.existsSync(fp) && fs.statSync(fp).isFile()) return res.sendFile(fp);
  }
  _issuePanelCookie(res, appId);
  return sendPanelIndex(res, appId, perAppKey(appId));
}
app.get(["/admin/:appId/panel", "/admin/:appId/panel/"], (req, res) => servePerAppPanel(req, res, false));
app.get("/admin/:appId/panel/*", (req, res) => servePerAppPanel(req, res, true));

// ==========================================
// ADMIN_PASS ve basicAuth dosyanın başında tanımlı (satır ~15)
const PANEL_TEMPLATE = path.join(__dirname, "proxy_panel.html");

// ===== İÇERİK FİLTRESİ PANELİ (canlı yayın + süre limiti) =====
const CONTENT_FILTER_PANEL = path.join(__dirname, "content_filter_panel.html");

app.get("/content-filter", basicAuth, (req, res) => {
  try {
    res.sendFile(CONTENT_FILTER_PANEL);
  } catch (e) {
    res.status(500).send("İçerik filtresi paneli yüklenemedi: " + e.message);
  }
});

// Panelin okuyacağı mevcut değerler (yalnız contentFilter)
app.get("/content-filter/config", basicAuth, (req, res) => {
  res.json(getContentFilter());
});

// Panelden kaydet — sadece contentFilter alanını günceller, config'in geri kalanına dokunmaz
app.post("/content-filter", express.json(), basicAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const config = { ...getCachedConfig() };
    const cur = config.contentFilter || {};
    const m = Number(body.maxDurationMinutes);
    config.contentFilter = {
      enabled: typeof body.enabled === "boolean" ? body.enabled : (cur.enabled !== false),
      blockLive: typeof body.blockLive === "boolean" ? body.blockLive : (cur.blockLive !== false),
      maxDurationMinutes: Number.isFinite(m) && m > 0 ? Math.round(m) : (Number(cur.maxDurationMinutes) > 0 ? Number(cur.maxDurationMinutes) : 35)
    };
    await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    _cachedConfigByApp = {}; // anında geçerli olsun
    res.json({ message: "İçerik filtresi güncellendi", contentFilter: config.contentFilter });
  } catch (e) {
    res.status(500).json({ error: "Kaydetme başarısız: " + e.message });
  }
});

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

// ---------------- LEGAL PAGES (public — Google Play icin) ----------------
// basicAuth YOK: gizlilik politikasi ve cocuk guvenligi sayfalari herkese acik olmali.
app.get("/privacy-policy.html", (req, res) => {
  res.sendFile(path.join(__dirname, "privacy-policy.html"));
});
app.get("/memo-music-privacy-policy.html", (req, res) => {
  res.sendFile(path.join(__dirname, "memo-music-privacy-policy.html"));
});
app.get("/echoes-music-privacy-policy.html", (req, res) => {
  res.sendFile(path.join(__dirname, "echoes-music-privacy-policy.html"));
});
app.get("/child-safety-standards.html", (req, res) => {
  res.sendFile(path.join(__dirname, "child-safety-standards.html"));
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

  // Sunucu durum bilgileri
  let diskTotal = "?", diskUsed = "?", diskFree = "?", diskPercent = 0;
  let ramTotal = "?", ramUsed = "?", ramFree = "?", ramPercent = 0;
  let redisUsed = "?", redisKeys = "?";
  let audioCacheSize = "?", videoCacheSize = "?", audioCacheCount = 0, videoCacheCount = 0;

  try {
    const dfOut = require("child_process").execSync("df -h / | tail -1").toString().trim();
    const dfParts = dfOut.split(/\s+/);
    diskTotal = dfParts[1]; diskUsed = dfParts[2]; diskFree = dfParts[3]; diskPercent = parseInt(dfParts[4]) || 0;
  } catch (e) {}

  try {
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = memTotal - memFree;
    ramTotal = (memTotal / 1024 / 1024 / 1024).toFixed(1) + " GB";
    ramUsed = (memUsed / 1024 / 1024 / 1024).toFixed(1) + " GB";
    ramFree = (memFree / 1024 / 1024 / 1024).toFixed(1) + " GB";
    ramPercent = Math.round((memUsed / memTotal) * 100);
  } catch (e) {}

  try {
    if (redis) {
      const info = require("child_process").execSync("redis-cli info memory 2>/dev/null | grep used_memory_human").toString().trim();
      redisUsed = info.split(":")[1] || "?";
      const keysInfo = require("child_process").execSync("redis-cli dbsize 2>/dev/null").toString().trim();
      const keysMatch = keysInfo.match(/(\d+)/);
      redisKeys = keysMatch ? keysMatch[1] : "?";
    }
  } catch (e) {}

  try {
    const audioOut = require("child_process").execSync(`du -sh ${CACHE_DIR} 2>/dev/null | cut -f1`).toString().trim();
    audioCacheSize = audioOut || "0";
    audioCacheCount = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".mp3") || f.endsWith(".m4a")).length;
  } catch (e) {}

  try {
    const videoOut = require("child_process").execSync(`du -sh ${VIDEO_CACHE_DIR} 2>/dev/null | cut -f1`).toString().trim();
    videoCacheSize = videoOut || "0";
    videoCacheCount = fs.readdirSync(VIDEO_CACHE_DIR).filter(f => f.endsWith(".mp4")).length;
  } catch (e) {}

  const diskColor = diskPercent > 85 ? "red" : diskPercent > 65 ? "yellow" : "green";
  const ramColor = ramPercent > 85 ? "red" : ramPercent > 65 ? "yellow" : "green";
  html = html.replace("%%DISK_COLOR%%", diskColor);
  html = html.replace("%%RAM_COLOR%%", ramColor);
  html = html.replace("%%DISK_TOTAL%%", diskTotal);
  html = html.replace("%%DISK_USED%%", diskUsed);
  html = html.replace("%%DISK_FREE%%", diskFree);
  html = html.replace("%%DISK_PERCENT%%", diskPercent);
  html = html.replace("%%RAM_TOTAL%%", ramTotal);
  html = html.replace("%%RAM_USED%%", ramUsed);
  html = html.replace("%%RAM_FREE%%", ramFree);
  html = html.replace("%%RAM_PERCENT%%", ramPercent);
  html = html.replace("%%REDIS_USED%%", redisUsed);
  html = html.replace("%%REDIS_KEYS%%", redisKeys);
  html = html.replace("%%AUDIO_CACHE_SIZE%%", audioCacheSize);
  html = html.replace("%%AUDIO_CACHE_COUNT%%", audioCacheCount);
  html = html.replace("%%VIDEO_CACHE_SIZE%%", videoCacheSize);
  html = html.replace("%%VIDEO_CACHE_COUNT%%", videoCacheCount);

  html = html.replace("%%TOTAL_CACHE%%", stats.readyTracks);
  html = html.replace("%%TOTAL_REQUESTS%%", stats.totalProcessed + stats.totalFailed);
  // Gerçek disk boyutunu hesapla (mediaLib yerine)
  let realCacheMB = stats.totalDiskMB;
  try {
    const audioBytes = require("child_process").execSync(`du -sb ${CACHE_DIR} 2>/dev/null | cut -f1`).toString().trim();
    const videoBytes = require("child_process").execSync(`du -sb ${VIDEO_CACHE_DIR} 2>/dev/null | cut -f1`).toString().trim();
    realCacheMB = ((parseInt(audioBytes || 0) + parseInt(videoBytes || 0)) / 1024 / 1024).toFixed(1);
  } catch (e) {}
  html = html.replace("%%CACHE_SIZE%%", realCacheMB);
  html = html.replace("%%TEMP_FILES%%", tempCount);
  html = html.replace(/%%ADMIN_PASS%%/g, "");

  function buildRowHtml(t, idx) {
    const totalSize = (t.fileSize?.m4a || 0) + (t.fileSize?.mp3 || 0) + (t.fileSize?.mp4 || 0);
    const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
    const date = t.processedAt ? new Date(t.processedAt).toLocaleString("tr-TR") : "—";
    const quality = t.files.mp4 ? "MP4" : t.files.mp3 ? "192 kbps" : "128 kbps";
    const reqPct = Math.min(100, (t.accessCount || 0) * 10);
    return `<tr data-requests="${t.accessCount || 0}" data-size="${sizeMB}" data-date="${t.processedAt || ''}">
      <td>${idx + 1}</td>
      <td><div class="track-info"><span class="track-title">${t.title}</span><span class="track-id">${t.videoId}</span></div></td>
      <td><span class="badge-quality">${quality}</span></td>
      <td><div class="request-bar"><div class="request-fill" style="width:${reqPct}%"></div></div><span class="req-count">${t.accessCount || 0}</span></td>
      <td>${sizeMB} MB</td>
      <td>${date}</td>
      <td><button class="btn btn-sm btn-outline-danger" onclick="deleteItem('${t.videoId}')">Sil</button></td>
    </tr>`;
  }

  const audioTracks = tracks.filter(t => (t.category || (t.files.mp4 ? "watching" : "listening")) === "listening");
  const videoTracks = tracks.filter(t => (t.category || (t.files.mp4 ? "watching" : "listening")) === "watching");

  const audioListHtml = audioTracks.map((t, i) => buildRowHtml(t, i)).join("");
  const videoListHtml = videoTracks.map((t, i) => buildRowHtml(t, i)).join("");

  html = html.replace("%%AUDIO_LIST%%", audioListHtml);
  html = html.replace("%%VIDEO_LIST%%", videoListHtml);
  html = html.replace("%%AUDIO_EMPTY%%", audioTracks.length === 0 ? '<div style="padding:30px;text-align:center;color:#8e8e8e">Henüz dinleme cache\'i yok.</div>' : "");
  html = html.replace("%%VIDEO_EMPTY%%", videoTracks.length === 0 ? '<div style="padding:30px;text-align:center;color:#8e8e8e">Henüz izleme cache\'i yok.</div>' : "");

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

function loadAnnouncements(appId = "default") {
  const file = pathFor(appId, "announcements.json");
  try {
    if (!fs.existsSync(file)) { ensureAppData(appId); fs.writeFileSync(file, "[]"); }
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return [];
  }
}

function saveAnnouncements(data, appId = "default") {
  ensureAppData(appId);
  fs.writeFileSync(pathFor(appId, "announcements.json"), JSON.stringify(data, null, 2));
}

// Tüm duyuruları listele (admin)
app.get("/announcements", (req, res) => {
  res.json(loadAnnouncements(resolveAppId(req)));
});

// Aktif duyuruları getir (Android uygulaması için, ülke filtreli)
app.get("/popup/active", (req, res) => {
  // Ülke tespiti: Cloudflare header > Android X-Country header > query param (kodun geri kalanıyla tutarlı)
  const country = (req.headers["cf-ipcountry"] || req.headers["x-country"] || req.query.country || "").toUpperCase();
  const now = new Date();
  const all = loadAnnouncements(resolveAppId(req));
  const active = all.filter(ann => {
    const start = ann.startTime ? new Date(ann.startTime) : null;
    const end = ann.endTime ? new Date(ann.endTime) : null;
    if (start && now < start) return false;
    if (end && now > end) return false;
    if (ann.countries === "all") return true;
    // Ülke hedeflemesi olan duyuru: ülke eşleşmiyorsa VEYA ülke bilinmiyorsa gösterme (fail-closed).
    // Eskiden ülke boşsa "return true" ile herkese gidiyordu — hedefleme çalışmıyordu.
    if (Array.isArray(ann.countries)) return !!country && ann.countries.includes(country);
    return true;
  });
  // type alanı sonradan eklendi — eski kayıtlarda yok, istemci hep dolu görsün
  res.json(active.map(ann => ({ ...ann, type: ann.type === "review" ? "review" : "vote" })));
});

// Yeni duyuru oluştur (admin)
app.post("/popup/create", express.json(), (req, res) => {
  const { title, message, buttons, countries, startTime, endTime, minLaunches, type } = req.body;
  if (!title || !message) return res.status(400).json({ error: "title ve message zorunlu" });
  // type: "vote" = yıldız oylaması (eski davranış) | "review" = tek butonlu değerlendirme daveti.
  // review'da yıldıza göre ayrım yapılmaz, Google kartı herkese açılır (Play politikasına uygun).
  const popupType = type === "review" ? "review" : "vote";
  if (!Array.isArray(buttons) || buttons.length === 0) return res.status(400).json({ error: "en az bir buton gerekli" });

  const appId = resolveAppId(req);
  const all = loadAnnouncements(appId);
  const newAnn = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: popupType,
    title,
    message,
    buttons,
    countries: countries || "all",
    startTime: startTime || null,
    endTime: endTime || null,
    minLaunches: Number(minLaunches) || 0,
    createdAt: new Date().toISOString(),
    votes: {}
  };
  all.unshift(newAnn);
  saveAnnouncements(all, appId);
  res.json({ id: newAnn.id, ok: true });
});

// Duyuruyu sil (admin)
app.delete("/popup/:id", (req, res) => {
  const appId = resolveAppId(req);
  const all = loadAnnouncements(appId);
  const filtered = all.filter(a => a.id !== req.params.id);
  if (filtered.length === all.length) return res.status(404).json({ error: "Bulunamadı" });
  saveAnnouncements(filtered, appId);
  res.json({ ok: true });
});

// Oy gönder (Android uygulaması)
app.post("/popup/vote", express.json(), (req, res) => {
  const { announcementId, buttonValue } = req.body;
  if (!announcementId || !buttonValue) return res.status(400).json({ error: "announcementId ve buttonValue zorunlu" });

  const appId = resolveAppId(req);
  const all = loadAnnouncements(appId);
  const ann = all.find(a => a.id === announcementId);
  if (!ann) return res.status(404).json({ error: "Duyuru bulunamadı" });

  if (!ann.votes) ann.votes = {};
  ann.votes[buttonValue] = (ann.votes[buttonValue] || 0) + 1;
  saveAnnouncements(all, appId);
  res.json({ ok: true, votes: ann.votes });
});

/* =========================
   DEVICE ACTIONS (Cihaz Komutları)
   Admin panelden Android cihazlara komut gönderme
========================= */
const DEVICE_ACTIONS_FILE = path.join(__dirname, "device_actions.json");

function loadDeviceActions(appId = "default") {
  const file = pathFor(appId, "device_actions.json");
  try {
    if (!fs.existsSync(file)) { ensureAppData(appId); fs.writeFileSync(file, "[]"); }
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return [];
  }
}

function saveDeviceActions(data, appId = "default") {
  ensureAppData(appId);
  fs.writeFileSync(pathFor(appId, "device_actions.json"), JSON.stringify(data, null, 2));
}

// Tüm device action'ları listele (admin)
app.get("/device-actions", (req, res) => {
  res.json(loadDeviceActions(resolveAppId(req)));
});

// Aktif device action'ı getir (Android uygulaması polling)
app.get("/device-action/active", (req, res) => {
  const all = loadDeviceActions(resolveAppId(req));
  const now = new Date();

  // Cihaz bilgisi: ülke (Cloudflare > Android header) + uygulama sürümü + app modu
  const country = (req.headers["cf-ipcountry"] || req.headers["x-country"] || "").toUpperCase();
  const appVersion = parseInt(req.headers["x-app-version"]) || 0;
  // app modu: "youtube" | "ringtone". Eski istemciler header göndermez → "youtube".
  const appMode = (req.headers["x-app-mode"] || "youtube").toLowerCase();

  const active = all.find(a => {
    if (!a.active) return false;
    if (a.expiresAt && new Date(a.expiresAt) < now) return false;

    // App modu filtresi — alan yoksa eski action "youtube" kabul edilir (izolasyon).
    const aMode = (a.appMode || "youtube").toLowerCase();
    if (aMode !== "both" && aMode !== appMode) return false;

    // Ülke filtresi
    const list = Array.isArray(a.countries) ? a.countries : [];
    if (a.countryMode === "include" && list.length && !list.includes(country)) return false;
    if (a.countryMode === "exclude" && list.length && list.includes(country)) return false;

    // Sürüm filtresi (0 = sınırsız). appVersion bilinmiyorsa (0) filtreyi atla.
    if (appVersion > 0) {
      if (a.minVersion && appVersion < a.minVersion) return false;
      if (a.maxVersion && appVersion > a.maxVersion) return false;
    }

    return true;
  });
  res.json(active || null);
});

// Yeni device action oluştur (admin)
app.post("/device-action/create", express.json(), (req, res) => {
  const {
    actionType, mode, value, label, showOnce,
    confirmText, cancelText,        // popup buton yazıları
    countries, countryMode,        // ülke hedefleme
    forceAction,                   // iptal edilemez (zorunlu)
    minVersion, maxVersion,        // sürüm aralığı (versionCode)
    appMode: bodyAppMode           // "youtube" | "ringtone" | "both" — hangi uygulama modu
  } = req.body;
  // Geçerli app modu (varsayılan: youtube — mevcut davranış korunur)
  const appMode = ["youtube", "ringtone", "both"].includes(bodyAppMode) ? bodyAppMode : "youtube";
  // actionType: "chrome_url" | "package_name" | "review_sheet"
  // mode: "direct" | "popup"
  // value: URL veya paket adı
  // label: popup başlık metni (opsiyonel)
  // confirmText/cancelText: popup buton yazıları (opsiyonel)
  // countries: ["TR","DE"] | countryMode: "all" | "include" | "exclude"
  // forceAction: true ise popup iptal edilemez (geri tuşu + iptal yok)
  // minVersion/maxVersion: sadece bu versionCode aralığına göster (0/boş = sınırsız)
  // showOnce: true = cihaz başına 1 kere | false = her uygulama açılışında göster
  if (!actionType || !mode) return res.status(400).json({ error: "actionType ve mode zorunlu" });
  if (actionType !== "review_sheet" && !value) return res.status(400).json({ error: "value zorunlu" });

  const targetAppId = resolveAppId(req);
  const all = loadDeviceActions(targetAppId);
  // Önceki aktif action'ı deaktif et — SADECE aynı app modundakileri (modlar izole).
  all.forEach(a => { if ((a.appMode || "youtube") === appMode) a.active = false; });

  const newAction = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    actionType,
    mode,
    appMode,
    value: actionType === "review_sheet" ? "market://details?id=com.ringtone.master" : value,
    label: label || null,
    confirmText: (confirmText && confirmText.trim()) || null,
    cancelText: (cancelText && cancelText.trim()) || null,
    countries: Array.isArray(countries) ? countries.map(c => c.toUpperCase()) : [],
    countryMode: countryMode || "all",
    forceAction: forceAction === true,
    minVersion: parseInt(minVersion) || 0,
    maxVersion: parseInt(maxVersion) || 0,
    showOnce: showOnce !== false, // varsayılan: tek seferlik
    active: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 saat geçerli
    createdAt: new Date().toISOString(),
    executedCount: 0
  };
  all.unshift(newAction);
  saveDeviceActions(all, targetAppId);
  res.json({ id: newAction.id, ok: true });
});

// Device action'ı sil (admin)
app.delete("/device-action/:id", (req, res) => {
  const appId = resolveAppId(req);
  const all = loadDeviceActions(appId);
  const filtered = all.filter(a => a.id !== req.params.id);
  if (filtered.length === all.length) return res.status(404).json({ error: "Bulunamadı" });
  saveDeviceActions(filtered, appId);
  res.json({ ok: true });
});

// Device action deaktif et (admin)
app.post("/device-action/:id/deactivate", (req, res) => {
  const appId = resolveAppId(req);
  const all = loadDeviceActions(appId);
  const action = all.find(a => a.id === req.params.id);
  if (!action) return res.status(404).json({ error: "Bulunamadı" });
  action.active = false;
  saveDeviceActions(all, appId);
  res.json({ ok: true });
});

// Device action executed bildir (Android)
app.post("/device-action/executed", express.json(), (req, res) => {
  const { actionId } = req.body;
  if (!actionId) return res.status(400).json({ error: "actionId zorunlu" });
  const appId = resolveAppId(req);
  const all = loadDeviceActions(appId);
  const action = all.find(a => a.id === actionId);
  if (!action) return res.status(404).json({ error: "Bulunamadı" });
  action.executedCount = (action.executedCount || 0) + 1;
  saveDeviceActions(all, appId);
  res.json({ ok: true, executedCount: action.executedCount });
});
