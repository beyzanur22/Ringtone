module.exports = {
  apps: [
    {
      name: "ringtone-backend",
      script: "./server.js",
      instances: "max", // CPU sayısına göre maksimize et
      exec_mode: "cluster",
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "development",
        PORT: 5000
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 5000
      }
    }
  ]
};
