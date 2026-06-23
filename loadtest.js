/**
 * Load Test — 100 eşzamanlı kullanıcı, karışık senaryo
 * Kullanım: node loadtest.js [kullanici_sayisi]
 * Örnek:    node loadtest.js 100
 */

const https  = require("https");
const http   = require("http");
const crypto = require("crypto");

const BASE_URL        = "https://music.cevapla.tv";
const APP_SECRET      = process.env.APP_KEY || "RINGTONE_MASTER_V2_SECRET_2026";
const CONCURRENT      = parseInt(process.argv[2]) || 100;
const REQUEST_TIMEOUT = 20000; // ms

// Gerçek video ID'leri
const VIDEO_IDS = [
  "dQw4w9WgXcQ", "kJQP7kiw5Fk", "9bZkp7q19f0", "OPf0YbXqDm0",
  "hT_nvWreIhg", "YQHsXMglC9A", "JGwWNGJdvx8", "fRh_vgS2dFE",
  "RgKAFK5djSk", "CevxZvSJLk8", "M7lc1UVf-VE", "WA4iX5D9Z9c",
  "60ItHLz5WEA", "nfWlot6h_JM", "4NRXx6pxIVE", "lp-EBohGJDA",
  "tVj0ZTS4WF4", "e-ORhEE9VVg", "n8X9_MgEdCg", "ZbZSe6N_BXs",
];

const SEARCH_TERMS = [
  "eminem", "taylor swift", "dua lipa", "weeknd", "billie eilish",
  "ed sheeran", "ariana grande", "drake", "post malone", "olivia rodrigo",
  "türkçe pop", "rap türkçe", "slow şarkılar", "2024 hits", "workout music",
];

// Kullanıcı tipleri ve ağırlıkları
const USER_TYPES = [
  { type: "listener",    weight: 30 }, // sadece dinler
  { type: "searcher",    weight: 20 }, // arama yapar + dinler
  { type: "mp3_dl",      weight: 15 }, // mp3 indirir
  { type: "mp4_dl",      weight: 10 }, // video indirir
  { type: "video_watch", weight: 15 }, // video izler
  { type: "mixed",       weight: 10 }, // her şeyi yapar
];

// İstatistikler
const stats = {
  total: 0, success: 0, failed: 0,
  byEndpoint: {},
  latencies: [],
  errors: [],
};

function authHeaders(path) {
  const timestamp = Date.now().toString();
  const payload   = timestamp + ":" + path;
  const signature = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64");
  return { "X-Timestamp": timestamp, "X-Signature": signature, "X-Country": "TR" };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickUserType() {
  const total = USER_TYPES.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of USER_TYPES) {
    r -= t.weight;
    if (r <= 0) return t.type;
  }
  return USER_TYPES[0].type;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function req(url, label) {
  return new Promise((resolve) => {
    const t0     = Date.now();
    const urlObj = new URL(url);
    const isHttps = url.startsWith("https");
    const mod    = isHttps ? https : http;
    const path   = urlObj.pathname;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      timeout: REQUEST_TIMEOUT,
      headers: { ...authHeaders(path), "User-Agent": "LoadTest/1.0" },
    };

    const request = mod.request(options, (res) => {
      let size = 0;
      res.on("data", c => { size += c.length; });
      res.on("end", () => {
        const ms = Date.now() - t0;
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        resolve({ ok, status: res.statusCode, ms, size, label });
      });
    });

    request.on("error", e => resolve({ ok: false, status: 0, ms: Date.now() - t0, size: 0, label, error: e.message }));
    request.on("timeout", () => {
      request.destroy();
      resolve({ ok: false, status: 0, ms: REQUEST_TIMEOUT, size: 0, label, error: "timeout" });
    });
    request.end();
  });
}

function record(result, userId) {
  stats.total++;
  const tag = result.label;
  if (!stats.byEndpoint[tag]) stats.byEndpoint[tag] = { ok: 0, fail: 0, latencies: [] };

  if (result.ok) {
    stats.success++;
    stats.byEndpoint[tag].ok++;
  } else {
    stats.failed++;
    stats.byEndpoint[tag].fail++;
    stats.errors.push(`User${userId} | ${tag} | ${result.status} | ${result.error || ""}`);
  }
  stats.latencies.push(result.ms);
  stats.byEndpoint[tag].latencies.push(result.ms);

  const icon = result.ok ? "✅" : "❌";
  const kb   = (result.size / 1024).toFixed(0);
  process.stdout.write(
    `${icon} U${String(userId).padStart(3)} | ${tag.padEnd(14)} | ${result.status} | ${result.ms}ms | ${kb}KB\n`
  );
}

// ---------- Senaryo fonksiyonları ----------

async function doStream(userId) {
  const id  = pick(VIDEO_IDS);
  const url = `${BASE_URL}/stream?videoId=${id}&type=audio`;
  record(await req(url, "stream/audio"), userId);
  await sleep(300 + Math.random() * 700);
}

async function doSearch(userId) {
  const q   = encodeURIComponent(pick(SEARCH_TERMS));
  const url = `${BASE_URL}/search?q=${q}`;
  record(await req(url, "search"), userId);
  await sleep(200 + Math.random() * 400);
}

async function doVideoStream(userId) {
  const id  = pick(VIDEO_IDS);
  const url = `${BASE_URL}/stream/video?videoId=${id}`;
  record(await req(url, "stream/video"), userId);
  await sleep(500 + Math.random() * 1000);
}

async function doMp3Download(userId) {
  const id  = pick(VIDEO_IDS);
  const url = `${BASE_URL}/download/mp3?videoId=${id}`;
  record(await req(url, "download/mp3"), userId);
  await sleep(1000 + Math.random() * 2000);
}

async function doMp4Download(userId) {
  const id  = pick(VIDEO_IDS);
  const url = `${BASE_URL}/download/mp4?videoId=${id}`;
  record(await req(url, "download/mp4"), userId);
  await sleep(1000 + Math.random() * 2000);
}

async function doAutocomplete(userId) {
  const q   = encodeURIComponent(pick(SEARCH_TERMS).split(" ")[0]);
  const url = `${BASE_URL}/autocomplete?q=${q}`;
  record(await req(url, "autocomplete"), userId);
  await sleep(100 + Math.random() * 200);
}

async function doTop50(userId) {
  const url = `${BASE_URL}/top50`;
  record(await req(url, "top50"), userId);
  await sleep(200 + Math.random() * 400);
}

// ---------- Kullanıcı senaryoları ----------

async function simulateUser(userId) {
  const type = pickUserType();
  await sleep(Math.random() * 2000); // staggered start

  switch (type) {
    case "listener":
      await doStream(userId);
      await doStream(userId);
      await doStream(userId);
      break;

    case "searcher":
      await doAutocomplete(userId);
      await doSearch(userId);
      await doStream(userId);
      await doSearch(userId);
      await doStream(userId);
      break;

    case "mp3_dl":
      await doSearch(userId);
      await doMp3Download(userId);
      await doMp3Download(userId);
      break;

    case "mp4_dl":
      await doSearch(userId);
      await doMp4Download(userId);
      break;

    case "video_watch":
      await doSearch(userId);
      await doVideoStream(userId);
      await doVideoStream(userId);
      break;

    case "mixed":
      await doTop50(userId);
      await doSearch(userId);
      await doStream(userId);
      await doMp3Download(userId);
      await doVideoStream(userId);
      await doAutocomplete(userId);
      break;
  }
}

// ---------- Rapor ----------

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx    = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function avg(arr) {
  return arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(0) : 0;
}

function printReport(elapsed) {
  const line = "─".repeat(55);
  console.log(`\n${line}`);
  console.log(`  LOAD TEST SONUÇLARI`);
  console.log(line);
  console.log(`  Eşzamanlı kullanıcı : ${CONCURRENT}`);
  console.log(`  Toplam istek        : ${stats.total}`);
  console.log(`  Başarılı            : ${stats.success}  (%${((stats.success / stats.total) * 100).toFixed(1)})`);
  console.log(`  Başarısız           : ${stats.failed}`);
  console.log(`  Toplam süre         : ${elapsed}s`);
  console.log();
  console.log(`  Gecikme (tüm istekler)`);
  console.log(`    Ortalama : ${avg(stats.latencies)}ms`);
  console.log(`    P50      : ${percentile(stats.latencies, 50)}ms`);
  console.log(`    P90      : ${percentile(stats.latencies, 90)}ms`);
  console.log(`    P99      : ${percentile(stats.latencies, 99)}ms`);
  console.log(`    Max      : ${Math.max(...stats.latencies)}ms`);
  console.log();
  console.log(`  Endpoint bazında:`);
  const pad = 15;
  console.log(`  ${"Endpoint".padEnd(pad)} | OK   | FAIL | Ort(ms) | P90(ms)`);
  console.log(`  ${"─".repeat(pad)}-+------+------+---------+--------`);
  for (const [name, s] of Object.entries(stats.byEndpoint)) {
    const total = s.ok + s.fail;
    const rate  = total ? `${((s.ok / total) * 100).toFixed(0)}%` : "—";
    console.log(
      `  ${name.padEnd(pad)} | ${String(s.ok).padStart(4)} | ${String(s.fail).padStart(4)} | ${String(avg(s.latencies)).padStart(7)} | ${String(percentile(s.latencies, 90)).padStart(7)}`
    );
  }

  if (stats.errors.length) {
    console.log(`\n  İlk 10 hata:`);
    stats.errors.slice(0, 10).forEach(e => console.log(`    ${e}`));
  }
  console.log(line + "\n");
}

// ---------- Ana akış ----------

async function main() {
  console.log(`\n🚀 Load Test Başlıyor`);
  console.log(`👥 Eşzamanlı kullanıcı : ${CONCURRENT}`);
  console.log(`🌐 Hedef               : ${BASE_URL}`);
  console.log(`📋 Senaryo dağılımı    : dinle / ara / mp3 / mp4 / video / karışık`);
  console.log(`${"─".repeat(55)}\n`);

  const t0    = Date.now();
  const users = Array.from({ length: CONCURRENT }, (_, i) => simulateUser(i + 1));
  await Promise.all(users);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  printReport(elapsed);
}

main().catch(console.error);
