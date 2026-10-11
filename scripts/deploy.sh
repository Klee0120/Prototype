#!/bin/bash
# One-shot setup for a fresh Ubuntu 24.04 droplet: installs Node.js 22,
# pulls this app, runs it as a systemd service (on an internal port) behind
# Caddy, which handles public-facing HTTP/HTTPS.
#
# Run as root on the server:
#   curl -fsSL https://raw.githubusercontent.com/Klee0120/Prototype/claude/labor-allocation-prototype-b0y12v/scripts/deploy.sh | bash
# That serves plain HTTP by IP, same as before.
#
# Once you own a domain and its DNS A record (and "www" if used) points at
# this droplet's public IP, set DOMAIN to get free, auto-renewing HTTPS via
# Caddy + Let's Encrypt with no further manual cert work. DOMAIN must be set
# on the `bash` side of the pipe (not before `curl`) for it to actually
# reach the script:
#   curl -fsSL https://raw.githubusercontent.com/Klee0120/Prototype/claude/labor-allocation-prototype-b0y12v/scripts/deploy.sh | DOMAIN=www.serviceworks.com bash
#
# To turn on the "forgot my PIN" emailed-reset-link feature (see
# server/utils/mailer.js), also set SMTP_HOST/SMTP_USER/SMTP_PASS (and
# PUBLIC_BASE_URL so the emailed link points at the right place) the same
# way, all on the `bash` side of the pipe:
#   curl -fsSL https://raw.githubusercontent.com/Klee0120/Prototype/claude/labor-allocation-prototype-b0y12v/scripts/deploy.sh | DOMAIN=services-works.com SMTP_HOST=smtp.gmail.com SMTP_USER=you@gmail.com SMTP_PASS='your16charapppassword' PUBLIC_BASE_URL=https://services-works.com bash
# Until those are set, the forgot-PIN flow still runs end-to-end (the
# reset token is created either way) but mailer.js just logs what it would
# have sent instead of delivering it -- see README "Where this stands".
set -euo pipefail

REPO_URL="https://github.com/Klee0120/Prototype.git"
BRANCH="claude/labor-allocation-prototype-b0y12v"
APP_DIR="/opt/labor-allocation"
APP_PORT=3000
DOMAIN="${DOMAIN:-}"
SMTP_HOST="${SMTP_HOST:-}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
SMTP_FROM="${SMTP_FROM:-$SMTP_USER}"
# Defaults to the domain itself (once one is set) rather than making you
# pass the same thing twice -- without this, a reset-PIN email would link
# to this box's own internal localhost:$APP_PORT, which nobody else can
# ever reach.
if [ -z "${PUBLIC_BASE_URL:-}" ] && [ -n "$DOMAIN" ]; then
  PUBLIC_BASE_URL="https://$DOMAIN"
fi
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"

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
Environment=PORT=$APP_PORT
Environment=NODE_ENV=production
Environment=SMTP_HOST=$SMTP_HOST
Environment=SMTP_PORT=$SMTP_PORT
Environment=SMTP_USER=$SMTP_USER
Environment=SMTP_PASS=$SMTP_PASS
Environment=SMTP_FROM=$SMTP_FROM
Environment=PUBLIC_BASE_URL=$PUBLIC_BASE_URL

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now labor-allocation
systemctl restart labor-allocation

echo "== Installing Caddy =="
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

echo "== Configuring Caddy =="
if [ -n "$DOMAIN" ]; then
  # Caddy auto-issues and renews a Let's Encrypt cert for $DOMAIN the first
  # time it's requested -- no certbot, no manual renewal cron.
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy localhost:$APP_PORT
}
EOF
else
  # No domain yet -- plain HTTP on port 80, same as the app served directly
  # before Caddy was introduced.
  cat > /etc/caddy/Caddyfile <<EOF
:80 {
    reverse_proxy localhost:$APP_PORT
}
EOF
fi

systemctl enable --now caddy
systemctl restart caddy

echo "== Configuring firewall =="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
# $APP_PORT is deliberately not opened -- it's only reachable from Caddy on
# this same machine (ufw default-denies incoming by default), so the app is
# never reachable directly, bypassing Caddy/TLS.
ufw --force enable

PUBLIC_IP=$(curl -s ifconfig.me || echo "<your-droplet-ip>")
echo ""
if [ -n "$DOMAIN" ]; then
  echo "DONE — visit https://$DOMAIN"
  echo "(the first request may take a few seconds while Caddy issues the certificate)"
else
  echo "DONE — visit http://$PUBLIC_IP"
  echo ""
  echo "Once you own a domain and its DNS A record points at $PUBLIC_IP, re-run:"
  echo "  curl -fsSL https://raw.githubusercontent.com/Klee0120/Prototype/$BRANCH/scripts/deploy.sh | DOMAIN=www.yourdomain.com bash"
fi
if [ -n "$SMTP_HOST" ] && [ -n "$SMTP_USER" ] && [ -n "$SMTP_PASS" ]; then
  echo "Email delivery is configured (sending as $SMTP_FROM) -- the 'forgot my PIN' link will actually arrive."
else
  echo "Email isn't configured yet -- 'forgot my PIN' requests are logged, not delivered. See this script's header comment for how to turn it on."
fi
echo "NOTE: re-running this full setup script (as opposed to redeploy.sh) always rewrites the systemd service file -- any env var not passed on a given run (DOMAIN, SMTP_*, PUBLIC_BASE_URL) reverts to unset, even if a previous run had it configured. Pass the full set every time you run deploy.sh itself; redeploy.sh (the normal pull-and-restart script) never touches this and is safe to run on its own."
