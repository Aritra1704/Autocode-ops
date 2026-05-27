module.exports = {
  apps: [
    {
      name: 'stallone',
      script: 'src/index.js',
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      log_file: 'stallone.log',
      error_file: 'stallone.error.log',
      time: true,
    },
  ],
};
