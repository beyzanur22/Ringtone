module.exports = {
  apps: [
    {
      name: "server",
      script: "./server.js",
      instances: 4,
      exec_mode: "cluster",
      max_memory_restart: "3000M",
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: "30s",

      error_file: "./logs/error.log",
      out_file: "./logs/output.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      env: {
        NODE_ENV: "production",
        PORT: 5000,
        MEDIA_DIR: "/app/media"
      }
    },

    // ═══════════════════════════════════════════════════
    // yt-dlp RESOLVE WORKER'LARI
    // Her worker 6 paralel yt-dlp çalıştırır
    // 4 worker × 6 = 24 eşzamanlı çözümleme (tek sunucu)
    //
    // Başka sunucuya eklemek için:
    //   REDIS_URL=redis://ana-sunucu:6379 pm2 start resolve_worker.js -i 4
    // ═══════════════════════════════════════════════════
    {
      name: "resolver",
      script: "./resolve_worker.js",
      instances: 16,
      exec_mode: "fork",  // Her biri bağımsız process
      max_memory_restart: "350M",
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: "10s",

      error_file: "./logs/resolver-error.log",
      out_file: "./logs/resolver-output.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      env: {
        NODE_ENV: "production",
        WORKER_CONCURRENCY: 25  // Worker başına paralel iş sayısı (16×25=400 paralel)
      }
    }
  ]
};
