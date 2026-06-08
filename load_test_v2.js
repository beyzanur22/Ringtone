/**
 * 🔥 MELODIA YÜK TESTİ v2 — Gerçek Kullanıcı Simülasyonu
 *
 * Gerçek akış: Arama yap → Sonuçları gör (search warm tetiklenir) → Birkaç saniye bekle → Şarkı aç
 * Bu sayede search warm + pre-resolve'un işe yarayıp yaramadığını test eder
 *
 * Kullanım: node load_test_v2.js
 */

const BASE_URL = "https://music.cevapla.tv";
const TOTAL_USERS = 100;
const APP_SECRET = "RINGTONE_MASTER_V2_SECRET_2026";
const crypto = require("crypto");

const SEARCH_QUERIES = [
  "blok3", "tarkan", "müslüm gürses", "sezen aksu", "eminem",
  "drake", "the weeknd", "billie eilish", "dua lipa", "ed sheeran",
  "adele", "bruno mars", "ariana grande", "taylor swift", "bad bunny",
  "bts", "blackpink", "imagine dragons", "coldplay", "rihanna",
  "post malone", "travis scott", "kendrick lamar", "juice wrld", "lil nas x"
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
  preResolve: { success: 0, failed: 0, times: [] },
  stream: { success: 0, failed: 0, times: [], cacheHit: 0, cacheMiss: 0 },
  startTime: Date.now()
};

function log(icon, type, time, detail) {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);
  const timeStr = time < 1000 ? `${time}ms` : `${(time/1000).toFixed(1)}s`;
  const total = stats.search.success + stats.search.failed + stats.stream.success + stats.stream.failed;
  console.log(`[${elapsed}s] ${icon} ${type.padEnd(14)} ${timeStr.padStart(8)} | ${detail}`);
}

// ========== KULLANICI SİMÜLASYONU ==========

async function simulateUser(userId) {
  const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];

  // ADIM 1: Arama yap (search warm tetiklenir)
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
      log("🔍", "SEARCH", Date.now() - searchStart, `User${userId} "${query}" → ${searchResults.length} sonuç`);
    } else {
      stats.search.failed++;
      log("❌", "SEARCH", Date.now() - searchStart, `User${userId} "${query}" → ${resp.status}`);
    }
  } catch (e) {
    stats.search.failed++;
    stats.search.times.push(Date.now() - searchStart);
    log("❌", "SEARCH", Date.now() - searchStart, `User${userId} "${query}" → ${e.message}`);
    return;
  }

  if (searchResults.length === 0) return;

  // ADIM 2: Pre-resolve gönder (Android'in yapacağı gibi)
  const videoIds = searchResults.slice(0, 10).map(item => {
    const id = item.id || "";
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    return "";
  }).filter(Boolean);

  if (videoIds.length > 0) {
    const preStart = Date.now();
    try {
      const resp = await fetch(`${BASE_URL}/pre-resolve`, {
        method: "POST",
        headers: { ...getAuthHeaders("/pre-resolve"), "Content-Type": "application/json" },
        body: JSON.stringify({ videoIds }),
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) {
        const data = await resp.json();
        stats.preResolve.success++;
        stats.preResolve.times.push(Date.now() - preStart);
        log("🔥", "PRE-RESOLVE", Date.now() - preStart, `User${userId} ${data.alreadyCached} cached, ${data.queued} queued`);
      }
    } catch (e) {
      stats.preResolve.failed++;
    }
  }

  // ADIM 3: Kullanıcı listeye bakıyor — 5-10 saniye bekle (search warm + pre-resolve çalışsın)
  const waitTime = 5000 + Math.random() * 5000;
  log("⏳", "WAITING", waitTime, `User${userId} listeye bakıyor... (${(waitTime/1000).toFixed(0)}s)`);
  await new Promise(r => setTimeout(r, waitTime));

  // ADIM 4: Rastgele 2-3 şarkı aç (cache'te olmalı artık)
  const songsToPlay = Math.floor(Math.random() * 2) + 2; // 2-3 şarkı
  for (let i = 0; i < songsToPlay && i < videoIds.length; i++) {
    const videoId = videoIds[Math.floor(Math.random() * videoIds.length)];
    const streamStart = Date.now();
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

        // 2 saniyeden hızlıysa cache hit sayılır
        if (streamTime < 2000) {
          stats.stream.cacheHit++;
          log("⚡", "STREAM-CACHE", streamTime, `User${userId} ${videoId} → CACHE HIT! ${streamTime}ms`);
        } else {
          stats.stream.cacheMiss++;
          log("🐢", "STREAM-SLOW", streamTime, `User${userId} ${videoId} → ${(streamTime/1000).toFixed(1)}s (cache miss)`);
        }
      } else {
        stats.stream.failed++;
        log("❌", "STREAM", streamTime, `User${userId} ${videoId} → ${resp.status}`);
      }
    } catch (e) {
      stats.stream.failed++;
      stats.stream.times.push(Date.now() - streamStart);
      log("❌", "STREAM", Date.now() - streamStart, `User${userId} ${videoId} → ${e.message}`);
    }

    // Şarkılar arası 1-3 saniye bekle
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
  }
}

// ========== RAPOR ==========

function printReport() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const totalStream = stats.stream.success + stats.stream.failed;
  const cacheHitRate = totalStream > 0 ? ((stats.stream.cacheHit / totalStream) * 100).toFixed(1) : 0;
  const avgStream = stats.stream.times.length > 0 ? (stats.stream.times.reduce((a,b)=>a+b,0) / stats.stream.times.length / 1000).toFixed(1) : 0;
  const avgSearch = stats.search.times.length > 0 ? (stats.search.times.reduce((a,b)=>a+b,0) / stats.search.times.length / 1000).toFixed(1) : 0;
  const streamSuccess = totalStream > 0 ? ((stats.stream.success / totalStream) * 100).toFixed(1) : 0;

  console.log("\n" + "=".repeat(70));
  console.log("📊 YÜK TESTİ v2 RAPORU — Gerçek Kullanıcı Simülasyonu");
  console.log("=".repeat(70));
  console.log(`⏱️  Toplam süre:        ${elapsed}s`);
  console.log(`👥 Kullanıcı sayısı:    ${TOTAL_USERS}`);
  console.log("");
  console.log(`🔍 ARAMA:`);
  console.log(`   Başarılı: ${stats.search.success} | Başarısız: ${stats.search.failed} | Ort: ${avgSearch}s`);
  console.log("");
  console.log(`🔥 PRE-RESOLVE:`);
  console.log(`   Başarılı: ${stats.preResolve.success} | Başarısız: ${stats.preResolve.failed}`);
  console.log("");
  console.log(`🎵 STREAM (ŞARKİ ÇALMA):`);
  console.log(`   Başarılı: ${stats.stream.success} | Başarısız: ${stats.stream.failed} (${streamSuccess}% başarı)`);
  console.log(`   ⚡ Cache hit:  ${stats.stream.cacheHit} (${cacheHitRate}%)`);
  console.log(`   🐢 Cache miss: ${stats.stream.cacheMiss}`);
  console.log(`   Ort. yanıt:    ${avgStream}s`);
  console.log("");
  console.log("-".repeat(70));

  if (parseFloat(cacheHitRate) >= 80) {
    console.log("🟢 MÜKEMMEL — Pre-resolve çalışıyor! Şarkıların %80+'ı cache'ten geldi.");
  } else if (parseFloat(cacheHitRate) >= 50) {
    console.log("🟡 İYİ — Pre-resolve kısmen çalışıyor. Bekleme süresini artırmak iyileştirebilir.");
  } else if (parseFloat(streamSuccess) >= 80) {
    console.log("🟠 ORTA — Şarkılar çalıyor ama cache hit düşük. Search warm'a daha fazla süre ver.");
  } else {
    console.log("🔴 KÖTÜ — Stream başarı oranı düşük. Sunucu yükü altında eziliyor.");
  }
  console.log("=".repeat(70));
}

// ========== ANA ==========

async function main() {
  console.log("=".repeat(70));
  console.log(`🔥 MELODIA YÜK TESTİ v2 — ${TOTAL_USERS} Gerçek Kullanıcı`);
  console.log(`🎯 Hedef: ${BASE_URL}`);
  console.log(`📋 Akış: Arama → Pre-resolve → 5-10s bekleme → Şarkı çalma`);
  console.log("=".repeat(70));
  console.log("");

  const users = [];
  for (let i = 0; i < TOTAL_USERS; i++) {
    // Kullanıcıları 0-3 saniye arayla başlat (gerçekçi)
    await new Promise(r => setTimeout(r, Math.random() * 600));
    users.push(simulateUser(i + 1));
  }

  await Promise.all(users);
  printReport();
}

main().catch(console.error);
