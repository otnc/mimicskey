// pm2 のプロセス定義。pm2 start ecosystem.config.cjs で起動する。
module.exports = {
  apps: [
    {
      name: "mimicskey",
      script: "dist/index.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
