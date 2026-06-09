/**
 * ═══════════════════════════════════════════════════════════════
 *  MELODIA — yt-dlp RESOLVE WORKER
 *
 *  Bu dosya Express API'den AYRI çalışır.
 *  Redis Bull Queue'dan iş alır, yt-dlp ile çözümler, sonucu Redis'e yazar.
 *
 *  Aynı sunucuda birden fazla çalıştırılabilir:
 *    pm2 start resolve_worker.js -i 4 --name "resolver"
 *
 *  Başka sunucuda da çalıştırılabilir:
 *    REDIS_URL=redis://ana-sunucu:6379 pm2 start resolve_worker.js -i 8
 *
 *  Ölçekleme:
 *    Sunucu 1: 4 worker = ~40 eşzamanlı
 *    Sunucu 2: 4 worker = ~40 eşzamanlı
 *    Sunucu 3: 4 worker = ~40 eşzamanlı
 *    Toplam:   120+ eşzamanlı çözümleme
 * ═══════════════════════════════════════════════════════════════
 */

require("dotenv").config();
const Queue = require("bull");
const Redis = require("ioredis");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// ==================== CONFIG ====================
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "6"); // Bu worker kaç iş paralel alsın
const RESOLVE_TIMEOUT = 30000; // 30sn — tek bir çözümleme max süresi
const JOB_TIMEOUT = 45000; // 45sn — Bull job timeout (resolve + overhead)

const WORKER_ID = `worker-${process.pid}-${Date.now().toString(36)}`;

// ==================== REDIS ====================
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 1000, 5000)
});

redis.on("connect", () => console.log(`[${WORKER_ID}] ✅ Redis bağlı`));
redis.on("error", (err) => console.error(`[${WORKER_ID}] ❌ Redis hatası:`, err.message));

// ==================== PROXY & COOKIE ====================
// Proxy havuzu (ana sunucudan paylaşılan dosyadan veya env'den)
const PROXY_DATA_FILE = path.join(__dirname, "proxy_data.json");
let proxyPool = [];

function loadProxies() {
  try {
    if (fs.existsSync(PROXY_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROXY_DATA_FILE, "utf-8"));
      proxyPool = (data.active || []).map(p => p.ip).filter(Boolean);
      console.log(`[${WORKER_ID}] 🔄 ${proxyPool.length} proxy yüklendi`);
    }
  } catch (e) { console.warn("Proxy yükleme hatası:", e.message); }
}
loadProxies();
setInterval(loadProxies, 60000); // Her dakika güncelle

function getRandomProxy() {
  if (proxyPool.length === 0) return null;
  return proxyPool[Math.floor(Math.random() * proxyPool.length)];
}

// User Agent havuzu
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1"
];
function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ==================== yt-dlp ÇÖZÜMLEME ====================
const YT_DLP_BIN = fs.existsSync("/usr/local/bin/yt-dlp") ? "/usr/local/bin/yt-dlp" :
  fs.existsSync("/app/node_modules/yt-dlp-exec/bin/yt-dlp") ? "/app/node_modules/yt-dlp-exec/bin/yt-dlp" : "yt-dlp";

function resolveUrl(videoId, type, ua) {
  return new Promise((resolve, reject) => {
    const format = type === "audio" ? "bestaudio" : "best[ext=mp4][protocol^=http]/best[ext=mp4]/best";
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    const args = [
      url,
      "-f", format,
      "--get-url",
      "--no-playlist",
      "--quiet", "--no-warnings",
      "--add-header", "referer:https://www.youtube.com/",
      "--add-header", `user-agent:${ua}`,
      "--extractor-args", "youtube:player_client=android_vr" // Cookie'siz çalışır
    ];

    // Proxy
    const proxy = getRandomProxy();
    if (proxy) args.push("--proxy", proxy);

    const proc = execFile(YT_DLP_BIN, args, {
      timeout: RESOLVE_TIMEOUT,
      env: { ...process.env, PATH: '/usr/local/bin:' + (process.env.PATH || '') }
    }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(`yt-dlp fail: ${stderr || error.message}`));
      }
      const result = stdout.toString().trim();
      if (result && result.startsWith("http")) {
        return resolve(result);
      }
      reject(new Error("yt-dlp: geçersiz URL döndü"));
    });
  });
}

// ==================== BULL QUEUE ====================
const resolveQueue = new Queue("resolve-stream", REDIS_URL, {
  defaultJobOptions: {
    timeout: JOB_TIMEOUT,
    removeOnComplete: 100, // Son 100 başarılı job'ı tut
    removeOnFail: 50,      // Son 50 başarısız job'ı tut
    attempts: 2,           // 1 kez daha dene
    backoff: { type: "fixed", delay: 2000 } // 2sn bekleyip tekrar dene
  }
});

// İstatistikler
let stats = { success: 0, fail: 0, totalTime: 0, started: Date.now() };

setInterval(() => {
  const uptime = ((Date.now() - stats.started) / 1000 / 60).toFixed(0);
  const avgTime = stats.success > 0 ? (stats.totalTime / stats.success / 1000).toFixed(1) : 0;
  console.log(`[${WORKER_ID}] 📊 ${uptime}dk | ✅ ${stats.success} | ❌ ${stats.fail} | Ort: ${avgTime}s`);
}, 60000);

// ==================== JOB İŞLEME ====================
resolveQueue.process(WORKER_CONCURRENCY, async (job) => {
  const { videoId, type, priority } = job.data;
  const startTime = Date.now();
  const ua = getRandomUA();

  console.log(`[${WORKER_ID}] 🎵 İşleniyor: ${videoId} (${type}) [p:${priority || 0}]`);

  try {
    // 1. Önce Redis cache kontrol (başka worker çözmüş olabilir)
    const cacheKey = `stream:${type}:${videoId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached);
      if (data && data.url) {
        console.log(`[${WORKER_ID}] ⚡ Cache hit: ${videoId} (${Date.now() - startTime}ms)`);
        stats.success++;
        return { url: data.url, ua: data.ua, source: "cache", time: Date.now() - startTime };
      }
    }

    // 2. yt-dlp ile çözümle
    const streamUrl = await resolveUrl(videoId, type, ua);

    // 3. Sonucu Redis'e yaz (5.5 saat TTL)
    const TTL = 5.5 * 60 * 60; // 19800 saniye
    await redis.set(cacheKey, JSON.stringify({ url: streamUrl, ua }), "EX", TTL);

    const elapsed = Date.now() - startTime;
    stats.success++;
    stats.totalTime += elapsed;

    console.log(`[${WORKER_ID}] ✅ Çözüldü: ${videoId} (${(elapsed / 1000).toFixed(1)}s)`);
    return { url: streamUrl, ua, source: "yt-dlp", time: elapsed };

  } catch (err) {
    stats.fail++;
    const elapsed = Date.now() - startTime;
    console.warn(`[${WORKER_ID}] ❌ Başarısız: ${videoId} (${(elapsed / 1000).toFixed(1)}s) — ${err.message}`);
    throw err; // Bull otomatik retry yapar
  }
});

// ==================== GRACEFUL SHUTDOWN ====================
async function shutdown() {
  console.log(`[${WORKER_ID}] 🛑 Kapatılıyor...`);
  await resolveQueue.close();
  await redis.quit();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`
═══════════════════════════════════════════════════
  🎵 MELODIA Resolve Worker Başlatıldı
  ID:          ${WORKER_ID}
  Concurrency: ${WORKER_CONCURRENCY} paralel iş
  Redis:       ${REDIS_URL}
  yt-dlp:      ${YT_DLP_BIN}
  Proxy:       ${proxyPool.length} adet
═══════════════════════════════════════════════════
`);
