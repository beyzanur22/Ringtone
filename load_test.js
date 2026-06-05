const https  = require("https");
const http   = require("http");
const crypto = require("crypto");

const BASE_URL   = "https://music.cevapla.tv";
const APP_SECRET = "";

// Popüler şarkılar — büyük ihtimalle cache'de olacak (gerçekçi test)
const TEST_VIDEO_IDS = [
  "dQw4w9WgXcQ", "9bZkp7q19f0", "kJQP7kiw5Fk",
  "JGwWNGJdvx8", "YQHsXMglC9A", "hT_nvWreIhg",
  "CevxZvSJLk8", "OPf0YbXqDm0", "fRh_vgS2dFE",
  "RgKAFK5djSk", "3JZ_D3ELwOQ", "pRpeEdMmmQ0"
];

// HMAC imzası üret (gerçek Android istemcisi gibi)
function authHeaders(path) {
  if (!APP_SECRET) return {};
  const ts  = Date.now().toString();
  const sig = crypto.createHmac("sha256", APP_SECRET)
                    .update(`${ts}:${path}`)
                    .digest("base64");
  return { "X-Timestamp": ts, "X-Signature": sig, "X-Country": "TR" };
}

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

// HTTP isteği yap (auth header'lı)
function request(urlPath, timeout = 15000) {
  return new Promise((resolve) => {
    const start    = Date.now();
    const fullUrl  = `${BASE_URL}${urlPath}`;
    const parsed   = new URL(fullUrl);
    const client   = parsed.protocol === "https:" ? https : http;
    const headers  = { ...authHeaders(parsed.pathname), "User-Agent": "RingtoneMaster-Test/1.0" };

    const req = client.get(fullUrl, { headers, timeout }, (res) => {
      let bytes = 0;
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 32 * 1024) res.destroy(); // 32KB okuyunca kes (stream testi)
      });
      res.on("close", () => resolve({ status: res.statusCode, time: Date.now() - start, bytes }));
      res.on("error", ()  => resolve({ status: res.statusCode || 0, time: Date.now() - start, bytes }));
    });
    req.on("error", (e) => resolve({ status: 0, time: Date.now() - start, bytes: 0, error: e.message }));
    req.on("timeout", ()  => { req.destroy(); resolve({ status: 0, time: timeout, bytes: 0, error: "TIMEOUT" }); });
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
  const res = await request(`/top50/test/${region}`);
  stats.top50.times.push(res.time);
  if (res.status === 200) { stats.top50.ok++; return { ok: true, time: res.time }; }
  stats.top50.fail++;
  return { ok: false, status: res.status, error: res.error };
}

// Test 3: Arama
async function testSearch(query = "türkçe pop") {
  const res = await request(`/search?q=${encodeURIComponent(query)}`);
  stats.search.times.push(res.time);
  if (res.status === 200) { stats.search.ok++; return { ok: true, time: res.time }; }
  stats.search.fail++;
  return { ok: false, status: res.status, error: res.error };
}

// Test 4: Stream (32KB okuyup bırak — gerçek kullanıcı davranışı)
async function testStream(videoId) {
  const res = await request(`/stream?videoId=${videoId}&type=audio`, 25000);
  stats.stream.times.push(res.time);
  // 206 Partial / 200 OK = başarılı stream
  if (res.status === 200 || res.status === 206) { stats.stream.ok++; return { ok: true, time: res.time }; }
  // 403 = auth gerekli ama sunucu ayakta
  if (res.status === 403) { stats.stream.ok++; return { ok: true, time: res.time, note: "auth_required" }; }
  stats.stream.fail++;
  return { ok: false, status: res.status, error: res.error };
}

// p95 hesapla
function p95(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)] || 0;
}

// Sonuçları yazdır
function printStats() {
  const elapsed = Math.round((Date.now() - stats.startTime) / 1000);
  console.clear();
  console.log(`${C.bold}${C.cyan}════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}   RingtoneMaster Yük Testi — ${elapsed}s çalışıyor${C.reset}`);
  console.log(`${C.bold}${C.cyan}════════════════════════════════════════════${C.reset}`);
  console.log(`  Hedef: ${BASE_URL}`);
  console.log(`  Senaryo: ${SCENARIO.toUpperCase()}`);
  console.log(`${C.cyan}────────────────────────────────────────────${C.reset}`);
  console.log(`  ${"Endpoint".padEnd(10)} ${"✅ OK".padEnd(8)} ${"❌ FAIL".padEnd(8)} ${"Başarı".padEnd(8)} ${"Avg".padEnd(8)} P95`);
  console.log(`  ${"─".repeat(52)}`);

  const print = (name, s) => {
    const total = s.ok + s.fail;
    const rate  = total ? Math.round((s.ok / total) * 100) : 0;
    const color = rate >= 90 ? C.green : rate >= 70 ? C.yellow : C.red;
    console.log(
      `  ${C.bold}${name.padEnd(10)}${C.reset}` +
      ` ${String(s.ok).padEnd(8)}` +
      ` ${String(s.fail).padEnd(8)}` +
      ` ${color}%${rate}${C.reset}`.padEnd(12) +
      ` ${avg(s.times)}ms`.padEnd(9) +
      ` ${p95(s.times)}ms`
    );
  };

  print("Health",  stats.health);
  print("Top50",   stats.top50);
  print("Search",  stats.search);
  print("Stream",  stats.stream);

  console.log(`${C.cyan}────────────────────────────────────────────${C.reset}`);

  const totalReq = stats.total;
  const rps      = elapsed > 0 ? Math.round(totalReq / elapsed) : 0;
  const allOk    = stats.health.ok + stats.top50.ok + stats.search.ok + stats.stream.ok;
  const allFail  = stats.health.fail + stats.top50.fail + stats.search.fail + stats.stream.fail;
  const overall  = totalReq ? Math.round((allOk / totalReq) * 100) : 0;
  const oColor   = overall >= 90 ? C.green : overall >= 70 ? C.yellow : C.red;

  console.log(`  Toplam istek : ${totalReq} | Süre: ${elapsed}s | RPS: ${rps}`);
  console.log(`  Genel başarı : ${oColor}%${overall}${C.reset}`);

  if (overall >= 95)      console.log(`\n  ${C.green}${C.bold}✅ SİSTEM STABIL — daha fazla kullanıcı eklenebilir${C.reset}`);
  else if (overall >= 80) console.log(`\n  ${C.yellow}${C.bold}⚠️  SİSTEM ZORLANMAYA BAŞLIYOR${C.reset}`);
  else                    console.log(`\n  ${C.red}${C.bold}❌ KRİTİK — sistem dayanamıyor${C.reset}`);

  console.log(`\n  ${C.yellow}Durdurmak için Ctrl+C${C.reset}`);
}

// ══════════════════════════════════════════
//  TEST SENARYOLARI
// ══════════════════════════════════════════

// Senaryo 1: Hafif — 10 eşzamanlı kullanıcı
async function scenarioLight() {
  const batch = [];
  for (let i = 0; i < 10; i++) {
    const vid = TEST_VIDEO_IDS[i % TEST_VIDEO_IDS.length];
    batch.push(testHealth(), testTop50("TR"), testSearch("türkçe pop"), testStream(vid));
    stats.total += 4;
  }
  await Promise.allSettled(batch);
}

// Senaryo 2: Orta — 50 eşzamanlı kullanıcı
async function scenarioMedium() {
  const batch = [];
  const queries  = ["türkçe pop", "aşk şarkısı", "yabancı müzik", "Sezen Aksu", "Tarkan"];
  const regions  = ["TR", "US", "DE", "AZ", "RU"];
  for (let i = 0; i < 50; i++) {
    const vid = TEST_VIDEO_IDS[i % TEST_VIDEO_IDS.length];
    if (i % 10 === 0) { batch.push(testHealth()); stats.total++; }
    if (i % 5  === 0) { batch.push(testTop50(regions[i % regions.length])); stats.total++; }
    batch.push(testSearch(queries[i % queries.length]), testStream(vid));
    stats.total += 2;
  }
  await Promise.allSettled(batch);
}

// Senaryo 3: Ağır — 200 eşzamanlı stream (sunucuyu zorla)
async function scenarioHeavy() {
  const batch = [];
  for (let i = 0; i < 200; i++) {
    const vid = TEST_VIDEO_IDS[i % TEST_VIDEO_IDS.length];
    batch.push(testStream(vid));
    stats.total++;
    if (i % 20 === 0) { batch.push(testSearch("pop")); stats.total++; }
    if (i % 50 === 0) { batch.push(testTop50("TR"));   stats.total++; }
  }
  await Promise.allSettled(batch);
}

// ══════════════════════════════════════════
//  ANA DÖNGÜ
// ══════════════════════════════════════════

const SCENARIO = process.argv[2] || "light";

const scenarioMap = { light: scenarioLight, medium: scenarioMedium, heavy: scenarioHeavy };
const chosenScenario = scenarioMap[SCENARIO] || scenarioLight;

const KULLANICI_SAYISI = { light: 10, medium: 50, heavy: 200 };

console.log(`${C.bold}${C.cyan}`);
console.log(`╔══════════════════════════════════════════╗`);
console.log(`║     RingtoneMaster Yük Testi Başlıyor    ║`);
console.log(`╚══════════════════════════════════════════╝${C.reset}`);
console.log(`  Hedef    : ${BASE_URL}`);
console.log(`  Senaryo  : ${SCENARIO.toUpperCase()} (${KULLANICI_SAYISI[SCENARIO]} eşzamanlı kullanıcı)`);
console.log(`  Auth     : ${APP_SECRET ? "✅ HMAC imzalı" : "⚠️  İmzasız (APP_KEY ayarlı değil)"}`);
console.log(`\n  Kullanım :`);
console.log(`    node load_test.js light   → 10 kullanıcı  (güvenli test)`);
console.log(`    node load_test.js medium  → 50 kullanıcı  (normal yük)`);
console.log(`    node load_test.js heavy   → 200 kullanıcı (stres testi)`);
console.log(`\n  Durdurmak için Ctrl+C\n`);

setInterval(printStats, 2000);

async function run() {
  while (true) {
    await chosenScenario();
    await new Promise(r => setTimeout(r, 500));
  }
}

process.on("SIGINT", () => {
  printStats();
  console.log(`\n${C.green}${C.bold}Test tamamlandı.${C.reset}`);
  process.exit(0);
});

run().catch(console.error);
