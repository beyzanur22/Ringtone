/**
 * Content Grower — Otomatik İçerik Büyütme Sistemi
 * 
 * Kullanıcılar şarkı dinledikçe kütüphane otomatik büyür.
 * Ayrıca planlı görevlerle popüler şarkılar ön-indirilir.
 * Disk doluluk takibi ve akıllı temizlik yapar.
 */

const fs = require("fs");
const path = require("path");
const ffmpegWorker = require("./ffmpeg_worker");
const mediaLib = require("./media_library");

// ═══════════════════════════════════════
//  YAPILANDIRMA
// ═══════════════════════════════════════

const MAX_DISK_MB = parseInt(process.env.MAX_DISK_MB || "500"); // Railway için 500MB limit
const CLEANUP_AGE_DAYS = parseInt(process.env.CLEANUP_AGE_DAYS || "90");
const NIGHT_DOWNLOAD_ENABLED = process.env.NIGHT_DOWNLOAD !== "false";
const MAX_DOWNLOADS_PER_HOUR = 20; // YouTube ban koruması

let downloadsThisHour = 0;

// Her saat sayacı sıfırla
setInterval(() => { downloadsThisHour = 0; }, 60 * 60 * 1000);

// ═══════════════════════════════════════
//  REAKTİF BÜYÜME: Kullanıcı tetikli
// ═══════════════════════════════════════

/**
 * Kullanıcı bir şarkı dinlediğinde arka planda kalıcı kaydet
 * (server.js'den çağrılır)
 */
async function onUserListen(videoId, metadata = {}, rotationAssets = {}) {
  // Zaten varsa veya işleniyorsa atla
  if (mediaLib.getReadyTrack(videoId, "m4a") || mediaLib.isProcessing(videoId)) {
    return;
  }

  // Rate limit kontrolü
  if (downloadsThisHour >= MAX_DOWNLOADS_PER_HOUR) {
    console.log(`[GROWER] Saatlik limit doldu (${MAX_DOWNLOADS_PER_HOUR}), atlanıyor: ${videoId}`);
    return;
  }

  // Disk doluluk kontrolü
  const disk = ffmpegWorker.getMediaDiskUsage();
  if (parseFloat(disk.totalSizeMB) > MAX_DISK_MB * 0.9) {
    console.log(`[GROWER] Disk %90+ dolu (${disk.totalSizeMB} MB), önce temizlik yapılıyor...`);
    mediaLib.cleanup(CLEANUP_AGE_DAYS, MAX_DISK_MB);
  }

  downloadsThisHour++;
  mediaLib.upsertTrack(videoId, { ...metadata, status: "processing" });

  try {
    const result = await ffmpegWorker.processAudio(videoId, metadata, {
      format: "m4a",
      cookiePath: rotationAssets.cookiePath,
      proxyUrl: rotationAssets.proxyUrl
    });

    mediaLib.markReady(videoId, result);

    // Thumbnail da indir
    const thumb = await ffmpegWorker.downloadThumbnail(videoId).catch(() => null);
    if (thumb) mediaLib.upsertTrack(videoId, { thumbnail: thumb, status: "ready" });

    console.log(`[GROWER] ✅ Şarkı kütüphaneye eklendi: ${videoId}`);
  } catch (err) {
    mediaLib.markFailed(videoId, err.message);
    console.warn(`[GROWER] ❌ İşleme başarısız: ${videoId}: ${err.message}`);
  }
}

// ═══════════════════════════════════════
//  PERİYODİK TEMİZLİK
// ═══════════════════════════════════════

function runCleanup() {
  console.log("[GROWER] 🧹 Periyodik temizlik başlıyor...");
  const result = mediaLib.cleanup(CLEANUP_AGE_DAYS, MAX_DISK_MB);
  const disk = ffmpegWorker.getMediaDiskUsage();
  console.log(`[GROWER] Temizlik sonucu: ${result.deletedCount} silindi, ${result.freedMB} MB açıldı. Toplam: ${disk.totalSizeMB} MB, ${disk.fileCount} dosya`);
}

// Her 6 saatte bir temizlik
setInterval(runCleanup, 6 * 60 * 60 * 1000);
// Başlangıçtan 5 dakika sonra ilk temizlik
setTimeout(runCleanup, 5 * 60 * 1000);

// ═══════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════

module.exports = {
  onUserListen,
  runCleanup,
  getStatus: () => ({
    downloadsThisHour,
    maxPerHour: MAX_DOWNLOADS_PER_HOUR,
    maxDiskMB: MAX_DISK_MB,
    nightDownloadEnabled: NIGHT_DOWNLOAD_ENABLED
  })
};
