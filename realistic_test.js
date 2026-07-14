/**
 * GERÇEKÇİ YÜK TESTİ — "indir-kapat" modeli
 * ------------------------------------------------------------------
 * Kullanıcı davranışı: aç → /config → /top50 (ülke) → (bazen) /search
 *                      → 1 mp3 indir → kapat. Sonra yeni kullanıcı gelir.
 *
 * Kullanım:
 *   node realistic_test.js                         → GÜVENLİ mod, 50 eşzamanlı, 30 sn
 *   node realistic_test.js 100 60                  → 100 eşzamanlı, 60 sn (güvenli)
 *   node realistic_test.js 200 60 stress           → STRES modu (DİKKAT: bazocam kotasını yakar!)
 *
 * GÜVENLİ mod: küçük, popüler videoId seti → ilk birkaç indirme backend cache'ini doldurur,
 *   gerisi CACHE'ten gelir. Yani serving + VPS CPU + eşzamanlılık ölçülür, kota neredeyse yanmaz.
 * STRES mod: her istekte BENZERSİZ videoId → her biri gerçek çözümleme (yt-dlp/bazocam) tetikler.
 *   Gerçek çözümleme tavanını ölçer AMA upstream kotayı ve proxy'leri tüketir. Dikkatli kullan.
 *
 * NOT: Medya (indirme/stream) isteklerinde tüm dosya İNDİRİLMEZ — ilk bayt gelince
 *      bağlantı kapatılır (TTFB ölçülür). Böylece test makinesinin bandwidth'i darboğaz olmaz,
 *      backend'in yük altında "yanıt verebilme" kapasitesi ölçülür.
 */

const https  = require("https");
const crypto = require("crypto");

const BASE_URL   = process.env.BASE_URL || "https://music.cevapla.tv";
const APP_SECRET = process.env.APP_KEY || "RINGTONE_MASTER_V2_SECRET_2026";
const CONCURRENT = parseInt(process.argv[2]) || 50;
const DURATION_S = parseInt(process.argv[3]) || 30;
const MODE       = (process.argv[4] || "safe").toLowerCase(); // "safe" | "stress"
const REQ_TIMEOUT = 25000;

// GÜVENLİ mod için küçük popüler set (ilk indirmelerden sonra cache'ten gelir)
const SAFE_IDS = [
  "dQw4w9WgXcQ", "kJQP7kiw5Fk", "9bZkp7q19f0", "OPf0YbXqDm0",
  "hT_nvWreIhg", "JGwWNGJdvx8", "RgKAFK5djSk", "CevxZvSJLk8",
];
const SEARCH_TERMS = ["eminem", "tarkan", "dua lipa", "sezen aksu", "the weeknd", "müslüm gürses"];
const COUNTRIES    = ["TR", "US", "DE", "AZ", "NL"];

const stats = { sessions: 0, total: 0, ok: 0, fail: 0, byEndpoint: {}, latAll: [] };
let running = true;

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function authHeaders(pathname, country) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac("sha256", APP_SECRET).update(ts + ":" + pathname).digest("base64");
  const h = { "X-Timestamp": ts, "X-Signature": sig, "User-Agent": "RealisticTest/1.0" };
  if (country) h["X-Country"] = country;
  return h;
}

// abortOnFirstByte=true → ilk bayt gelince kapat (medya için, TTFB ölçer)
function req(fullUrl, label, country, abortOnFirstByte) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const u = new URL(fullUrl);
    const options = {
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method: "GET",
      timeout: REQ_TIMEOUT,
      headers: authHeaders(u.pathname, country),
    };
    const r = https.request(options, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 400;
      if (abortOnFirstByte) {
        res.once("data", () => { res.destroy(); resolve({ ok, status: res.statusCode, ms: Date.now() - t0, label }); });
        res.once("end", () => resolve({ ok, status: res.statusCode, ms: Date.now() - t0, label }));
      } else {
        res.on("data", () => {});
        res.on("end", () => resolve({ ok, status: res.statusCode, ms: Date.now() - t0, label }));
      }
    });
    r.on("error", e => resolve({ ok: false, status: 0, ms: Date.now() - t0, label, error: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ ok: false, status: 0, ms: REQ_TIMEOUT, label, error: "timeout" }); });
    r.end();
  });
}

function record(res) {
  stats.total++;
  const e = stats.byEndpoint[res.label] || (stats.byEndpoint[res.label] = { ok: 0, fail: 0, lat: [] });
  if (res.ok) { stats.ok++; e.ok++; } else { stats.fail++; e.fail++; }
  e.lat.push(res.ms); stats.latAll.push(res.ms);
}

// Tek kullanıcının "indir-kapat" oturumu
async function session(uniqueCounter) {
  const country = pick(COUNTRIES);
  record(await req(`${BASE_URL}/config`, "config", country));
  record(await req(`${BASE_URL}/top50`, "top50", country));
  if (Math.random() < 0.4) {
    record(await req(`${BASE_URL}/search?q=${encodeURIComponent(pick(SEARCH_TERMS))}`, "search", country));
    await sleep(200 + Math.random() * 400);
  }
  // İndirme (indir-kapat'ın ana eylemi)
  const id = MODE === "stress"
    ? `test_${uniqueCounter}_${Math.random().toString(36).slice(2, 8)}`  // benzersiz → gerçek çözümleme
    : pick(SAFE_IDS);                                                     // popüler → cache
  record(await req(`${BASE_URL}/download/mp3?videoId=${id}`, "download/mp3", country, true));
  stats.sessions++;
}

// Kapalı-döngü işçi: süre bitene kadar oturum üstüne oturum çalıştırır
async function worker(id) {
  let c = 0;
  while (running) {
    try { await session(id * 100000 + (c++)); } catch (_) {}
    await sleep(100 + Math.random() * 300); // kullanıcı düşünme payı
  }
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p / 100))];
}

function report() {
  const dur = DURATION_S;
  console.log("\n" + "=".repeat(60));
  console.log(`SONUÇ — mod=${MODE.toUpperCase()} | eşzamanlı=${CONCURRENT} | süre=${dur}s`);
  console.log("=".repeat(60));
  console.log(`Tamamlanan oturum : ${stats.sessions}  (${(stats.sessions / dur).toFixed(1)} oturum/sn)`);
  console.log(`Toplam istek      : ${stats.total}  (${(stats.total / dur).toFixed(1)} istek/sn)`);
  const rate = stats.total ? (100 * stats.ok / stats.total).toFixed(1) : 0;
  console.log(`Başarı oranı      : %${rate}  (ok=${stats.ok}, hata=${stats.fail})`);
  console.log(`Gecikme (tüm)     : p50=${pct(stats.latAll,50)}ms  p90=${pct(stats.latAll,90)}ms  p99=${pct(stats.latAll,99)}ms`);
  console.log("-".repeat(60));
  for (const [k, v] of Object.entries(stats.byEndpoint)) {
    console.log(`${k.padEnd(14)} ok=${String(v.ok).padStart(5)} hata=${String(v.fail).padStart(4)} | p50=${pct(v.lat,50)}ms p90=${pct(v.lat,90)}ms p99=${pct(v.lat,99)}ms`);
  }
  console.log("=".repeat(60));
}

async function main() {
  console.log(`\n▶ Gerçekçi yük testi başlıyor`);
  console.log(`  Hedef: ${BASE_URL}`);
  console.log(`  Mod: ${MODE.toUpperCase()} | Eşzamanlı kullanıcı: ${CONCURRENT} | Süre: ${DURATION_S}s`);
  if (MODE === "stress") {
    console.log(`  ⚠️  STRES MODU: benzersiz ID'ler → gerçek çözümleme → bazocam kotasını/proxy'leri tüketir!`);
  } else {
    console.log(`  ✓ GÜVENLİ MOD: popüler ID seti → çoğu istek cache'ten, kota neredeyse yanmaz.`);
  }
  console.log("");

  const workers = [];
  for (let i = 0; i < CONCURRENT; i++) workers.push(worker(i));

  // Her 5 sn'de canlı özet
  const ticker = setInterval(() => {
    process.stdout.write(`  … ${stats.sessions} oturum | ${stats.total} istek | %${stats.total ? (100*stats.ok/stats.total).toFixed(0) : 0} başarı\n`);
  }, 5000);

  await sleep(DURATION_S * 1000);
  running = false;
  clearInterval(ticker);
  await sleep(REQ_TIMEOUT + 500); // uçan istekler bitsin
  report();
  process.exit(0);
}

main();
