/**
 * 🔥 MELODIA BACKEND YÜK TESTİ — 50 Sanal Kullanıcı
 *
 * Kullanım: node load_test.js
 *
 * Her kullanıcı rastgele:
 *   - Şarkı arar (search)
 *   - Top50 çeker
 *   - Audio stream açar
 *   - Video stream açar
 *   - MP3 indirir
 *   - Config çeker
 */

const BASE_URL = "https://music.cevapla.tv";
const TOTAL_USERS = 50;
const APP_SECRET = "RINGTONE_MASTER_V2_SECRET_2026";
const crypto = require("crypto");

// Popüler video ID'leri (farklı şarkılar — cache'e düşmesin diye çeşitli)
const VIDEO_IDS = [
  "dQw4w9WgXcQ", "kJQP7kiw5Fk", "JGwWNGJdvx8", "RgKAFK5djSk", "OPf0YbXqDm0",
  "9bZkp7q19f0", "hT_nvWreIhg", "fJ9rUzIMcZQ", "60ItHLz5WEA", "YQHsXMglC9A",
  "CevxZvSJLk8", "bo_efYhYU2A", "SlPhMPnQ58k", "e-ORhEE9VVg", "lp-EO5I60KA",
  "HP-MbfHFUqs", "pRpeEdMmmQ0", "DyDfgMOUjCI", "3tmd-ClpJxA", "kXYiU_JCYtU",
  "2Vv-BfVoq4g", "Zi_XLOBDo_Y", "PT2_F-1esPk", "hLQl3WQQoQ0", "nfs8NYg7yQM",
  "JRfuAukYTKg", "YR5ApYxkU-U", "VYOjWnS4cMY", "QcIy9NiNbmo", "L_jWHffIx5E",
  "ru0K8uYEZWw", "0yW7w8F2TVA", "WA4iX5D9Z64", "NUVCQXMUVnI", "B6_iQvaIjXw",
  "QYh6mYIJG2Y", "LHCob76kigA", "XqZsoesa55w", "oRdxUFDoQe0", "EgBJmlPo8Xw",
  "iPUmE-tne5U", "v4xZUr0BNPs", "PIh2xe4jnpk", "N_qFfQ4qqIE", "lWA2pjMjpBs",
  "aoId_vMsBCQ", "7PCkvCPvDXk", "ebXbLfLACGM", "gCYcHz2k5x0", "VbfpW0pbvaU"
];

const SEARCH_QUERIES = [
  "blok3", "tarkan", "müslüm gürses", "sezen aksu", "eminem",
  "drake", "the weeknd", "billie eilish", "dua lipa", "ed sheeran",
  "adele", "bruno mars", "ariana grande", "taylor swift", "bad bunny",
  "bts", "blackpink", "imagine dragons", "coldplay", "rihanna",
  "post malone", "travis scott", "kendrick lamar", "juice wrld", "xxxtentacion"
];

// Auth header oluştur
function getAuthHeaders(path) {
  const timestamp = Date.now().toString();
  const payload = timestamp + ":" + path;
  const signature = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64");
  return {
    "x-timestamp": timestamp,
    "x-signature": signature
  };
}

// ========== STATS ==========
const stats = {
  total: 0,
  success: 0,
  failed: 0,
  timeout: 0,
  byType: {},
  responseTimes: [],
  startTime: Date.now()
};

function recordResult(type, ok, time, detail) {
  stats.total++;
  if (ok) stats.success++; else stats.failed++;
  stats.responseTimes.push(time);
  if (!stats.byType[type]) stats.byType[type] = { success: 0, failed: 0, times: [] };
  stats.byType[type][ok ? "success" : "failed"]++;
  stats.byType[type].times.push(time);

  const icon = ok ? "✅" : "❌";
  const timeStr = time < 1000 ? `${time}ms` : `${(time/1000).toFixed(1)}s`;
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);
  console.log(`[${elapsed}s] ${icon} ${type.padEnd(14)} ${timeStr.padStart(8)} | ✅${stats.success} ❌${stats.failed} ⏳${TOTAL_USERS * 4 - stats.total} | ${detail || ""}`);
}

// ========== İSTEK FONKSİYONLARI ==========

async function doSearch(userId) {
  const q = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
  const path = "/search";
  const start = Date.now();
  try {
    const resp = await fetch(`${BASE_URL}${path}?q=${encodeURIComponent(q)}`, {
      headers: getAuthHeaders(path),
      signal: AbortSignal.timeout(30000)
    });
    const ok = resp.ok;
    recordResult("SEARCH", ok, Date.now() - start, `q="${q}" → ${resp.status}`);
  } catch (e) {
    stats.timeout++;
    recordResult("SEARCH", false, Date.now() - start, `q="${q}" → ${e.message}`);
  }
}

async function doTop50(userId) {
  const path = "/top50";
  const start = Date.now();
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      headers: { ...getAuthHeaders(path), "x-country": ["TR","US","DE","FR","JP"][Math.floor(Math.random()*5)] },
      signal: AbortSignal.timeout(30000)
    });
    recordResult("TOP50", resp.ok, Date.now() - start, `→ ${resp.status}`);
  } catch (e) {
    stats.timeout++;
    recordResult("TOP50", false, Date.now() - start, e.message);
  }
}

async function doAudioStream(userId) {
  const videoId = VIDEO_IDS[Math.floor(Math.random() * VIDEO_IDS.length)];
  const path = "/stream";
  const start = Date.now();
  try {
    const resp = await fetch(`${BASE_URL}${path}?videoId=${videoId}`, {
      headers: getAuthHeaders(path),
      signal: AbortSignal.timeout(60000)
    });
    // Sadece ilk chunk'ı oku, tamamını indirme
    if (resp.ok && resp.body) {
      const reader = resp.body.getReader();
      const { value } = await reader.read();
      reader.cancel();
      const kb = value ? (value.length / 1024).toFixed(0) : 0;
      recordResult("AUDIO_STREAM", true, Date.now() - start, `${videoId} → ${kb}KB chunk`);
    } else {
      recordResult("AUDIO_STREAM", false, Date.now() - start, `${videoId} → ${resp.status}`);
    }
  } catch (e) {
    stats.timeout++;
    recordResult("AUDIO_STREAM", false, Date.now() - start, `${videoId} → ${e.message}`);
  }
}

async function doVideoStream(userId) {
  const videoId = VIDEO_IDS[Math.floor(Math.random() * VIDEO_IDS.length)];
  const path = "/stream/video";
  const start = Date.now();
  try {
    const resp = await fetch(`${BASE_URL}${path}?videoId=${videoId}`, {
      headers: getAuthHeaders(path),
      signal: AbortSignal.timeout(60000)
    });
    if (resp.ok && resp.body) {
      const reader = resp.body.getReader();
      const { value } = await reader.read();
      reader.cancel();
      const kb = value ? (value.length / 1024).toFixed(0) : 0;
      recordResult("VIDEO_STREAM", true, Date.now() - start, `${videoId} → ${kb}KB chunk`);
    } else {
      recordResult("VIDEO_STREAM", false, Date.now() - start, `${videoId} → ${resp.status}`);
    }
  } catch (e) {
    stats.timeout++;
    recordResult("VIDEO_STREAM", false, Date.now() - start, `${videoId} → ${e.message}`);
  }
}

// ========== KULLANICI SİMÜLASYONU ==========

async function simulateUser(userId) {
  // Her kullanıcı 4 rastgele aksiyon yapar
  const actions = [doSearch, doTop50, doAudioStream, doVideoStream];

  // Rastgele sırala
  const shuffled = actions.sort(() => Math.random() - 0.5);

  for (const action of shuffled) {
    await action(userId);
    // Gerçekçi bekleme: 500ms - 2s arası
    await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
  }
}

// ========== SONUÇ RAPORU ==========

function printReport() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const avgTime = stats.responseTimes.length > 0
    ? (stats.responseTimes.reduce((a,b) => a+b, 0) / stats.responseTimes.length).toFixed(0)
    : 0;
  const maxTime = stats.responseTimes.length > 0 ? Math.max(...stats.responseTimes) : 0;
  const minTime = stats.responseTimes.length > 0 ? Math.min(...stats.responseTimes) : 0;
  const successRate = stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : 0;

  console.log("\n" + "=".repeat(70));
  console.log("📊 YÜK TESTİ RAPORU");
  console.log("=".repeat(70));
  console.log(`⏱️  Toplam süre:     ${elapsed}s`);
  console.log(`👥 Kullanıcı sayısı: ${TOTAL_USERS}`);
  console.log(`📨 Toplam istek:     ${stats.total}`);
  console.log(`✅ Başarılı:         ${stats.success} (${successRate}%)`);
  console.log(`❌ Başarısız:        ${stats.failed}`);
  console.log(`⏳ Timeout:          ${stats.timeout}`);
  console.log(`📈 Ort. yanıt:       ${avgTime}ms`);
  console.log(`🐢 En yavaş:         ${(maxTime/1000).toFixed(1)}s`);
  console.log(`🐇 En hızlı:         ${minTime}ms`);
  console.log("-".repeat(70));
  console.log("📋 Detay:");

  for (const [type, data] of Object.entries(stats.byType)) {
    const avg = data.times.length > 0 ? (data.times.reduce((a,b)=>a+b,0) / data.times.length).toFixed(0) : 0;
    const max = data.times.length > 0 ? Math.max(...data.times) : 0;
    const rate = ((data.success / (data.success + data.failed)) * 100).toFixed(0);
    console.log(`  ${type.padEnd(14)} ✅${data.success} ❌${data.failed} (${rate}%) | ort:${avg}ms max:${(max/1000).toFixed(1)}s`);
  }
  console.log("=".repeat(70));

  // Genel değerlendirme
  if (parseFloat(successRate) >= 95) {
    console.log("🟢 SONUÇ: MÜKEMMEL — Sunucu 50 kullanıcıyı rahat kaldırıyor!");
  } else if (parseFloat(successRate) >= 80) {
    console.log("🟡 SONUÇ: İYİ — Çoğu istek başarılı ama bazı timeout'lar var.");
  } else if (parseFloat(successRate) >= 60) {
    console.log("🟠 SONUÇ: ORTA — Sunucu zorlanıyor, optimizasyon gerekli.");
  } else {
    console.log("🔴 SONUÇ: KÖTÜ — Sunucu bu yükü kaldıramıyor!");
  }
}

// ========== ANA FONKSİYON ==========

async function main() {
  console.log("=".repeat(70));
  console.log(`🔥 MELODIA YÜK TESTİ BAŞLIYOR — ${TOTAL_USERS} kullanıcı`);
  console.log(`🎯 Hedef: ${BASE_URL}`);
  console.log(`📨 Her kullanıcı 4 istek yapacak (${TOTAL_USERS * 4} toplam)`);
  console.log("=".repeat(70));
  console.log("");

  // 50 kullanıcıyı AYNI ANDA başlat
  const users = [];
  for (let i = 0; i < TOTAL_USERS; i++) {
    users.push(simulateUser(i + 1));
  }

  await Promise.all(users);
  printReport();
}

main().catch(console.error);
