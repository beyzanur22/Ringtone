module.exports = {
  apps: [
    {
      name: "ringtone-backend",
      script: "./server.js",
      instances: 1, // Tek instance — media_db.json dosya kilidi çakışmasını önler
                     // Cluster mode FFmpeg + yt-dlp ile çakışma yaratır
      exec_mode: "fork",
      max_memory_restart: "1G", // 1GB RAM'i aşarsa otomatik restart
      watch: false,
      autorestart: true,
      restart_delay: 3000, // Restart arasında 3 saniye bekle
      max_restarts: 10, // 10 kez restart'tan sonra dur
      min_uptime: "30s", // 30 saniyeden kısa yaşarsa crash sayılır

      // Log dosyaları
      error_file: "./logs/error.log",
      out_file: "./logs/output.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      // Environment — Secret key'ler .env dosyasında tutulur (dotenv ile okunur)
      // GÜVENLİK: Hassas bilgileri ASLA buraya yazmayın!
      env: {
        NODE_ENV: "production",
        PORT: 5000,
        MEDIA_DIR: "/app/media"
        // APP_KEY, BAZOCAM_PASS, ADMIN_PASS → .env dosyasında tanımlayın
      }
    }
  ]
};
