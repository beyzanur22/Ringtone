/**
 * Media Library — Medya Kütüphanesi Veritabanı
 * 
 * Her indirilen/dönüştürülen şarkının kaydını tutar.
 * JSON dosyası tabanlı basit veritabanı (SQLite'a gerek yok).
 * 
 * Her kayıt:
 * - videoId, title, artist, duration
 * - Dosya yolları (m4a, mp3, mp4, thumbnail)
 * - Dosya boyutları
 * - İşlem durumu (processing, ready, failed)
 * - Erişim sayacı, son erişim zamanı
 */

const fs = require("fs");
const path = require("path");
const DB_FILE = path.join(__dirname, "media_db.json");
const SAVE_INTERVAL = 30 * 1000; // 30 saniyede bir diske yaz

let db = { tracks: {}, stats: { totalProcessed: 0, totalFailed: 0 } };
let dirty = false;

// ═══════════════════════════════════════
//  VERİTABANI YÜKLEME / KAYDETME
// ═══════════════════════════════════════

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf-8");
      db = JSON.parse(raw);
      console.log(`[MEDIA_LIB] ✅ Veritabanı yüklendi: ${Object.keys(db.tracks).length} şarkı`);
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
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    dirty = false;
  } catch (err) {
    console.error(`[MEDIA_LIB] DB kaydetme hatası: ${err.message}`);
  }
}

// Periyodik kayıt (her 30 saniye, sadece değişiklik varsa)
setInterval(() => {
  if (dirty) saveDB();
}, SAVE_INTERVAL);

// Başlangıçta yükle
loadDB();

// ═══════════════════════════════════════
//  CRUD İŞLEMLERİ
// ═══════════════════════════════════════

/**
 * Şarkı kaydı ekle veya güncelle
 */
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
    category: data.category || existing.category || "streaming", // New field: listening, watching, downloading
    processedAt: data.processedAt || existing.processedAt || null,
    lastAccessed: existing.lastAccessed || null,
    accessCount: existing.accessCount || 0,
    createdAt: existing.createdAt || new Date().toISOString()
  };
  dirty = true;
  return db.tracks[videoId];
}

/**
 * Şarkıyı "ready" olarak işaretle (işlem tamamlandı)
 */
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

  console.log(`[MEDIA_LIB] ✅ Şarkı hazır: ${videoId} - ${track.title}`);
  return track;
}

/**
 * Şarkıyı "failed" olarak işaretle
 */
function markFailed(videoId, errorMessage) {
  const track = db.tracks[videoId] || {};
  track.status = "failed";
  track.lastError = errorMessage;
  track.failedAt = new Date().toISOString();
  db.tracks[videoId] = track;
  db.stats.totalFailed++;
  dirty = true;
}

/**
 * Şarkıya erişim kaydet (dinlenme sayacı)
 */
function recordAccess(videoId) {
  const track = db.tracks[videoId];
  if (!track) return;
  track.accessCount = (track.accessCount || 0) + 1;
  track.lastAccessed = new Date().toISOString();
  dirty = true;
}

/**
 * Şarkının dosyası diskten var mı kontrol et
 */
function getReadyTrack(videoId, type = "m4a") {
  const track = db.tracks[videoId];
  if (!track || track.status !== "ready") return null;

  const filePath = track.files?.[type];
  if (!filePath) return null;

  // Dosya gerçekten var mı kontrol et.
  if (!fs.existsSync(filePath)) {
    // Dosya silinmiş, kaydı güncelle
    track.files[type] = null;
    track.status = "missing";
    dirty = true;
    return null
  }

  return track;
}

/**
 * Şarkı işleniyor mu kontrol et (çift indirme önleme)
 */
function isProcessing(videoId) {
  const track = db.tracks[videoId];
  return track && track.status === "processing";
}

/**
 * Tüm hazır şarkıların listesi
 */
function getAllTracks(filter = {}) {
  const tracks = Object.values(db.tracks);
  let result = tracks;

  if (filter.status) result = result.filter(t => t.status === filter.status);
  if (filter.minAccess) result = result.filter(t => t.accessCount >= filter.minAccess);

  // Sıralama
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

/**
 * İstatistikler
 */
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
      videoId: t.videoId,
      title: t.title,
      accessCount: t.accessCount
    }))
  };
}

/**
 * Eski/kullanılmayan şarkıları temizle
 * @param {number} maxAgeDays - Bu kadar gündür dinlenmemiş şarkıları sil
 * @param {number} maxDiskMB - Disk limiti (MB)
 */
function cleanup(maxAgeDays = 180, maxDiskMB = 80000) { // 180 gün, 80GB — Contabo VPS (145GB disk)
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;
  let freedMB = 0;

  const tracks = Object.values(db.tracks)
    .filter(t => t.status === "ready")
    .sort((a, b) => (a.accessCount || 0) - (b.accessCount || 0)); // En az dinleneni önce

  for (const track of tracks) {
    const lastAccess = track.lastAccessed ? new Date(track.lastAccessed).getTime() : 0;
    const age = now - lastAccess;

    // Çok eski veya hiç dinlenmemiş
    if (age > maxAgeMs || track.accessCount === 0) {
      // Dosyaları sil
      for (const type of ["m4a", "mp3", "mp4"]) {
        const filePath = track.files?.[type];
        if (filePath && fs.existsSync(filePath)) {
          const size = fs.statSync(filePath).size;
          try {
            fs.unlinkSync(filePath);
            freedMB += size / 1024 / 1024;
          } catch (e) { }
        }
      }
      // Thumbnail sil
      if (track.thumbnail && fs.existsSync(track.thumbnail)) {
        try { fs.unlinkSync(track.thumbnail); } catch (e) { }
      }
      delete db.tracks[track.videoId];
      deletedCount++;
    }
  }

  if (deletedCount > 0) {
    dirty = true;
    saveDB();
    console.log(`[MEDIA_LIB] 🗑️ Temizlik: ${deletedCount} şarkı silindi, ${freedMB.toFixed(1)} MB yer açıldı`);
  }
  return { deletedCount, freedMB: freedMB.toFixed(1) };
}

/**
 * Tek bir şarkıyı ve dosyalarını sil
 */
function removeTrack(videoId) {
  const track = db.tracks[videoId];
  if (!track) return false;

  // Dosyaları sil
  for (const type of ["m4a", "mp3", "mp4"]) {
    const filePath = track.files?.[type];
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { }
    }
  }
  // Thumbnail sil
  if (track.thumbnail && fs.existsSync(track.thumbnail)) {
    try { fs.unlinkSync(track.thumbnail); } catch (e) { }
  }

  delete db.tracks[videoId];
  dirty = true;
  saveDB();
  return true;
}

/**
 * Tüm kütüphaneyi boşalt
 */
function clearAllTracks() {
  const tracks = Object.values(db.tracks);
  for (const t of tracks) {
    removeTrack(t.videoId);
  }
  db.stats = { totalProcessed: 0, totalFailed: 0 };
  dirty = true;
  saveDB();
  return true;
}

// ═══════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════

module.exports = {
  upsertTrack,
  markReady,
  markFailed,
  recordAccess,
  getReadyTrack,
  isProcessing,
  getAllTracks,
  getStats,
  cleanup,
  removeTrack,
  clearAllTracks,
  saveDB
};
