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
# server/utils/mailer.js), also set SENDGRID_API_KEY/SENDGRID_FROM (and
# PUBLIC_BASE_URL so the emailed link points at the right place) the same
# way, all on the `bash` side of the pipe:
#   curl -fsSL https://raw.githubusercontent.com/Klee0120/Prototype/claude/labor-allocation-prototype-b0y12v/scripts/deploy.sh | DOMAIN=services-works.com SENDGRID_API_KEY=yourapikey SENDGRID_FROM=you@example.com PUBLIC_BASE_URL=https://services-works.com bash
# Until those are set, the forgot-PIN flow still runs end-to-end (the
# reset token is created either way) but mailer.js just logs what it would
# have sent instead of delivering it -- see README "Where this stands".
#
# Email sends over SendGrid's HTTP API, not raw SMTP -- confirmed live
# that DigitalOcean (and most cloud hosts) block outbound SMTP ports
# (25/465/587) by default as an anti-spam measure, while ordinary
# outbound HTTPS (what this call makes, same as the Smartsheet sync
# already does) is unrestricted. Plain SMTP credentials will time out
# from a droplet like this one no matter how correct they are.
#
# To turn on AI-generated vendor correspondence summaries (see
# server/utils/aiSummarizer.js), set ANTHROPIC_API_KEY the same way, on
# the `bash` side of the pipe. Until it's set, correspondence still logs
# and files normally -- the summary just stays blank, same "never block
# the real action on this" rule the SendGrid key already follows.
#
# FILE_ENCRYPTION_KEY turns on encryption at rest for every uploaded file
# (COI/W-9/ACH/etc. -- see server/utils/fileEncryption.js). Unlike every
# other key above, this one is REQUIRED for uploads to work at all --
# without it, the app refuses new uploads outright (fail closed) rather
# than silently storing a bank document as plaintext. Generate one with:
#   openssl rand -hex 32
# and pass it the same way as the others. READ THIS BEFORE YOU SET IT:
# losing this key means every file encrypted with it becomes permanently,
# totally unreadable -- there is no "forgot password" recovery for this.
# Save a copy of it somewhere off this server (a password manager, written
# down somewhere safe) the moment you generate it. Unlike every other
# variable here, this script carries an already-set FILE_ENCRYPTION_KEY
# forward automatically on a later re-run even if you don't pass it again
# (see below) -- specifically so a routine re-run (e.g. just to add
# DOMAIN) can never silently "lose" the key and orphan already-encrypted
# files. You only need to pass it explicitly on the very first deploy.
#
# BACKUP_S3_ENDPOINT/BACKUP_S3_BUCKET/BACKUP_S3_REGION/BACKUP_S3_ACCESS_KEY/
# BACKUP_S3_SECRET_KEY turn on pushing the nightly, already-encrypted
# database backup (see server/utils/offsiteBackup.js) to an S3-compatible
# bucket -- AWS S3, DigitalOcean Spaces, MinIO, whatever actually speaks
# the S3 REST API -- so a copy exists somewhere other than this one
# droplet's disk. Optional: until all five are set, backups still run,
# still get encrypted, and still land in server/data/backups/ exactly as
# before, this is purely additive. Example (DigitalOcean Spaces):
#   BACKUP_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
#   BACKUP_S3_BUCKET=serviceworks-backups
#   BACKUP_S3_REGION=nyc3
set -euo pipefail

REPO_URL="https://github.com/Klee0120/Prototype.git"
BRANCH="claude/labor-allocation-prototype-b0y12v"
APP_DIR="/opt/labor-allocation"
APP_PORT=3000
DOMAIN="${DOMAIN:-}"
SENDGRID_API_KEY="${SENDGRID_API_KEY:-}"
SENDGRID_FROM="${SENDGRID_FROM:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
FILE_ENCRYPTION_KEY="${FILE_ENCRYPTION_KEY:-}"
BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_S3_REGION="${BACKUP_S3_REGION:-}"
BACKUP_S3_ACCESS_KEY="${BACKUP_S3_ACCESS_KEY:-}"
BACKUP_S3_SECRET_KEY="${BACKUP_S3_SECRET_KEY:-}"
# Unlike every other var above, carry an already-configured key forward
# automatically if this run didn't pass one -- see this script's header
# comment for why losing this specific key is catastrophic (not just an
# outage) in a way SENDGRID_API_KEY/ANTHROPIC_API_KEY aren't.
if [ -z "$FILE_ENCRYPTION_KEY" ] && [ -f /etc/systemd/system/labor-allocation.service ]; then
  FILE_ENCRYPTION_KEY=$(grep -oP '^Environment=FILE_ENCRYPTION_KEY=\K.*' /etc/systemd/system/labor-allocation.service || true)
fi
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
Environment=SENDGRID_API_KEY=$SENDGRID_API_KEY
Environment=SENDGRID_FROM=$SENDGRID_FROM
Environment=PUBLIC_BASE_URL=$PUBLIC_BASE_URL
Environment=ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
Environment=FILE_ENCRYPTION_KEY=$FILE_ENCRYPTION_KEY
Environment=BACKUP_S3_ENDPOINT=$BACKUP_S3_ENDPOINT
Environment=BACKUP_S3_BUCKET=$BACKUP_S3_BUCKET
Environment=BACKUP_S3_REGION=$BACKUP_S3_REGION
Environment=BACKUP_S3_ACCESS_KEY=$BACKUP_S3_ACCESS_KEY
Environment=BACKUP_S3_SECRET_KEY=$BACKUP_S3_SECRET_KEY

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
if [ -n "$SENDGRID_API_KEY" ] && [ -n "$SENDGRID_FROM" ]; then
  echo "Email delivery is configured (sending as $SENDGRID_FROM via SendGrid) -- the 'forgot my PIN' link will actually arrive."
else
  echo "Email isn't configured yet -- 'forgot my PIN' requests are logged, not delivered. See this script's header comment for how to turn it on."
fi
if [ -n "$FILE_ENCRYPTION_KEY" ]; then
  echo "File encryption at rest is configured -- uploads are encrypted. If this is the first time it's been set, make sure you've saved a copy of the key somewhere off this server, then run 'node scripts/encrypt-existing-uploads.js' from $APP_DIR once to encrypt any files uploaded before now."
else
  echo "FILE_ENCRYPTION_KEY is NOT set -- uploads (COI/W-9/ACH/etc.) are disabled until it is. Generate one with 'openssl rand -hex 32' and re-run this script with FILE_ENCRYPTION_KEY=<key> set. See this script's header comment first -- losing this key once set means permanent data loss."
fi
echo "NOTE: re-running this full setup script (as opposed to redeploy.sh) always rewrites the systemd service file -- any env var not passed on a given run (DOMAIN, SENDGRID_*, PUBLIC_BASE_URL) reverts to unset, even if a previous run had it configured. Pass the full set every time you run deploy.sh itself; redeploy.sh (the normal pull-and-restart script) never touches this and is safe to run on its own. FILE_ENCRYPTION_KEY is the one exception -- it's carried forward automatically from the live service file if you don't pass it, so a routine re-run can never silently orphan already-encrypted files."
