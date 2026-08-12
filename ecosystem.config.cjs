module.exports = {
  apps: [
    {
      name: "dungeon-blitz",
      cwd: "/home/admin/DungenBlitz/src/server",
      script: "dist/main.js",
      interpreter: "/usr/bin/node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      kill_timeout: 10000,
      listen_timeout: 10000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "dungeon-blitz-caddy-sync",
      cwd: "/home/admin/DungenBlitz",
      script: "scripts/ensure-caddy-route.sh",
      interpreter: "/bin/bash",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      min_uptime: "10s",
      restart_delay: 5000,
      merge_logs: true,
      time: true
    }
  ]
};
