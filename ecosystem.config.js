module.exports = {
  apps: [{
    name: 'the-feed',
    script: 'node_modules/.bin/next',
    args: 'start',
    cwd: './',
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
}
