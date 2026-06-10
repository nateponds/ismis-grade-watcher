module.exports = {
  apps: [
    {
      name: "ismis-watcher",
      script: "./watcher.js",
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
