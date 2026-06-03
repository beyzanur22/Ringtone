/**
 * LOAD TEST — Ringtone Backend
 * Çalıştır: node load_test.js
 * Durdurmak için: Ctrl+C
 */

const https = require("https");
const http = require("http");

const BASE_URL = "https://music.cevapla.tv";

// Test edilecek video ID'leri (gerçek YouTube ID'leri)
const TEST_VIDEO_IDS = [
  "dQw4w9WgXcQ",
  "9bZkp7q19f0",
  "kJQP7kiw5Fk",
  "JGwWNGJdvx8",
  "YQHsXMglC9A",
  "hT_nvWreIhg",
  "CevxZvSJLk8",
  "OPf0YbXqDm0",
  "fRh_vgS2dFE",
  "RgKAFK5djSk"
];

// Renkler
const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m"
};

// İstatistikler
const stats = {
  health: { ok: 0, fail: 0, times: [] },
  top50: { ok: 0, fail: 0, times: [] },
  search: { ok: 0, fail: 0, times: [] },
  stream: { ok: 0, fail: 0, times: [] },
  total: 0,
  startTime: Date.now()
};

// HTTP isteği yap
function request(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({
        status: res.statusCode,
        time: Date.now() - start,
        data
      }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// Ortalama hesapla
function avg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

// Test 1: Health check
async function testHealth() {
  try {
    const res = await request(`${BASE_URL}/health`);
    stats.health.times.push(res.time);
    if (res.status === 200) {
      stats.health.ok++;
      return { ok: true, time: res.time };
    } else {
      stats.health.fail++;
      return { ok: false, status: res.status };
    }
  } catch (e) {
    stats.health.fail++;
    return { ok: false, error: e.message };
  }
}

// Test 2: Top 50
async function testTop50(region = "TR") {
  try {
    const res = await request(`${BASE_URL}/top50/test/${region}`, 15000);
    stats.top50.times.push(res.time);
    if (res.status === 200) {
      stats.top50.ok++;
      return { ok: true, time: res.time };
    } else {
      stats.top50.fail++;
      return { ok: false, status: res.status };
    }
  } catch (e) {
    stats.top50.fail++;
    return { ok: false, error: e.message };
  }
}

// Test 3: Arama
async function testSearch(query = "Seda Sayan") {
  try {
    const encoded = encodeURIComponent(query);
    const res = await request(`${BASE_URL}/search?q=${encoded}`, 15000);
    stats.search.times.push(res.time);
    if (res.status === 200 || res.status === 403) {
      if (res.status === 200) stats.search.ok++;
      else stats.search.fail++;
      return { ok: res.status === 200, time: res.time, status: res.status };
    } else {
      stats.search.fail++;
      return { ok: false, status: res.status };
    }
  } catch (e) {
    stats.search.fail++;
    return { ok: false, error: e.message };
  }
}

// Test 4: Stream URL
async function testStream(videoId) {
  try {
    const res = await request(`${BASE_URL}/stream?videoId=${videoId}&type=audio`, 20000);
    stats.stream.times.push(res.time);
    // 403 token gerekli — bu beklenen, endpoint cevap verdi demek
    if (res.status === 200 || res.status === 403 || res.status === 302) {
      stats.stream.ok++;
      return { ok: true, time: res.time, status: res.status };
    } else {
      stats.stream.fail++;
      return { ok: false, status: res.status };
    }
  } catch (e) {
    stats.stream.fail++;
    return { ok: false, error: e.message };
  }
}

// Sonuçları yazdır
function printStats() {
  const elapsed = Math.round((Date.now() - stats.startTime) / 1000);
  console.clear();
  console.log(`${C.bold}${C.cyan}══════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}   LOAD TEST — ${elapsed}s çalışıyor${C.reset}`);
  console.log(`${C.bold}${C.cyan}══════════════════════════════════════${C.reset}`);

  const print = (name, s) => {
    const total = s.ok + s.fail;
    const rate = total ? Math.round((s.ok / total) * 100) : 0;
    const color = rate >= 90 ? C.green : rate >= 70 ? C.yellow : C.red;
    console.log(
      `${C.bold}${name.padEnd(10)}${C.reset}` +
      ` ✅ ${String(s.ok).padStart(4)}` +
      ` ❌ ${String(s.fail).padStart(4)}` +
      ` ${color}${rate}%${C.reset}` +
      ` ⏱  avg:${avg(s.times)}ms`
    );
  };

  print("Health", stats.health);
  print("Top50", stats.top50);
  print("Search", stats.search);
  print("Stream", stats.stream);

  console.log(`${C.cyan}──────────────────────────────────────${C.reset}`);
  console.log(`Toplam istek: ${stats.total} | Süre: ${elapsed}s | RPS: ${Math.round(stats.total / elapsed)}`);
  console.log(`${C.yellow}Durdurmak için Ctrl+C${C.reset}`);
}

// ══════════════════════════════
// TEST SENARYOLARI
// ══════════════════════════════

// Senaryo 1: Hafif test (10 kullanıcı)
async function scenarioLight() {
  const promises = [];
  for (let i = 0; i < 10; i++) {
    const videoId = TEST_VIDEO_IDS[i % TEST_VIDEO_IDS.length];
    promises.push(testHealth());
    promises.push(testTop50("TR"));
    promises.push(testSearch("türkçe pop"));
    promises.push(testStream(videoId));
    stats.total += 4;
  }
  await Promise.allSettled(promises);
}

// Senaryo 2: Orta test (50 kullanıcı)
async function scenarioMedium() {
  const promises = [];
  for (let i = 0; i < 50; i++) {
    const videoId = TEST_VIDEO_IDS[i % TEST_VIDEO_IDS.length];
    if (i % 5 === 0) promises.push(testHealth());
    if (i % 3 === 0) promises.push(testTop50(["TR", "US", "DE"][i % 3]));
    promises.push(testSearch(["türkçe pop", "aşk şarkısı", "yabancı müzik"][i % 3]));
    promises.push(testStream(videoId));
    stats.total += 2;
  }
  await Promise.allSettled(promises);
}

// Senaryo 3: Ağır test (200 kullanıcı)
async function scenarioHeavy() {
  const promises = [];
  for (let i = 0; i < 200; i++) {
    const videoId = TEST_VIDEO_IDS[i % TEST_VIDEO_IDS.length];
    promises.push(testStream(videoId));
    stats.total++;
    if (i % 10 === 0) {
      promises.push(testSearch("pop müzik"));
      stats.total++;
    }
  }
  await Promise.allSettled(promises);
}

// ══════════════════════════════
// ANA DÖNGÜ
// ══════════════════════════════

const SCENARIO = process.argv[2] || "light";

console.log(`${C.bold}${C.cyan}Test başlıyor... Senaryo: ${SCENARIO}${C.reset}`);
console.log(`Hedef: ${BASE_URL}`);
console.log(`Durdurmak için Ctrl+C\n`);

async function run() {
  const scenarios = {
    light: scenarioLight,
    medium: scenarioMedium,
    heavy: scenarioHeavy
  };

  const scenario = scenarios[SCENARIO] || scenarioLight;

  // Her 3 saniyede bir test çalıştır
  const interval = setInterval(printStats, 2000);

  while (true) {
    await scenario();
    await new Promise(r => setTimeout(r, 1000));
  }
}

process.on("SIGINT", () => {
  printStats();
  console.log(`\n${C.green}Test durduruldu.${C.reset}`);
  process.exit(0);
});

run().catch(console.error);
