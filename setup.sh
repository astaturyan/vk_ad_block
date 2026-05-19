#!/bin/bash
# MTA Subway Tracker — one-command server setup
# Run as root on a fresh Ubuntu/Debian VPS with nginx

set -euo pipefail

REPO="https://github.com/astaturyan/vk_ad_block.git"
BRANCH="claude/mta-subway-tracker-85QGp"
APP_DIR="/opt/mta-tracker"
SERVICE="mta-tracker"
PORT=3001
HTPASSWD="/etc/nginx/.htpasswd"
AUTH_USER="mta"
AUTH_PASS="Q1Ml9BoH"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NYC MTA Subway Tracker — Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Node.js ──────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(+process.version.slice(1)>=18?0:1)' 2>/dev/null; echo $?)" != "0" ]]; then
  echo "→ Installing Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
fi
echo "✓ Node $(node --version)"

# ── nginx + htpasswd tool ─────────────────
apt-get install -y nginx apache2-utils git >/dev/null 2>&1
echo "✓ nginx $(nginx -v 2>&1 | grep -oP 'nginx/\K[\d.]+')"

# ── Clone / update repo ───────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo "→ Updating app…"
  git -C "$APP_DIR" fetch origin "$BRANCH" >/dev/null 2>&1
  git -C "$APP_DIR" checkout "$BRANCH"      >/dev/null 2>&1
  git -C "$APP_DIR" pull origin "$BRANCH"   >/dev/null 2>&1
else
  echo "→ Cloning repo…"
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" --single-branch "$REPO" "$APP_DIR" >/dev/null 2>&1
fi
echo "✓ Code at $APP_DIR"

# ── npm install ───────────────────────────
cd "$APP_DIR/mta"
npm install --production --silent
echo "✓ Dependencies installed"

# ── Basic Auth ────────────────────────────
htpasswd -bc "$HTPASSWD" "$AUTH_USER" "$AUTH_PASS" >/dev/null 2>&1
echo "✓ Basic Auth: user=$AUTH_USER  pass=$AUTH_PASS"

# ── nginx config ─────────────────────────
NGINX_SITE="/etc/nginx/sites-available/mta-tracker"
cat > "$NGINX_SITE" <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Existing site root (keep it working)
    location / {
        root /var/www/html;
        index index.html index.htm;
        try_files \$uri \$uri/ =404;
    }

    # MTA Tracker at /mta/
    location /mta/ {
        auth_basic "NYC Subway";
        auth_basic_user_file $HTPASSWD;

        proxy_pass         http://127.0.0.1:$PORT/;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_read_timeout 10s;
    }
}
NGINX

# Disable default site, enable ours
rm -f /etc/nginx/sites-enabled/default
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/mta-tracker

nginx -t >/dev/null 2>&1 && systemctl reload nginx
echo "✓ nginx configured"

# ── systemd service ───────────────────────
cat > "/etc/systemd/system/${SERVICE}.service" <<SERVICE
[Unit]
Description=NYC MTA Subway Tracker
After=network.target

[Service]
WorkingDirectory=$APP_DIR/mta
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=$PORT
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable  "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  echo "✓ Service running"
else
  echo "✗ Service failed to start — check: journalctl -u $SERVICE -n 30"
  exit 1
fi

# ── Done ─────────────────────────────────
SERVER_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Done!"
echo ""
echo "  URL:      http://$SERVER_IP/mta/"
echo "  Login:    $AUTH_USER / $AUTH_PASS"
echo ""
echo "  Change password:"
echo "  htpasswd $HTPASSWD $AUTH_USER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
