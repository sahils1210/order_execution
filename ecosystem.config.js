/**
 * PM2 Ecosystem Config
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup  # enable auto-restart on server reboot
 */

module.exports = {
  apps: [
    {
      name: 'order-gateway',
      script: 'node',
      args: '--experimental-sqlite dist/index.js',
      instances: 1,         // Single instance (SQLite doesn't support multi-process writes safely)
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',

      env: {
        NODE_ENV: 'production',
      },

      // Restart if crashes, but with exponential backoff
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '5s',

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
    },
  ],
};
