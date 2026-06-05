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
    }
  ]
};
