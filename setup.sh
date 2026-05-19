#!/bin/bash
# MTA Subway Tracker — safe deploy on existing nginx server.
# Adds a dedicated nginx server block for /mta/ — does not touch existing configs.

set -euo pipefail

REPO="https://github.com/astaturyan/vk_ad_block.git"
BRANCH="claude/mta-subway-tracker-85QGp"
APP_DIR="/opt/mta-tracker"
SERVICE="mta-tracker"
PORT=3001
HTPASSWD="/etc/nginx/.htpasswd-mta"
AUTH_USER="mta"
AUTH_PASS="Q1Ml9BoH"
NGINX_SITE="/etc/nginx/sites-available/mta-tracker"
NGINX_LINK="/etc/nginx/sites-enabled/mta-tracker"
SERVER_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NYC MTA Subway Tracker — Deploy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Node.js 20 ──────────────────────────
if ! command -v node &>/dev/null \
   || ! node -e 'process.exit(parseInt(process.version.slice(1))>=18?0:1)' 2>/dev/null; then
  echo "→ Installing Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
fi
echo "✓ Node $(node --version)"

# ── htpasswd tool ───────────────────────
if ! command -v htpasswd &>/dev/null; then
  apt-get install -y apache2-utils >/dev/null 2>&1
fi

# ── Clone / update repo ─────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo "→ Updating repo…"
  git -C "$APP_DIR" fetch origin "$BRANCH" >/dev/null 2>&1
  git -C "$APP_DIR" reset --hard "origin/$BRANCH" >/dev/null 2>&1
else
  echo "→ Cloning repo…"
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" --single-branch "$REPO" "$APP_DIR" >/dev/null 2>&1
fi
echo "✓ Code at $APP_DIR"

# ── npm install ─────────────────────────
cd "$APP_DIR/mta"
npm install --omit=dev --silent
echo "✓ Dependencies installed"

# ── Basic Auth ──────────────────────────
htpasswd -bc "$HTPASSWD" "$AUTH_USER" "$AUTH_PASS" >/dev/null 2>&1
echo "✓ Basic Auth user=$AUTH_USER  pass=$AUTH_PASS"

# ── systemd service ─────────────────────
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
  echo "✓ Service running on 127.0.0.1:$PORT"
else
  echo "✗ Service failed — see: journalctl -u $SERVICE -n 30"
  exit 1
fi

# ── Standalone nginx server block ───────
# Matches Host: <SERVER_IP> on port 80 — does not conflict with the existing
# default_server (which keeps serving its own server_name).
cat > "$NGINX_SITE" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_IP;

    location /mta/ {
        auth_basic           "NYC Subway";
        auth_basic_user_file $HTPASSWD;

        proxy_pass           http://127.0.0.1:$PORT/;
        proxy_http_version   1.1;
        proxy_set_header     Host \$host;
        proxy_set_header     X-Real-IP \$remote_addr;
        proxy_set_header     X-Forwarded-Proto \$scheme;
        proxy_read_timeout   15s;
    }

    location / { return 404; }
}
NGINX

ln -sf "$NGINX_SITE" "$NGINX_LINK"

if ! nginx -t 2>&1; then
  echo "✗ nginx config test failed"
  rm -f "$NGINX_LINK"
  exit 1
fi

systemctl reload nginx
echo "✓ nginx reloaded"

# ── Done ────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Done!"
echo ""
echo "  Open : http://$SERVER_IP/mta/"
echo "  Login: $AUTH_USER / $AUTH_PASS"
echo ""
echo "  Logs : journalctl -u $SERVICE -f"
echo "  Stop : systemctl stop $SERVICE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
