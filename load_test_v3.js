/**
 * 🔥 MELODIA YÜK TESTİ v3 — 200 Kişi Worker Test
 *
 * Akış: Arama yap → 2-3sn bekle → 1 şarkı tıkla (search warm YOK)
 * Worker performansını ve gerçek kapasiteyi ölçer
 *
 * Kullanım: node load_test_v3.js
 */

const BASE_URL = "https://music.cevapla.tv";
const TOTAL_USERS = 200;
const APP_SECRET = "RINGTONE_MASTER_V2_SECRET_2026";
const crypto = require("crypto");

const SEARCH_QUERIES = [
  "blok3", "tarkan", "müslüm gürses", "sezen aksu", "eminem",
  "drake", "the weeknd", "billie eilish", "dua lipa", "ed sheeran",
  "adele", "bruno mars", "ariana grande", "taylor swift", "bad bunny",
  "bts", "blackpink", "imagine dragons", "coldplay", "rihanna",
  "post malone", "travis scott", "kendrick lamar", "juice wrld", "lil nas x",
  "sefo", "mabel matiz", "norm ender", "ceza", "sagopa kajmer",
  "duman", "mor ve ötesi", "teoman", "manga", "athena",
  "ezhel", "ben fero", "lvbel c5", "uzi", "cakal"
];

function getAuthHeaders(path) {
  const timestamp = Date.now().toString();
  const payload = timestamp + ":" + path;
  const signature = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64");
  return { "x-timestamp": timestamp, "x-signature": signature };
}

// ========== STATS ==========
const stats = {
  search: { success: 0, failed: 0, times: [] },
  stream: { success: 0, failed: 0, times: [], details: [] },
  startTime: Date.now(),
  concurrent: { current: 0, max: 0 }
};

// ========== KULLANICI SİMÜLASYONU ==========
async function simulateUser(userId) {
  const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];

  // ADIM 1: Arama yap
  let searchResults = [];
  const searchStart = Date.now();
  try {
    const resp = await fetch(`${BASE_URL}/search?q=${encodeURIComponent(query)}`, {
      headers: getAuthHeaders("/search"),
      signal: AbortSignal.timeout(30000)
    });
    if (resp.ok) {
      const data = await resp.json();
      searchResults = data.data || [];
      stats.search.success++;
      stats.search.times.push(Date.now() - searchStart);
    } else {
      stats.search.failed++;
      return;
    }
  } catch (e) {
    stats.search.failed++;
    return;
  }

  if (searchResults.length === 0) return;

  // ADIM 2: 2-3 saniye bekle (kullanıcı listeye bakıyor)
  await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));

  // ADIM 3: 1 şarkı tıkla
  const videoIds = searchResults.slice(0, 5).map(item => {
    const id = item.id || "";
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    return "";
  }).filter(Boolean);

  if (videoIds.length === 0) return;

  const videoId = videoIds[Math.floor(Math.random() * videoIds.length)];
  const streamStart = Date.now();

  stats.concurrent.current++;
  if (stats.concurrent.current > stats.concurrent.max) stats.concurrent.max = stats.concurrent.current;

  try {
    const resp = await fetch(`${BASE_URL}/stream?videoId=${videoId}`, {
      headers: getAuthHeaders("/stream"),
      signal: AbortSignal.timeout(60000)
    });
    const streamTime = Date.now() - streamStart;
    stats.stream.times.push(streamTime);

    if (resp.ok && resp.body) {
      const reader = resp.body.getReader();
      const { value } = await reader.read();
      reader.cancel();
      stats.stream.success++;

      const status = streamTime < 1000 ? "⚡CACHE" : streamTime < 5000 ? "✅HIZLI" : streamTime < 15000 ? "🟡ORTA" : "🐢YAVAŞ";
      const detail = { userId, query, videoId, time: streamTime, status };
      stats.stream.details.push(detail);

      const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);
      console.log(`[${elapsed}s] ${status} User${userId} "${query}" → ${videoId} (${(streamTime/1000).toFixed(1)}s) [eşzamanlı: ${stats.concurrent.current}]`);
    } else {
      stats.stream.failed++;
      stats.stream.details.push({ userId, query, videoId, time: streamTime, status: "❌FAIL" });
      console.log(`[${((Date.now()-stats.startTime)/1000).toFixed(0)}s] ❌FAIL User${userId} "${query}" → ${videoId} (${resp.status})`);
    }
  } catch (e) {
    const streamTime = Date.now() - streamStart;
    stats.stream.failed++;
    stats.stream.times.push(streamTime);
    stats.stream.details.push({ userId, query, videoId, time: streamTime, status: "❌TIMEOUT" });
    console.log(`[${((Date.now()-stats.startTime)/1000).toFixed(0)}s] ❌TIMEOUT User${userId} "${query}" → ${videoId} (${(streamTime/1000).toFixed(1)}s)`);
  } finally {
    stats.concurrent.current--;
  }
}

// ========== RAPOR ==========
function printReport() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const totalStream = stats.stream.success + stats.stream.failed;
  const successRate = totalStream > 0 ? ((stats.stream.success / totalStream) * 100).toFixed(1) : 0;

  const cache = stats.stream.details.filter(d => d.status === "⚡CACHE").length;
  const fast = stats.stream.details.filter(d => d.status === "✅HIZLI").length;
  const medium = stats.stream.details.filter(d => d.status === "🟡ORTA").length;
  const slow = stats.stream.details.filter(d => d.status === "🐢YAVAŞ").length;
  const fail = stats.stream.details.filter(d => d.status.includes("FAIL") || d.status.includes("TIMEOUT")).length;

  const avgStream = stats.stream.times.length > 0 ? (stats.stream.times.reduce((a,b)=>a+b,0) / stats.stream.times.length / 1000).toFixed(1) : 0;
  const avgSearch = stats.search.times.length > 0 ? (stats.search.times.reduce((a,b)=>a+b,0) / stats.search.times.length / 1000).toFixed(1) : 0;

  // En hızlı ve en yavaş
  const sorted = stats.stream.details.filter(d => !d.status.includes("FAIL") && !d.status.includes("TIMEOUT")).sort((a,b) => a.time - b.time);
  const fastest = sorted[0];
  const slowest = sorted[sorted.length - 1];

  console.log("\n" + "═".repeat(70));
  console.log("📊 MELODIA YÜK TESTİ v3 — 200 KİŞİ WORKER TESTİ");
  console.log("═".repeat(70));
  console.log(`⏱️  Toplam süre:          ${elapsed}s`);
  console.log(`👥 Kullanıcı:             ${TOTAL_USERS}`);
  console.log(`🔄 Max eşzamanlı stream:  ${stats.concurrent.max}`);
  console.log("");
  console.log(`🔍 ARAMA: ${stats.search.success} başarılı / ${stats.search.failed} başarısız (ort: ${avgSearch}s)`);
  console.log("");
  console.log(`🎵 ŞARKI AÇMA (${totalStream} toplam):`);
  console.log(`   ⚡ Cache (<1s):    ${cache}`);
  console.log(`   ✅ Hızlı (1-5s):   ${fast}`);
  console.log(`   🟡 Orta (5-15s):   ${medium}`);
  console.log(`   🐢 Yavaş (>15s):   ${slow}`);
  console.log(`   ❌ Başarısız:       ${fail}`);
  console.log(`   📈 Başarı oranı:   ${successRate}%`);
  console.log(`   ⏱️  Ort. süre:      ${avgStream}s`);
  console.log("");
  if (fastest) console.log(`   🏆 En hızlı: "${fastest.query}" → ${fastest.videoId} (${(fastest.time/1000).toFixed(1)}s)`);
  if (slowest) console.log(`   🐌 En yavaş: "${slowest.query}" → ${slowest.videoId} (${(slowest.time/1000).toFixed(1)}s)`);
  console.log("");
  console.log("─".repeat(70));

  if (parseFloat(successRate) >= 90) {
    console.log("🟢 MÜKEMMEL — Sistem 200 kişiyi rahat kaldırıyor!");
  } else if (parseFloat(successRate) >= 70) {
    console.log("🟡 İYİ — Çoğu kullanıcı şarkı açabiliyor, bazıları gecikiyor.");
  } else if (parseFloat(successRate) >= 50) {
    console.log("🟠 ORTA — Sistem zorlanıyor, daha fazla worker veya sunucu lazım.");
  } else {
    console.log("🔴 KÖTÜ — Sistem bu yükü kaldıramıyor. Acil ölçekleme gerekli.");
  }
  console.log("═".repeat(70));
}

// ========== ANA ==========
async function main() {
  console.log("═".repeat(70));
  console.log(`🔥 MELODIA YÜK TESTİ v3 — ${TOTAL_USERS} Kullanıcı (Worker Test)`);
  console.log(`🎯 Hedef: ${BASE_URL}`);
  console.log(`📋 Akış: Arama → 2-3s bekleme → 1 şarkı tıkla`);
  console.log(`📋 Search warm: KAPALI — her şarkı yt-dlp'den çözülecek`);
  console.log("═".repeat(70));
  console.log("");

  const users = [];
  for (let i = 0; i < TOTAL_USERS; i++) {
    // 0-500ms arayla başlat (200 kişi ~100sn'de gelir — gerçekçi)
    await new Promise(r => setTimeout(r, Math.random() * 500));
    users.push(simulateUser(i + 1));
  }

  await Promise.all(users);
  printReport();
}

main().catch(console.error);
