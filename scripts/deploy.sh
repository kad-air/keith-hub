#!/bin/bash
cd ~/projects/keith-hub
git fetch origin main --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git pull --ff-only
  npm install --production
  npm run build
  pm2 restart the-feed
  echo "$(date): Deployed new version" >> ~/projects/keith-hub/logs/deploy.log
fi
