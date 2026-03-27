const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Bu script yt-dlp'nin OAuth2 (TV Client) akışını başlatır.
 * Ekranda bir kod çıkacak, o kodu google.com/device adresine girmeniz gerekecek.
 */

async function generateToken() {
    console.log("---------------------------------------------------------");
    console.log("YouTube OAuth2 (TV Client) Yetkilendirme Başlatılıyor...");
    console.log("---------------------------------------------------------");

    const cacheDir = path.join(__dirname, 'cache');
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir);
    }

    // yt-dlp binary yolunu buluyoruz
    const ytdlpPath = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe');
    
    // Herhangi bir rastgele video URL'si kullanarak auth tetikliyoruz
    const command = `"${ytdlpPath}" --username oauth2 --password '' --cache-dir "./cache" --skip-download "https://www.youtube.com/watch?v=dQw4w9WgXcQ"`;

    console.log("Komut çalıştırılıyor, lütfen bekleyin...\n");

    const child = exec(command);

    child.stdout.on('data', (data) => {
        process.stdout.write(data);
    });

    child.stderr.on('data', (data) => {
        // Genelde kod stderr veya stdout üzerinden gelir
        process.stdout.write(data);
    });

    child.on('close', (code) => {
        console.log(`\nİşlem tamamlandı (Code: ${code})`);
        console.log("Eğer giriş yaptıysanız, token bilgileri ./cache klasörüne kaydedildi.");
    });
}

generateToken().catch(console.error);
