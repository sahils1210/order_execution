/**
 * PM2 Ecosystem Config — production-tuned.
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup    # enable auto-restart on reboot
 *
 * Notes:
 *   - max_restarts is intentionally high (1000). Crash loops are caught by
 *     the external monitor + Telegram alerts, not by PM2 giving up silently.
 *   - max_memory_restart is 512M to absorb postback bursts and Socket.IO load.
 */

module.exports = {
  apps: [
    {
      name: 'order-gateway',
      script: 'node',
      args: '--experimental-sqlite dist/index.js',
      instances: 1,            // SQLite is single-process for safe writes
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',

      env: {
        NODE_ENV: 'production',
      },

      exp_backoff_restart_delay: 100,
      max_restarts: 1000,      // Don't give up silently — alert covers crash loops.
      min_uptime: '5s',

      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
    },
  ],
};
