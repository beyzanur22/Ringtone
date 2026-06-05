/**
 * Media Library — Cluster-Safe Veritabanı
 *
 * PM2 cluster mode (4 instance) için güvenli:
 * - Okuma: her worker bellekten okur (hızlı)
 * - Yazma: sadece Worker 0 diske yazar
 * - Senkronizasyon: Worker 0 her 30 saniyede diske yazar,
 *   diğer worker'lar her 60 saniyede diskten okur (eventual consistency)
 */

const fs = require("fs");
const path = require("path");
const DB_FILE = path.join(__dirname, "media_db.json");
const SAVE_INTERVAL = 30 * 1000;
const SYNC_INTERVAL = 60 * 1000;

let db = { tracks: {}, stats: { totalProcessed: 0, totalFailed: 0 } };
let dirty = false;

const WORKER_ID = parseInt(process.env.NODE_APP_INSTANCE || process.env.pm_id || "0");
const isPrimaryWorker = WORKER_ID === 0;

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf-8");
      db = JSON.parse(raw);
      console.log(`[MEDIA_LIB] Worker ${WORKER_ID}: ${Object.keys(db.tracks).length} şarkı yüklendi`);
    } else {
      console.log("[MEDIA_LIB] Yeni veritabanı oluşturuldu");
      saveDB();
    }
  } catch (err) {
    console.error(`[MEDIA_LIB] DB yükleme hatası: ${err.message}`);
    db = { tracks: {}, stats: { totalProcessed: 0, totalFailed: 0 } };
  }
}

function saveDB() {
  if (!isPrimaryWorker) return;
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    dirty = false;
  } catch (err) {
    console.error(`[MEDIA_LIB] DB kaydetme hatası: ${err.message}`);
  }
}

loadDB();

if (isPrimaryWorker) {
  setInterval(() => { if (dirty) saveDB(); }, SAVE_INTERVAL);
} else {
  setInterval(() => { loadDB(); }, SYNC_INTERVAL);
}

function upsertTrack(videoId, data) {
  const existing = db.tracks[videoId] || {};
  db.tracks[videoId] = {
    videoId,
    title: data.title || existing.title || "Unknown",
    artist: data.artist || existing.artist || "Unknown",
    duration: data.duration || existing.duration || 0,
    thumbnail: data.thumbnail || existing.thumbnail || null,
    files: {
      m4a: data.m4a || existing.files?.m4a || null,
      mp3: data.mp3 || existing.files?.mp3 || null,
      mp4: data.mp4 || existing.files?.mp4 || null
    },
    fileSize: {
      m4a: data.m4aSize || existing.fileSize?.m4a || 0,
      mp3: data.mp3Size || existing.fileSize?.mp3 || 0,
      mp4: data.mp4Size || existing.fileSize?.mp4 || 0
    },
    status: data.status || existing.status || "processing",
    source: data.source || existing.source || "youtube",
    category: data.category || existing.category || "streaming",
    processedAt: data.processedAt || existing.processedAt || null,
    lastAccessed: existing.lastAccessed || null,
    accessCount: existing.accessCount || 0,
    createdAt: existing.createdAt || new Date().toISOString()
  };
  dirty = true;
  return db.tracks[videoId];
}

function markReady(videoId, fileData) {
  const track = db.tracks[videoId];
  if (!track) return null;
  if (fileData.m4a) {
    track.files.m4a = fileData.m4a;
    try { track.fileSize.m4a = fs.statSync(fileData.m4a).size; } catch (e) { }
  }
  if (fileData.mp3) {
    track.files.mp3 = fileData.mp3;
    try { track.fileSize.mp3 = fs.statSync(fileData.mp3).size; } catch (e) { }
  }
  if (fileData.mp4) {
    track.files.mp4 = fileData.mp4;
    try { track.fileSize.mp4 = fs.statSync(fileData.mp4).size; } catch (e) { }
  }
  if (fileData.duration) track.duration = fileData.duration;
  if (fileData.thumbnail) track.thumbnail = fileData.thumbnail;
  track.status = "ready";
  track.processedAt = new Date().toISOString();
  db.stats.totalProcessed++;
  dirty = true;
  console.log(`[MEDIA_LIB] Şarkı hazır: ${videoId} - ${track.title}`);
  return track;
}

function markFailed(videoId, errorMessage) {
  const track = db.tracks[videoId] || {};
  track.status = "failed";
  track.lastError = errorMessage;
  track.failedAt = new Date().toISOString();
  db.tracks[videoId] = track;
  db.stats.totalFailed++;
  dirty = true;
}

function recordAccess(videoId) {
  const track = db.tracks[videoId];
  if (!track) return;
  track.accessCount = (track.accessCount || 0) + 1;
  track.lastAccessed = new Date().toISOString();
  dirty = true;
}

function getReadyTrack(videoId, type = "m4a") {
  const track = db.tracks[videoId];
  if (!track || track.status !== "ready") return null;
  const filePath = track.files?.[type];
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) {
    track.files[type] = null;
    track.status = "missing";
    dirty = true;
    return null;
  }
  return track;
}

function isProcessing(videoId) {
  const track = db.tracks[videoId];
  return track && track.status === "processing";
}

function getAllTracks(filter = {}) {
  let result = Object.values(db.tracks);
  if (filter.status) result = result.filter(t => t.status === filter.status);
  if (filter.minAccess) result = result.filter(t => t.accessCount >= filter.minAccess);
  if (filter.sortBy === "accessCount") {
    result.sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0));
  } else if (filter.sortBy === "lastAccessed") {
    result.sort((a, b) => new Date(b.lastAccessed || 0) - new Date(a.lastAccessed || 0));
  } else {
    result.sort((a, b) => new Date(b.processedAt || 0) - new Date(a.processedAt || 0));
  }
  if (filter.limit) result = result.slice(0, filter.limit);
  return result;
}

function getStats() {
  const tracks = Object.values(db.tracks);
  const ready = tracks.filter(t => t.status === "ready");
  const totalM4aSize = ready.reduce((acc, t) => acc + (t.fileSize?.m4a || 0), 0);
  const totalMp3Size = ready.reduce((acc, t) => acc + (t.fileSize?.mp3 || 0), 0);
  return {
    totalTracks: tracks.length,
    readyTracks: ready.length,
    processingTracks: tracks.filter(t => t.status === "processing").length,
    failedTracks: tracks.filter(t => t.status === "failed").length,
    totalDiskMB: ((totalM4aSize + totalMp3Size) / 1024 / 1024).toFixed(1),
    totalProcessed: db.stats.totalProcessed,
    totalFailed: db.stats.totalFailed,
    topTracks: ready.sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0)).slice(0, 10).map(t => ({
      videoId: t.videoId, title: t.title, accessCount: t.accessCount
    }))
  };
}

function cleanup(maxAgeDays = 365, maxDiskMB = 80000) {
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;
  let freedMB = 0;
  const tracks = Object.values(db.tracks)
    .filter(t => t.status === "ready")
    .sort((a, b) => (a.accessCount || 0) - (b.accessCount || 0));
  for (const track of tracks) {
    const lastAccess = track.lastAccessed ? new Date(track.lastAccessed).getTime() : 0;
    if ((now - lastAccess) > maxAgeMs || track.accessCount === 0) {
      for (const type of ["m4a", "mp3", "mp4"]) {
        const filePath = track.files?.[type];
        if (filePath && fs.existsSync(filePath)) {
          try { freedMB += fs.statSync(filePath).size / 1024 / 1024; fs.unlinkSync(filePath); } catch (e) { }
        }
      }
      if (track.thumbnail && fs.existsSync(track.thumbnail)) {
        try { fs.unlinkSync(track.thumbnail); } catch (e) { }
      }
      delete db.tracks[track.videoId];
      deletedCount++;
    }
  }
  if (deletedCount > 0) { dirty = true; saveDB(); }
  return { deletedCount, freedMB: freedMB.toFixed(1) };
}

function removeTrack(videoId) {
  const track = db.tracks[videoId];
  if (!track) return false;
  for (const type of ["m4a", "mp3", "mp4"]) {
    const filePath = track.files?.[type];
    if (filePath && fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch (e) { } }
  }
  if (track.thumbnail && fs.existsSync(track.thumbnail)) { try { fs.unlinkSync(track.thumbnail); } catch (e) { } }
  delete db.tracks[videoId];
  dirty = true;
  saveDB();
  return true;
}

function clearAllTracks() {
  for (const t of Object.values(db.tracks)) removeTrack(t.videoId);
  db.stats = { totalProcessed: 0, totalFailed: 0 };
  dirty = true;
  saveDB();
  return true;
}

module.exports = { upsertTrack, markReady, markFailed, recordAccess, getReadyTrack, isProcessing, getAllTracks, getStats, cleanup, removeTrack, clearAllTracks, saveDB };
