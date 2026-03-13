module.exports = {
  apps: [
    {
      name: 'WhatsYpzck',
      script: 'build/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      min_uptime: '10s',
      max_restarts: 10,
      max_memory_restart: '900M',

      env: {
        NODE_ENV: 'production',
        PORT: 3003,
        AI_MAX_CONCURRENCY: 4,
        AI_MAX_QUEUE_SIZE: 120,
        AI_HYBRID_ENABLED: 'true',
        AI_HYBRID_TRIGGER_INFLIGHT: 3,
        AI_HYBRID_TRIGGER_QUEUE: 1,
        AI_REPLY_CACHE_TTL_MS: 45000,
        AI_MEMORY_CACHE_TTL_MS: 15000,
        OLLAMA_BASE_URL: 'http://localhost:11434',
        OLLAMA_TIMEOUT_MS: 90000,
        OLLAMA_NUM_PREDICT: 72,
        OLLAMA_NUM_CTX: 768,
        OLLAMA_NUM_GPU: -1,
        OLLAMA_NUM_THREAD: 8,
        OLLAMA_TEMPERATURE: 0.2,
        OLLAMA_TOP_P: 0.9,
        AI_WEB_LOOKUP_ENABLED: 'false'
      },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,

      wait_ready: false,
      kill_timeout: 10000,
      listen_timeout: 10000,
      shutdown_with_message: false,
      exp_backoff_restart_delay: 100,
      restart_delay: 4000,

      source_map_support: true,
      instance_var: 'INSTANCE_ID',

      automation: false,
      ignore_watch: ['node_modules', 'logs', 'public/downloads', '.bot'],

      node_args: '--max-old-space-size=1024',

      error: (error) => {
        console.error('PM2 Error:', error);
      }
    }
  ],

  // Deployment configuration (optional)
  deploy: {
    production: {
      user: 'ubuntu',
      host: 'your-server-ip',
      ref: 'origin/main',
      repo: 'git@github.com:CaqlayanKurtoglu/WhatsYpzck.git',
      path: '/home/ubuntu/WhatsYpzck',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': 'apt-get install git -y'
    }
  }
};
