#!/bin/bash
# MTA Subway Tracker — safe deploy on existing nginx server.
# Adds a /mta/ location to the default site without touching existing config.

set -euo pipefail

REPO="https://github.com/astaturyan/vk_ad_block.git"
BRANCH="claude/mta-subway-tracker-85QGp"
APP_DIR="/opt/mta-tracker"
SERVICE="mta-tracker"
PORT=3001
HTPASSWD="/etc/nginx/.htpasswd-mta"
AUTH_USER="mta"
AUTH_PASS="Q1Ml9BoH"
NGINX_DEFAULT="/etc/nginx/sites-enabled/default"

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

# ── Backup + patch nginx config ─────────
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="${NGINX_DEFAULT}.bak.${TIMESTAMP}"
cp -a "$NGINX_DEFAULT" "$BACKUP"
echo "✓ Backed up nginx → $BACKUP"

python3 - "$NGINX_DEFAULT" "$HTPASSWD" "$PORT" <<'PY'
import sys, re, pathlib

path, htpasswd, port = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(path).read_text()

START = "    # >>> MTA-TRACKER START >>>"
END   = "    # <<< MTA-TRACKER END <<<"

# Wipe any prior MTA block (so re-runs are safe)
text = re.sub(
    r'[ \t]*# >>> MTA-TRACKER START >>>.*?# <<< MTA-TRACKER END <<<\n?',
    '', text, flags=re.DOTALL
)

mta_block = f"""{START}
    location /mta/ {{
        auth_basic           "NYC Subway";
        auth_basic_user_file {htpasswd};
        proxy_pass           http://127.0.0.1:{port}/;
        proxy_http_version   1.1;
        proxy_set_header     Host $host;
        proxy_set_header     X-Real-IP $remote_addr;
        proxy_set_header     X-Forwarded-Proto $scheme;
        proxy_read_timeout   15s;
    }}
{END}
"""

# Find matching closing brace for each "server {"
def find_server_blocks(s):
    blocks = []
    i = 0
    while True:
        m = re.search(r'\bserver\s*\{', s[i:])
        if not m:
            break
        start = i + m.start()
        brace_start = i + m.end() - 1
        depth = 1
        j = brace_start + 1
        while j < len(s) and depth > 0:
            if s[j] == '{': depth += 1
            elif s[j] == '}': depth -= 1
            j += 1
        blocks.append((start, j))  # j is one past the closing }
        i = j
    return blocks

blocks = find_server_blocks(text)
if not blocks:
    sys.stderr.write("No server blocks found!\n")
    sys.exit(1)

# Inject MTA block right before the closing } of:
#  - the FIRST server block (main HTTPS app on 8444), AND
#  - the SECOND server block (port 80 default_server redirect — so http://IP/mta/ works)
inject_into = []
for idx, (s_start, s_end) in enumerate(blocks[:3]):
    block_text = text[s_start:s_end]
    if idx == 0:
        # Main HTTPS server (port 8444)
        inject_into.append(s_end)
    elif 'listen 80 default_server' in block_text:
        inject_into.append(s_end)

# Inject from the END so offsets stay valid
inject_into.sort(reverse=True)
for closing_pos in inject_into:
    # closing_pos points to one past }, so we insert before the } itself
    insert_at = closing_pos - 1
    text = text[:insert_at] + mta_block + text[insert_at:]

pathlib.Path(path).write_text(text)
print(f"✓ Injected MTA block into {len(inject_into)} server block(s)")
PY

# ── Test + reload ───────────────────────
if ! nginx -t 2>&1; then
  echo "✗ nginx config test failed — REVERTING"
  cp -a "$BACKUP" "$NGINX_DEFAULT"
  exit 1
fi

systemctl reload nginx
echo "✓ nginx reloaded"

# ── Done ────────────────────────────────
SERVER_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Done!"
echo ""
echo "  HTTP  IP   : http://$SERVER_IP/mta/"
echo "  HTTPS dom. : https://app.apexdsp.info:8444/mta/"
echo ""
echo "  Login : $AUTH_USER / $AUTH_PASS"
echo ""
echo "  Logs  : journalctl -u $SERVICE -f"
echo "  Stop  : systemctl stop $SERVICE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
