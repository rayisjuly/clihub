/**
 * @input .env file for environment variables
 * @output PM2 process configuration
 * @pos Process management config for production deployment
 */

const path = require('path');
const fs = require('fs');

// Load .env file if exists
const envPath = path.join(__dirname, '.env');
const env = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .forEach(line => {
      const [key, ...vals] = line.split('=');
      if (key) env[key.trim()] = vals.join('=').trim();
    });
}

module.exports = {
  apps: [{
    name: 'clihub',
    script: 'server.js',
    cwd: __dirname,
    env,
    // Restart policy
    autorestart: true,
    max_restarts: 50,
    restart_delay: 2000,
    // Crash detection: if restart > 5 times in 60s, stop
    min_uptime: 5000,
    // Logging
    error_file: path.join(__dirname, 'logs/error.log'),
    out_file: path.join(__dirname, 'logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // Misc
    watch: false,
    kill_timeout: 5000,
  }]
};
