module.exports = {
  apps: [{
    name: 'the-feed',
    script: 'node_modules/.bin/next',
    args: 'start',
    cwd: './',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
      // 3030 (not 3000) — the Mac Mini MCP server owns 127.0.0.1:3000 on IPv4.
      // HOSTNAME=0.0.0.0 forces IPv4 binding so Tailscale Serve (which proxies via
      // IPv4 localhost) can reach us.
      PORT: 3030,
      HOSTNAME: '0.0.0.0'
    }
  }]
}
