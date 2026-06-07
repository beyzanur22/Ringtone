/**
 * STRESS TEST — 200 Kullanıcı Simülasyonu
 *
 * Her kullanıcı farklı şarkı ile:
 *   1. Audio stream (şarkı dinleme)
 *   2. MP3 indirme
 *   3. Video stream (video izleme)
 *   4. MP4 indirme
 *
 * Kullanım:
 *   node stress_test.js              → 200 kullanıcı (varsayılan)
 *   node stress_test.js 50           → 50 kullanıcı
 *   node stress_test.js 200 remote   → sunucuda test (music.cevapla.tv)
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");

// ═══════════════════════════════════════
//  YAPILANDIRMA
// ═══════════════════════════════════════
const USER_COUNT = parseInt(process.argv[2]) || 200;
const TARGET = process.argv[3] === "remote" ? "https://music.cevapla.tv" : "http://localhost:5000";
const APP_SECRET = process.env.APP_KEY || "RINGTONE_MASTER_V2_SECRET_2026";

// 200 farklı popüler şarkı ID'si (her kullanıcı farklı şarkı açacak)
const VIDEO_IDS = [
  "dQw4w9WgXcQ", "9bZkp7q19f0", "kJQP7kiw5Fk", "RgKAFK5djSk", "JGwWNGJdvx8",
  "OPf0YbXqDm0", "hT_nvWreIhg", "CevxZvSJLk8", "YQHsXMglC9A", "fRh_vgS2dFE",
  "bo_efYhYU2A", "7PCkvCPvDXk", "lp-EO5I60KA", "60ItHLz5WEA", "e-ORhEE9VVg",
  "HP-MbfHFUqs", "pRpeEdMmmQ0", "GtL1huin9EE", "uelHwf8o7_U", "DyDfgMOUjCI",
  "nfs8NYg7yQM", "SlPhMPnQ58k", "QYh6mYIJG2Y", "2Vv-BfVoq4g", "Zi_XLOBDo_Y",
  "IcrbM1l_BoI", "TUVcZfQe-Kw", "aJOTlE1K90k", "yWLdOlOPHUQ", "L0MK7qz13bU",
  "yzTuBuRdAyA", "wMehItNQKAA", "FuXNumBwDOM", "hHW1oY26kxQ", "lWA2pjMjpBs",
  "PIh2xe4jnpk", "DeumyOzKqgI", "qfVuRQX0ydQ", "50VNCymT-Cs", "0yW7w8F2TVA",
  "BqvUkmnGAhc", "F57P9C4SAW4", "btPJPFnesV4", "n1WpP7iowLc", "3tmd-ClpJxA",
  "NUsoVlDFqZg", "DHjqpvDnNGE", "F4neLzQC0Bk", "6Ejga4kJUts", "KQ6zr6kCPj8",
  "g4mHPeMGTJM", "rYEDA3JcQqw", "LsoLEjrDogU", "0KSOMA3QBU0", "Yw6u6YkTgQ4",
  "XqZsoesa55w", "YR12Z8f1Dh8", "QcIy9NiNbmo", "papuvlVeZg8", "gCYcHz2k5x0",
  "wnJ6LuUFpMo", "BaW_jenozKc", "fJ9rUzIMcZQ", "vp1HVg_J7QA", "N_qFfQ4xP3Q",
  "MLrC7e3vSv8", "q0hyYWKXF0Q", "kOkQ4T5WO9E", "eY52Zsg-KVI", "8EJ3zbKTWQ8",
  "EPo5wWmKEaI", "nSDgHBxUbVQ", "wOwblaKmyVw", "V5M2WnxyKkQ", "uxpDa-c-4Mc",
  "z3wAjJXbYzA", "vCadcBR95oU", "rYEDA3JcQqw", "pUjE9H8QlA4", "OpQFFLBMEPI",
  "09R8_2nJtjg", "0-EF60neguk", "cE0wfjsybIQ", "k4V3Mo61fJM", "dj2BjhEg28M",
  "0O2aH4XLbto", "jofNR_WkoCE", "J_ub7Etch2U", "ebXbLfLACGM", "ZbZSe6N_BXs",
  "pNdO95XfJ8I", "R9OHn5ZF4Uo", "gHcDlE67xQY", "WxzAls4GKDo", "xFrGuyw1V8s",
  "hBwCqsKDQ4E", "M11SvDtPBhA", "MWO4VkuUDhg", "SmlKh_7lOVg", "XnbCSboujA4",
  // 100-200 arası
  "iPUmE-tne5U", "oyEuk8j8imI", "5GL9JoH4Sws", "HjqTVS3gAEY", "nIjVLoEbSjc",
  "pBkHHoOIIn8", "bM7SZ5SBzyY", "HGy9i8vvx_c", "Kp7eSUQIPRo", "NHZiV6lTaGs",
  "tg00YEETFzg", "PfYnvDL0Qcw", "1k8craCGpgs", "KCy7lLQwToI", "JRfuAukYTKg",
  "GrAchTdepsU", "QK8mJJJvaes", "AB2emGz0tTs", "B9FzVhw8_bY", "eJO5HU_7_1w",
  "gdZLi9oWNZg", "2vjPBrBU-TM", "W3GrSMYbkBE", "pvKUttKeMGY", "KI_0tQnx1DQ",
  "HSz1PoMYp0Q", "Ic8lxBLARLY", "lYBUbBu4W08", "Nrnq4SZ3c9o", "1mEKN0fTrOs",
  "f1yrgkL_D8c", "0JKXB9Iqd30", "S_E2EIoQfmY", "DkeiKbqa02I", "YV5KAbV34NU",
  "kTcRRaXV-fg", "lWA2pjMjpBs", "QsFjfcwLDng", "DmeUuoxyt_E", "w2Ov5jzm3j8",
  "M11SvDtPBhA", "K4DyBUG242c", "YnopHCL1Jk8", "OjNpRbNdR7E", "CX11yw6YL1w",
  "iS1g8G_njx8", "QdBZY2fkU-0", "psuRGfAaju4", "4NRXx6U8ABQ", "VYOjWnS4cMY",
  "SiAuAJBZuGs", "7wtfhZwyrcc", "lXMskKTw3Bc", "TdrL3QxjyVw", "FkUn86bH34M",
  "5IpYOF4Hi6Q", "sTSA_sQ2K3s", "kGdVMu_wbXI", "0HDdjwpPM3Y", "VFZNvj-HfBU",
  "k2qgadSvNyU", "JFm7YDVlqnI", "sZfZ8uWaOFo", "MzPLdfKOWPU", "YBHQbu5rbdQ",
  "Hwvf_IEz3FQ", "qQrdKta70F4", "e82VE8UtW8A", "nfs8NYg7yQM", "2vjPBrBU-TM",
  "r7qovpFAGrQ", "2lAe1cqCOXo", "hLQl3WQQoQ0", "7jMlFXGPJ3Q", "0J2QdDbelmY",
  "Lrj2Hq7xqQ8", "eVTXPUF4Oz4", "jDnhq8RMZDE", "ru0K8uYEZWw", "BN1WwnEDWAM",
  "8UVNT4wvIGY", "mqiH0ZSkM9I", "LXb3EKWsInQ", "1lyu1KKwC74", "VbfpW0pbvaU"
];

// ═══════════════════════════════════════
//  HMAC AUTH
// ═══════════════════════════════════════
function generateAuth(path) {
  const timestamp = Date.now().toString();
  const payload = timestamp + ":" + path;
  const signature = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64");
  return { "X-Timestamp": timestamp, "X-Signature": signature };
}

// ═══════════════════════════════════════
//  HTTP İSTEK HELPER
// ═══════════════════════════════════════
function makeRequest(urlPath, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const fullUrl = TARGET + urlPath;
    const isHttps = fullUrl.startsWith("https");
    const mod = isHttps ? https : http;
    const authHeaders = generateAuth(urlPath.split("?")[0]);

    const urlObj = new URL(fullUrl);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      timeout: timeoutMs,
      headers: {
        ...authHeaders,
        "X-Country": "TR",
        "User-Agent": "StressTest/1.0"
      }
    };

    const req = mod.request(options, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; });
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          bytes,
          timeMs: Date.now() - startTime,
          success: res.statusCode >= 200 && res.statusCode < 400
        });
      });
      res.on("error", () => {
        resolve({ status: 0, bytes: 0, timeMs: Date.now() - startTime, success: false, error: "response_error" });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, bytes: 0, timeMs: Date.now() - startTime, success: false, error: "timeout" });
    });

    req.on("error", (err) => {
      resolve({ status: 0, bytes: 0, timeMs: Date.now() - startTime, success: false, error: err.code || err.message });
    });

    req.end();
  });
}

// ═══════════════════════════════════════
//  TEK KULLANICI SİMÜLASYONU
// ═══════════════════════════════════════
async function simulateUser(userId, videoId) {
  const results = {};
  const userTag = `User-${String(userId).padStart(3, "0")}`;

  // 1) Audio Stream (şarkı dinleme)
  console.log(`[${userTag}] 🎵 Audio stream: ${videoId}`);
  results.audioStream = await makeRequest(`/stream?videoId=${videoId}&type=audio`, 90000);

  // Kısa bekleme (gerçek kullanıcı davranışı)
  await sleep(500 + Math.random() * 1500);

  // 2) MP3 İndirme
  console.log(`[${userTag}] 📥 MP3 download: ${videoId}`);
  results.mp3Download = await makeRequest(`/download/mp3?videoId=${videoId}&kbps=128`, 120000);

  await sleep(500 + Math.random() * 1500);

  // 3) Video Stream (video izleme)
  console.log(`[${userTag}] 🎬 Video stream: ${videoId}`);
  results.videoStream = await makeRequest(`/stream/video?videoId=${videoId}`, 120000);

  await sleep(500 + Math.random() * 1500);

  // 4) MP4 İndirme
  console.log(`[${userTag}] 📥 MP4 download: ${videoId}`);
  results.mp4Download = await makeRequest(`/download/mp4?videoId=${videoId}`, 120000);

  return { userId, videoId, results };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════
//  ANA TEST
// ═══════════════════════════════════════
async function runStressTest() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log(`║  STRESS TEST — ${USER_COUNT} Kullanıcı × 4 İşlem = ${USER_COUNT * 4} İstek    `);
  console.log(`║  Hedef: ${TARGET}`);
  console.log(`║  Her kullanıcı: audio + mp3 + video + mp4 indirme    ║`);
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log();

  // Health check
  console.log("[PREP] Sunucu kontrol ediliyor...");
  const health = await makeRequest("/health", 10000);
  if (!health.success) {
    console.error("❌ Sunucu yanıt vermiyor! Test iptal.");
    process.exit(1);
  }
  console.log("✅ Sunucu aktif\n");

  // Kullanıcıları dalga dalga gönder (50'şerli gruplar — sunucuyu aniden boğmamak için)
  const WAVE_SIZE = 50;
  const waves = Math.ceil(USER_COUNT / WAVE_SIZE);
  const allResults = [];
  const globalStart = Date.now();

  for (let wave = 0; wave < waves; wave++) {
    const waveStart = wave * WAVE_SIZE;
    const waveEnd = Math.min(waveStart + WAVE_SIZE, USER_COUNT);
    const waveUsers = waveEnd - waveStart;

    console.log(`\n══════ DALGA ${wave + 1}/${waves} — ${waveUsers} kullanıcı gönderiliyor ══════`);

    const wavePromises = [];
    for (let i = waveStart; i < waveEnd; i++) {
      const videoId = VIDEO_IDS[i % VIDEO_IDS.length];
      // Her kullanıcıyı 0-2sn arası rastgele gecikmeyle başlat (daha gerçekçi)
      const delay = Math.random() * 2000;
      wavePromises.push(
        sleep(delay).then(() => simulateUser(i, videoId))
      );
    }

    const waveResults = await Promise.all(wavePromises);
    allResults.push(...waveResults);

    // Dalgalar arası 3sn bekleme
    if (wave < waves - 1) {
      console.log(`\n⏳ Sonraki dalga için 3 saniye bekleniyor...`);
      await sleep(3000);
    }
  }

  // ═══════════════════════════════════════
  //  SONUÇ RAPORU
  // ═══════════════════════════════════════
  const totalTime = ((Date.now() - globalStart) / 1000).toFixed(1);

  const endpoints = ["audioStream", "mp3Download", "videoStream", "mp4Download"];
  const labels = {
    audioStream: "🎵 Audio Stream",
    mp3Download: "📥 MP3 Download",
    videoStream: "🎬 Video Stream",
    mp4Download: "📥 MP4 Download"
  };

  console.log("\n");
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║                    📊 STRESS TEST SONUÇLARI                  ║");
  console.log("╠═══════════════════════════════════════════════════════════════╣");
  console.log(`║  Toplam süre: ${totalTime}s | Kullanıcı: ${USER_COUNT} | Toplam istek: ${USER_COUNT * 4}`);
  console.log("╠═══════════════════════════════════════════════════════════════╣");

  let totalSuccess = 0;
  let totalFail = 0;

  for (const ep of endpoints) {
    const results = allResults.map(r => r.results[ep]).filter(Boolean);
    const success = results.filter(r => r.success).length;
    const fail = results.length - success;
    const times = results.filter(r => r.success).map(r => r.timeMs);
    const avgTime = times.length ? (times.reduce((a, b) => a + b, 0) / times.length / 1000).toFixed(1) : "-";
    const maxTime = times.length ? (Math.max(...times) / 1000).toFixed(1) : "-";
    const minTime = times.length ? (Math.min(...times) / 1000).toFixed(1) : "-";
    const totalBytes = results.filter(r => r.success).reduce((a, r) => a + r.bytes, 0);
    const avgMB = times.length ? (totalBytes / times.length / 1024 / 1024).toFixed(2) : "-";
    const pct = ((success / results.length) * 100).toFixed(0);

    totalSuccess += success;
    totalFail += fail;

    // Hata detayları
    const errors = {};
    results.filter(r => !r.success).forEach(r => {
      const key = r.error || `HTTP_${r.status}`;
      errors[key] = (errors[key] || 0) + 1;
    });

    console.log("║");
    console.log(`║  ${labels[ep]}`);
    console.log(`║    Başarı: ${success}/${results.length} (%${pct})`);
    console.log(`║    Süre:  min=${minTime}s | ort=${avgTime}s | max=${maxTime}s`);
    console.log(`║    Boyut: ort=${avgMB} MB`);
    if (Object.keys(errors).length > 0) {
      console.log(`║    Hatalar: ${JSON.stringify(errors)}`);
    }
  }

  const overallPct = ((totalSuccess / (totalSuccess + totalFail)) * 100).toFixed(1);
  console.log("╠═══════════════════════════════════════════════════════════════╣");
  console.log(`║  GENEL: ${totalSuccess}/${totalSuccess + totalFail} başarılı (%${overallPct})`);
  console.log(`║  RPS: ${((totalSuccess + totalFail) / parseFloat(totalTime)).toFixed(1)} istek/saniye`);
  console.log("╚═══════════════════════════════════════════════════════════════╝");

  // Değerlendirme
  console.log("\n📋 DEĞERLENDİRME:");
  if (parseFloat(overallPct) >= 90) {
    console.log("✅ MÜKEMMEL — Sunucu yükü kaldırıyor!");
  } else if (parseFloat(overallPct) >= 70) {
    console.log("⚠️  KABUL EDİLEBİLİR — Bazı istekler başarısız ama çoğu çalışıyor.");
  } else if (parseFloat(overallPct) >= 40) {
    console.log("🟡 ZAYIF — Ciddi optimizasyon gerekli.");
  } else {
    console.log("🔴 KRİTİK — Sunucu bu yükü kaldıramıyor! Acil iyileştirme şart.");
  }
}

runStressTest().catch(err => {
  console.error("Test hatası:", err);
  process.exit(1);
});
