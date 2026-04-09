#!/bin/bash
REPO=/Users/keithadair/Code/keith-hub
LOG=$REPO/logs/deploy.log

cd $REPO
git fetch origin main --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git pull --ff-only
  npm install --production
  npm run build
  pm2 restart the-feed
  mkdir -p $REPO/logs
  echo "$(date): Deployed $(git rev-parse --short HEAD)" >> $LOG
fi
