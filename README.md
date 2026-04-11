# The Feed

Personal content hub. Hosted on Railway at `hub.keithadair.com`.

## Local dev

```bash
npm install
cp config/feeds.example.yml config/feeds.yml
# Edit config/feeds.yml with your sources
cp .env.example .env
# Edit .env with your credentials
npm run dev
```

## Production

Hosted on Railway. Auto-deploys on push to `main`. See `CLAUDE.md` for full deployment details.
