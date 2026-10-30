#!/bin/bash
# Pulls the latest code and restarts the running service. Run as root on the
# server as a single line (no chained && to worry about the console mangling):
#   curl -fsSL https://raw.githubusercontent.com/Klee0120/Prototype/claude/labor-allocation-prototype-b0y12v/scripts/redeploy.sh | bash
set -euo pipefail

APP_DIR="/opt/labor-allocation"
BRANCH="claude/labor-allocation-prototype-b0y12v"

echo "== Pulling latest code =="
git -C "$APP_DIR" fetch origin "$BRANCH"
git -C "$APP_DIR" checkout "$BRANCH"
git -C "$APP_DIR" reset --hard "origin/$BRANCH"

echo "== Installing dependencies =="
cd "$APP_DIR"
npm install --omit=dev

echo "== Restarting service =="
systemctl restart labor-allocation

echo ""
echo "DONE — redeployed and restarted."
