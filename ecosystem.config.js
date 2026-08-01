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




    // WEBHOOK DEPLOY — GitHub push → otomatik admin panel build
   
    {
      name: "webhook",
      script: "./webhook-deploy.js",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "100M",
      watch: false,
      autorestart: true,

      error_file: "./logs/webhook-error.log",
      out_file: "./logs/webhook-output.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      env: {
        NODE_ENV: "production",
        WEBHOOK_PORT: 9000,
        WEBHOOK_SECRET: "melodia-deploy-2026"
      }
    }
  ]
};
