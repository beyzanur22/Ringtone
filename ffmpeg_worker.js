/**
 * FFmpeg Worker — Müzik İndirme, Dönüştürme ve Depolama Motoru
 * 
 * Sorumlulukları:
 * 1. yt-dlp ile YouTube'dan raw audio indir
 * 2. FFmpeg ile M4A (128kbps AAC) / MP3 (192kbps) dönüştür
 * 3. Ses normalizasyonu (loudnorm)
 * 4. Metadata ekleme (başlık, sanatçı, thumbnail)
 * 5. İşlem kuyruğu yönetimi
 */

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const PQueue = require("p-queue").default;

// ═══════════════════════════════════════
//  YAPILANDIRMA
// ═══════════════════════════════════════

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, "media");
const TEMP_DIR = path.join(MEDIA_DIR, "temp");

// Alt klasörleri oluştur
["audio", "mp3", "video", "thumbs", "temp"].forEach(dir => {
  const p = path.join(MEDIA_DIR, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// FFmpeg işlem kuyruğu — aynı anda max 2 dönüşüm (CPU koruması)
const ffmpegQueue = new PQueue({ concurrency: 2, timeout: 300000 });

// yt-dlp binary yolu
function getYtDlpBin() {
  const paths = ["/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp", "/app/node_modules/yt-dlp-exec/bin/yt-dlp"];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return "yt-dlp";
}

// FFmpeg binary yolu
function getFFmpegBin() {
  const paths = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return "ffmpeg";
}

// ═══════════════════════════════════════
//  ANA FONKSİYONLAR
// ═══════════════════════════════════════

/**
 * YouTube'dan audio indir + FFmpeg ile dönüştür
 * @param {string} videoId - YouTube video ID
 * @param {object} metadata - {title, artist, thumbnail}
 * @param {object} options - {format: "m4a"|"mp3"|"both", cookiePath, proxyUrl}
 * @returns {Promise<object>} - {m4a: filePath, mp3: filePath, duration, fileSize}
 */
async function processAudio(videoId, metadata = {}, options = {}) {
  return ffmpegQueue.add(async () => {
    const startTime = Date.now();
    console.log(`[FFMPEG_WORKER] 🎵 İşlem başlıyor: ${videoId}`);

    const rawFile = path.join(TEMP_DIR, `raw_${videoId}.webm`);
    const m4aFile = path.join(MEDIA_DIR, "audio", `${videoId}.m4a`);
    const mp3File = path.join(MEDIA_DIR, "mp3", `${videoId}.mp3`);

    try {
      // Zaten varsa atla
      const wantM4a = options.format !== "mp3";
      const wantMp3 = options.format === "mp3" || options.format === "both";

      if (wantM4a && fs.existsSync(m4aFile) && isValidFile(m4aFile, 20 * 1024)) {
        console.log(`[FFMPEG_WORKER] ✅ M4A zaten var: ${videoId}`);
        if (!wantMp3 || (fs.existsSync(mp3File) && isValidFile(mp3File, 20 * 1024))) {
          return buildResult(videoId, m4aFile, mp3File);
        }
      }

      // ADIM 1: yt-dlp ile raw audio indir
      await downloadRawAudio(videoId, rawFile, options);

      // ADIM 2: FFmpeg ile M4A'ya dönüştür
      const result = {};
      if (wantM4a) {
        await convertToM4A(rawFile, m4aFile, metadata);
        result.m4a = m4aFile;
      }

      // ADIM 3: FFmpeg ile MP3'e dönüştür (isteniyorsa)
      if (wantMp3) {
        const sourceForMp3 = fs.existsSync(m4aFile) ? m4aFile : rawFile;
        await convertToMP3(sourceForMp3, mp3File, metadata);
        result.mp3 = mp3File;
      }

      // ADIM 4: Süre bilgisini al
      result.duration = await getAudioDuration(m4aFile || mp3File);
      result.videoId = videoId;
      result.processedIn = Date.now() - startTime;

      console.log(`[FFMPEG_WORKER] ✅ Tamamlandı: ${videoId} (${result.processedIn}ms)`);
      return result;

    } finally {
      // Temp dosyasını temizle
      safeDelete(rawFile);
      safeDelete(rawFile + ".part");
    }
  });
}

/**
 * YouTube'dan video indir + FFmpeg ile optimize et
 */
async function processVideo(videoId, metadata = {}, options = {}) {
  return ffmpegQueue.add(async () => {
    const rawFile = path.join(TEMP_DIR, `rawvid_${videoId}.mp4`);
    const mp4File = path.join(MEDIA_DIR, "video", `${videoId}.mp4`);

    try {
      if (fs.existsSync(mp4File) && isValidFile(mp4File, 500 * 1024)) {
        console.log(`[FFMPEG_WORKER] ✅ MP4 zaten var: ${videoId}`);
        return { mp4: mp4File, videoId };
      }

      await downloadRawVideo(videoId, rawFile, options);
      await convertToMP4(rawFile, mp4File, metadata);

      return { mp4: mp4File, videoId };
    } finally {
      safeDelete(rawFile);
    }
  });
}

/**
 * Thumbnail indir
 */
async function downloadThumbnail(videoId) {
  const thumbFile = path.join(MEDIA_DIR, "thumbs", `${videoId}.jpg`);
  if (fs.existsSync(thumbFile) && isValidFile(thumbFile, 1024)) return thumbFile;

  try {
    const axios = require("axios");
    // Yüksek kalite thumbnail URL'leri dene
    const urls = [
      `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
    ];

    for (const url of urls) {
      try {
        const response = await axios({ method: "GET", url, responseType: "stream", timeout: 10000 });
        const writer = fs.createWriteStream(thumbFile);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });
        if (isValidFile(thumbFile, 1024)) {
          console.log(`[FFMPEG_WORKER] 🖼️ Thumbnail indirildi: ${videoId}`);
          return thumbFile;
        }
      } catch (e) { continue; }
    }
  } catch (err) {
    console.warn(`[FFMPEG_WORKER] Thumbnail indirilemedi: ${videoId}: ${err.message}`);
  }
  return null;
}

// ═══════════════════════════════════════
//  ADIM 1: YT-DLP İLE İNDİRME
// ═══════════════════════════════════════

function downloadRawAudio(videoId, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    const ytdlpBin = getYtDlpBin();
    const args = [
      `https://www.youtube.com/watch?v=${videoId}`,
      "-f", "bestaudio",
      "-o", outputPath,
      "--no-playlist",
      "--no-part",
      "--no-mtime",
      "--retries", "3",
      "--socket-timeout", "30",
      "--quiet", "--no-warnings"
    ];

    if (options.cookiePath) args.push("--cookies", options.cookiePath);
    if (options.proxyUrl) args.push("--proxy", options.proxyUrl);

    console.log(`[FFMPEG_WORKER] ⬇️ Audio indiriliyor: ${videoId}`);

    execFile(ytdlpBin, args, {
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PATH: "/usr/local/bin:" + (process.env.PATH || "") }
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[FFMPEG_WORKER] yt-dlp hatası: ${stderr || error.message}`);
        return reject(new Error(`yt-dlp download failed: ${error.message}`));
      }
      if (!fs.existsSync(outputPath) || !isValidFile(outputPath, 10 * 1024)) {
        return reject(new Error("yt-dlp dosya oluşturamadı veya çok küçük"));
      }
      console.log(`[FFMPEG_WORKER] ⬇️ Audio indirildi: ${videoId} (${fileSizeMB(outputPath)} MB)`);
      resolve(outputPath);
    });
  });
}

function downloadRawVideo(videoId, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    const ytdlpBin = getYtDlpBin();
    const args = [
      `https://www.youtube.com/watch?v=${videoId}`,
      "-f", "b[ext=mp4][height<=720]/best[ext=mp4]/best",
      "-o", outputPath,
      "--no-playlist",
      "--no-part",
      "--no-mtime",
      "--retries", "3",
      "--quiet", "--no-warnings"
    ];

    if (options.cookiePath) args.push("--cookies", options.cookiePath);
    if (options.proxyUrl) args.push("--proxy", options.proxyUrl);

    execFile(ytdlpBin, args, {
      timeout: 600000,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PATH: "/usr/local/bin:" + (process.env.PATH || "") }
    }, (error) => {
      if (error) return reject(new Error(`Video download failed: ${error.message}`));
      if (!fs.existsSync(outputPath) || !isValidFile(outputPath, 100 * 1024)) {
        return reject(new Error("Video dosyası oluşturulamadı"));
      }
      resolve(outputPath);
    });
  });
}

// ═══════════════════════════════════════
//  ADIM 2: FFMPEG DÖNÜŞÜM
// ═══════════════════════════════════════

function convertToM4A(inputPath, outputPath, metadata = {}) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFFmpegBin();
    const args = [
      "-i", inputPath,
      "-y",                          // Üzerine yaz
      "-vn",                         // Video kanalını kaldır
      "-c:a", "aac",                 // AAC codec
      "-b:a", "128k",                // 128 kbps
      "-ar", "44100",                // 44.1kHz sample rate
      "-ac", "2",                    // Stereo
      "-af", "loudnorm=I=-16:LRA=11:TP=-1.5",  // Ses normalizasyonu
      "-movflags", "+faststart",     // Streaming için optimize (moov atom başa)
    ];

    // Metadata ekle
    if (metadata.title) args.push("-metadata", `title=${metadata.title}`);
    if (metadata.artist) args.push("-metadata", `artist=${metadata.artist}`);

    args.push(outputPath);

    console.log(`[FFMPEG_WORKER] 🔄 M4A dönüşüm: ${path.basename(inputPath)}`);

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[FFMPEG_WORKER] M4A dönüşüm hatası (code ${code}): ${stderr.slice(-500)}`);
        safeDelete(outputPath);
        return reject(new Error(`FFmpeg M4A failed (code ${code})`));
      }
      if (!isValidFile(outputPath, 20 * 1024)) {
        safeDelete(outputPath);
        return reject(new Error("FFmpeg M4A output çok küçük"));
      }
      console.log(`[FFMPEG_WORKER] ✅ M4A hazır: ${fileSizeMB(outputPath)} MB`);
      resolve(outputPath);
    });

    proc.on("error", (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
  });
}

function convertToMP3(inputPath, outputPath, metadata = {}) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFFmpegBin();
    const args = [
      "-i", inputPath,
      "-y",
      "-vn",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",
      "-af", "loudnorm=I=-16:LRA=11:TP=-1.5",
      "-id3v2_version", "3",
    ];

    if (metadata.title) args.push("-metadata", `title=${metadata.title}`);
    if (metadata.artist) args.push("-metadata", `artist=${metadata.artist}`);

    args.push(outputPath);

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        safeDelete(outputPath);
        return reject(new Error(`FFmpeg MP3 failed (code ${code})`));
      }
      if (!isValidFile(outputPath, 20 * 1024)) {
        safeDelete(outputPath);
        return reject(new Error("FFmpeg MP3 output çok küçük"));
      }
      console.log(`[FFMPEG_WORKER] ✅ MP3 hazır: ${fileSizeMB(outputPath)} MB`);
      resolve(outputPath);
    });

    proc.on("error", (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
  });
}

function convertToMP4(inputPath, outputPath, metadata = {}) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFFmpegBin();
    const args = [
      "-i", inputPath,
      "-y",
      "-c:v", "libx264",
      "-crf", "23",
      "-preset", "fast",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-vf", "scale=-2:720",        // Max 720p
    ];

    if (metadata.title) args.push("-metadata", `title=${metadata.title}`);
    args.push(outputPath);

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        safeDelete(outputPath);
        return reject(new Error(`FFmpeg MP4 failed (code ${code})`));
      }
      resolve(outputPath);
    });

    proc.on("error", (err) => reject(err));
  });
}

// ═══════════════════════════════════════
//  YARDIMCI FONKSİYONLAR
// ═══════════════════════════════════════

function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) return resolve(0);
    const ffprobe = getFFmpegBin().replace("ffmpeg", "ffprobe");
    execFile(ffprobe, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      filePath
    ], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(0);
      try {
        const info = JSON.parse(stdout);
        resolve(Math.round(parseFloat(info.format.duration) || 0));
      } catch (e) { resolve(0); }
    });
  });
}

function isValidFile(filePath, minBytes = 1024) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stats = fs.statSync(filePath);
    return stats.size >= minBytes;
  } catch (e) { return false; }
}

function safeDelete(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
}

function fileSizeMB(filePath) {
  try { return (fs.statSync(filePath).size / 1024 / 1024).toFixed(2); } catch (e) { return "?"; }
}

function buildResult(videoId, m4aFile, mp3File) {
  const result = { videoId };
  if (m4aFile && fs.existsSync(m4aFile)) {
    result.m4a = m4aFile;
    result.m4aSize = fs.statSync(m4aFile).size;
  }
  if (mp3File && fs.existsSync(mp3File)) {
    result.mp3 = mp3File;
    result.mp3Size = fs.statSync(mp3File).size;
  }
  return result;
}

/**
 * Medya dizininin toplam boyutunu hesapla
 */
function getMediaDiskUsage() {
  let totalSize = 0;
  let fileCount = 0;
  const dirs = ["audio", "mp3", "video", "thumbs"];
  for (const dir of dirs) {
    const dirPath = path.join(MEDIA_DIR, dir);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      try {
        const stats = fs.statSync(path.join(dirPath, file));
        totalSize += stats.size;
        fileCount++;
      } catch (e) { }
    }
  }
  return { totalSize, totalSizeMB: (totalSize / 1024 / 1024).toFixed(1), fileCount };
}

/**
 * Temp klasöründeki eski dosyaları temizle
 */
function cleanupTemp() {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > 15 * 60 * 1000) { // 15 dk'dan eski
          fs.unlinkSync(filePath);
          console.log(`[FFMPEG_WORKER] 🗑️ Eski temp silindi: ${file}`);
        }
      } catch (e) { }
    }
  } catch (e) { }
}

// Her 5 dakikada temp temizliği
setInterval(cleanupTemp, 5 * 60 * 1000);

// ═══════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════

module.exports = {
  processAudio,
  processVideo,
  downloadThumbnail,
  getMediaDiskUsage,
  cleanupTemp,
  MEDIA_DIR,
  isValidFile
};
