# The Feed

Personal content hub. Self-hosted on Mac Mini, accessible via Tailscale.

## Setup

```bash
npm install
cp config/feeds.example.yml config/feeds.yml
# Edit config/feeds.yml with your sources
cp .env.example .env
# Edit .env with your Bluesky credentials (optional for v0)
npm run dev
```

## Production (Mac Mini)

```bash
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Auto-deploy

Add to crontab:
```
*/2 * * * * bash ~/projects/keith-hub/scripts/deploy.sh
```
