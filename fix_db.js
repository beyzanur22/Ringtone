/**
 * DB Fixer - Medya Kütüphanesini Tamir Et ve İsimleri Çek
 * Kullanımı: node fix_db.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DB_FILE = path.join(__dirname, 'media_db.json');

if (!fs.existsSync(DB_FILE)) {
    console.error("HATA: media_db.json bulunamadı!");
    process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
const tracks = Object.values(db.tracks);

console.log(`[FIXER] ${tracks.length} şarkı taranıyor...`);

async function fix() {
    let fixedCount = 0;

    for (const track of tracks) {
        let changed = false;

        // 1. İsim düzeltme
        if (!track.title || track.title === "Unknown") {
            console.log(`[FIX] İsim çekiliyor: ${track.videoId}`);
            try {
                const title = execSync(`yt-dlp --get-title https://www.youtube.com/watch?v=${track.videoId}`, { encoding: 'utf8' }).trim();
                if (title) {
                    track.title = title;
                    changed = true;
                }
            } catch (e) {
                console.warn(`    ! İsim çekilemedi: ${track.videoId}`);
            }
        }

        // 2. Kategori düzeltme
        if (!track.category) {
            track.category = track.files.mp4 ? "watching" : "listening";
            changed = true;
        }

        // 3. Tarih düzeltme (Eğer tarih yoksa veya çok eskiyse bugüne al)
        if (!track.processedAt) {
            track.processedAt = new Date().toISOString();
            changed = true;
        }

        if (changed) fixedCount++;
    }

    if (fixedCount > 0) {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        console.log(`[OK] ${fixedCount} şarkı başarıyla güncellendi!`);
    } else {
        console.log("[OK] Her şey zaten güncel.");
    }
}

fix();
