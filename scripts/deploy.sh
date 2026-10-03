#!/bin/bash
# One-shot setup for a fresh Ubuntu 24.04 droplet: installs Node.js 22,
# pulls this app, and runs it as a systemd service that auto-restarts on
# crash or reboot.
#
# Run as root on the server:
#   curl -fsSL https://raw.githubusercontent.com/Klee0120/Prototype/claude/labor-allocation-prototype-b0y12v/scripts/deploy.sh | bash
set -euo pipefail

REPO_URL="https://github.com/Klee0120/Prototype.git"
BRANCH="claude/labor-allocation-prototype-b0y12v"
APP_DIR="/opt/labor-allocation"

echo "== Installing Node.js 22 =="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git ufw

echo "== Fetching app code =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
npm install --omit=dev

echo "== Installing systemd service =="
cat > /etc/systemd/system/labor-allocation.service <<EOF
[Unit]
Description=Labor Allocation App
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Environment=PORT=80
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now labor-allocation
systemctl restart labor-allocation

echo "== Configuring firewall =="
ufw allow OpenSSH
ufw allow 80/tcp
ufw --force enable

PUBLIC_IP=$(curl -s ifconfig.me || echo "<your-droplet-ip>")
echo ""
echo "DONE — visit http://$PUBLIC_IP"
