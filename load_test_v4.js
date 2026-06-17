/**
 * MELODIA YUK TESTI v4 — MP3 + MP4 + Search + Download
 *
 * 4 senaryo test eder:
 * 1. Arama yap
 * 2. MP3 stream (dinleme)
 * 3. MP4 stream (izleme)
 * 4. MP3 indirme
 *
 * Kullanim: node load_test_v4.js [kullanici_sayisi]
 * Ornek:    node load_test_v4.js 50
 */

const BASE_URL = "https://music.cevapla.tv";
const TOTAL_USERS = parseInt(process.argv[2]) || 50;
const APP_SECRET = "RINGTONE_MASTER_V2_SECRET_2026";
const crypto = require("crypto");

const SEARCH_QUERIES = [
  "tarkan", "sezen aksu", "eminem", "drake", "the weeknd",
  "billie eilish", "dua lipa", "ed sheeran", "adele", "bruno mars",
  "sefo", "mabel matiz", "ezhel", "duman", "manga",
  "coldplay", "linkin park", "arctic monkeys", "queen", "nirvana",
  "hadise", "ibrahim tatlises", "baris manco", "sagopa kajmer", "ceza"
];

function getAuthHeaders(path) {
  const timestamp = Date.now().toString();
  const payload = timestamp + ":" + path;
  const signature = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64");
  return { "x-timestamp": timestamp, "x-signature": signature };
}

const stats = {
  search:   { success: 0, failed: 0, times: [] },
  mp3:      { success: 0, failed: 0, times: [], details: [] },
  mp4:      { success: 0, failed: 0, times: [], details: [] },
  download: { success: 0, failed: 0, times: [], details: [] },
  startTime: Date.now(),
  concurrent: { current: 0, max: 0 }
};

function statusLabel(ms) {
  if (ms < 1000) return "CACHE";
  if (ms < 5000) return "HIZLI";
  if (ms < 15000) return "ORTA";
  return "YAVAS";
}

async function simulateUser(userId) {
  const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
  const action = Math.random();
  // %40 mp3 dinle, %20 mp4 izle, %20 mp3 indir, %20 sadece arama
  const mode = action < 0.4 ? "mp3" : action < 0.6 ? "mp4" : action < 0.8 ? "download" : "search_only";

  // ARAMA
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

  if (searchResults.length === 0 || mode === "search_only") return;

  await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

  const videoIds = searchResults.slice(0, 5).map(item => {
    const id = item.id || "";
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    return "";
  }).filter(Boolean);

  if (videoIds.length === 0) return;
  const videoId = videoIds[Math.floor(Math.random() * videoIds.length)];

  stats.concurrent.current++;
  if (stats.concurrent.current > stats.concurrent.max) stats.concurrent.max = stats.concurrent.current;

  const elapsed = () => ((Date.now() - stats.startTime) / 1000).toFixed(0);

  try {
    if (mode === "mp3") {
      const start = Date.now();
      const resp = await fetch(`${BASE_URL}/stream?videoId=${videoId}`, {
        headers: getAuthHeaders("/stream"),
        signal: AbortSignal.timeout(60000)
      });
      const time = Date.now() - start;
      stats.mp3.times.push(time);
      if (resp.ok && resp.body) {
        const reader = resp.body.getReader();
        await reader.read();
        reader.cancel();
        stats.mp3.success++;
        const s = statusLabel(time);
        stats.mp3.details.push({ userId, query, videoId, time, status: s });
        console.log(`[${elapsed()}s] MP3  ${s.padEnd(5)} User${String(userId).padStart(3)} "${query}" > ${videoId} (${(time/1000).toFixed(1)}s) [${stats.concurrent.current} esz.]`);
      } else {
        stats.mp3.failed++;
        console.log(`[${elapsed()}s] MP3  FAIL  User${userId} "${query}" > ${videoId} (${resp.status})`);
      }

    } else if (mode === "mp4") {
      const start = Date.now();
      const resp = await fetch(`${BASE_URL}/stream/video?videoId=${videoId}`, {
        headers: getAuthHeaders("/stream/video"),
        signal: AbortSignal.timeout(60000)
      });
      const time = Date.now() - start;
      stats.mp4.times.push(time);
      if (resp.ok && resp.body) {
        const reader = resp.body.getReader();
        await reader.read();
        reader.cancel();
        stats.mp4.success++;
        const s = statusLabel(time);
        stats.mp4.details.push({ userId, query, videoId, time, status: s });
        console.log(`[${elapsed()}s] MP4  ${s.padEnd(5)} User${String(userId).padStart(3)} "${query}" > ${videoId} (${(time/1000).toFixed(1)}s) [${stats.concurrent.current} esz.]`);
      } else {
        stats.mp4.failed++;
        console.log(`[${elapsed()}s] MP4  FAIL  User${userId} "${query}" > ${videoId} (${resp.status})`);
      }

    } else if (mode === "download") {
      const start = Date.now();
      const resp = await fetch(`${BASE_URL}/download/mp3?videoId=${videoId}&title=test&bitrate=128`, {
        headers: getAuthHeaders("/download/mp3"),
        signal: AbortSignal.timeout(60000)
      });
      const time = Date.now() - start;
      stats.download.times.push(time);
      if (resp.ok && resp.body) {
        const reader = resp.body.getReader();
        await reader.read();
        reader.cancel();
        stats.download.success++;
        const s = statusLabel(time);
        stats.download.details.push({ userId, query, videoId, time, status: s });
        console.log(`[${elapsed()}s] DL   ${s.padEnd(5)} User${String(userId).padStart(3)} "${query}" > ${videoId} (${(time/1000).toFixed(1)}s) [${stats.concurrent.current} esz.]`);
      } else {
        stats.download.failed++;
        console.log(`[${elapsed()}s] DL   FAIL  User${userId} "${query}" > ${videoId} (${resp.status})`);
      }
    }
  } catch (e) {
    const cat = mode === "mp4" ? stats.mp4 : mode === "download" ? stats.download : stats.mp3;
    cat.failed++;
    console.log(`[${elapsed()}s] ${mode.toUpperCase().padEnd(4)} TMOUT User${userId} "${query}" > ${videoId}`);
  } finally {
    stats.concurrent.current--;
  }
}

function avg(arr) {
  return arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length / 1000).toFixed(1) : "—";
}

function printReport() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const totalOps = stats.mp3.success + stats.mp3.failed + stats.mp4.success + stats.mp4.failed + stats.download.success + stats.download.failed;
  const totalSuccess = stats.mp3.success + stats.mp4.success + stats.download.success;
  const rate = totalOps > 0 ? ((totalSuccess / totalOps) * 100).toFixed(1) : "0";

  console.log("\n" + "=".repeat(65));
  console.log(`  MELODIA YUK TESTI v4 — ${TOTAL_USERS} Kullanici`);
  console.log("=".repeat(65));
  console.log(`  Sure: ${elapsed}s | Max eszamanli: ${stats.concurrent.max}`);
  console.log("-".repeat(65));
  console.log(`  ARAMA     ${String(stats.search.success).padStart(4)} basarili  ${String(stats.search.failed).padStart(4)} basarisiz  ort: ${avg(stats.search.times)}s`);
  console.log(`  MP3       ${String(stats.mp3.success).padStart(4)} basarili  ${String(stats.mp3.failed).padStart(4)} basarisiz  ort: ${avg(stats.mp3.times)}s`);
  console.log(`  MP4       ${String(stats.mp4.success).padStart(4)} basarili  ${String(stats.mp4.failed).padStart(4)} basarisiz  ort: ${avg(stats.mp4.times)}s`);
  console.log(`  INDIRME   ${String(stats.download.success).padStart(4)} basarili  ${String(stats.download.failed).padStart(4)} basarisiz  ort: ${avg(stats.download.times)}s`);
  console.log("-".repeat(65));
  console.log(`  TOPLAM    ${totalSuccess}/${totalOps} basarili (%${rate})`);
  console.log("-".repeat(65));

  const allDetails = [...stats.mp3.details, ...stats.mp4.details, ...stats.download.details];
  const cache = allDetails.filter(d => d.status === "CACHE").length;
  const fast = allDetails.filter(d => d.status === "HIZLI").length;
  const medium = allDetails.filter(d => d.status === "ORTA").length;
  const slow = allDetails.filter(d => d.status === "YAVAS").length;

  console.log(`  <1s cache: ${cache} | 1-5s hizli: ${fast} | 5-15s orta: ${medium} | >15s yavas: ${slow}`);

  if (parseFloat(rate) >= 90) console.log("\n  MUKEMMEL — Sistem bu yuku rahat kaldiriyor.");
  else if (parseFloat(rate) >= 70) console.log("\n  IYI — Cogu kullanici sorunsuz, bazilari gecikiyor.");
  else if (parseFloat(rate) >= 50) console.log("\n  ORTA — Sistem zorlaniyor.");
  else console.log("\n  KOTU — Sistem bu yuku kaldiramiyor.");
  console.log("=".repeat(65));
}

async function main() {
  console.log("=".repeat(65));
  console.log(`  MELODIA YUK TESTI v4 — ${TOTAL_USERS} Kullanici`);
  console.log(`  Hedef: ${BASE_URL}`);
  console.log(`  Mod: %40 MP3 | %20 MP4 | %20 Indirme | %20 Sadece Arama`);
  console.log("=".repeat(65));
  console.log("");

  const users = [];
  for (let i = 0; i < TOTAL_USERS; i++) {
    await new Promise(r => setTimeout(r, Math.random() * 300));
    users.push(simulateUser(i + 1));
  }

  await Promise.all(users);
  printReport();
}

main().catch(console.error);
