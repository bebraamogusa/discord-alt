#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
#  Discord Alt — Server Install Script
#  Usage: curl -fsSL https://raw.githubusercontent.com/YOUR_USER/discord-alt/main/install.sh | bash
#  Or:    wget -qO- https://raw.githubusercontent.com/YOUR_USER/discord-alt/main/install.sh | bash
# ═══════════════════════════════════════════════════════════

REPO="https://github.com/bebraamogusa/discord-alt.git"
INSTALL_DIR="/opt/discord-alt"
DOMAIN=""
PORT=3000

# ── Colors ───────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
ask()  { echo -en "${CYAN}[?]${NC} $1"; }

# ── Root check ───────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  err "Run as root: sudo bash install.sh"
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║      Discord Alt — Server Setup      ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ── Gather info ──────────────────────────────────────────
ask "Domain name (leave empty for IP-only access): "
read -r DOMAIN
echo ""

ask "Server port [3000]: "
read -r inp_port
PORT="${inp_port:-3000}"

ask "Max file upload size in MB [10]: "
read -r inp_size
MAX_MB="${inp_size:-10}"
MAX_FILE_SIZE=$((MAX_MB * 1024 * 1024))

echo ""

# ── Install Docker if missing ────────────────────────────
install_docker() {
  if command -v docker &>/dev/null; then
    log "Docker already installed: $(docker --version)"
    return
  fi
  warn "Docker not found — installing..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  log "Docker installed"
}

install_docker_compose() {
  if docker compose version &>/dev/null; then
    log "Docker Compose (plugin) available"
    COMPOSE="docker compose"
    return
  fi
  if command -v docker-compose &>/dev/null; then
    log "docker-compose found: $(docker-compose --version)"
    COMPOSE="docker-compose"
    return
  fi
  warn "Installing Docker Compose plugin..."
  apt-get install -y docker-compose-plugin 2>/dev/null || {
    local ARCH; ARCH=$(uname -m)
    [ "$ARCH" = "x86_64" ] && ARCH="x86_64"
    [ "$ARCH" = "aarch64" ] && ARCH="aarch64"
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  }
  COMPOSE="docker compose"
  log "Docker Compose installed"
}

install_git() {
  if command -v git &>/dev/null; then
    log "Git already installed"
    return
  fi
  warn "Installing git..."
  apt-get update -qq && apt-get install -y -qq git
  log "Git installed"
}

log "Checking dependencies..."
install_git
install_docker
install_docker_compose

# ── Clone / Update repo ─────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Existing installation found — pulling latest..."
  cd "$INSTALL_DIR"
  # .env may still be tracked locally from old commits — untrack it silently
  git rm --cached .env 2>/dev/null || true
  # Stash any local changes (e.g. .env) so pull doesn't abort
  git stash 2>/dev/null || true
  git pull --ff-only
  # Restore stashed changes (brings back .env if it existed)
  git stash pop 2>/dev/null || true
else
  log "Cloning repository..."
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ── Create .env ──────────────────────────────────────────
cat > "$INSTALL_DIR/.env" <<EOF
PORT=${PORT}
MAX_FILE_SIZE=${MAX_FILE_SIZE}
EOF
log "Created .env (port=${PORT}, max upload=${MAX_MB} MB)"

# ── Create data directories ─────────────────────────────
mkdir -p "$INSTALL_DIR/uploads" "$INSTALL_DIR/data"
log "Created uploads/ and data/ directories"

# ── Build & Start ────────────────────────────────────────
log "Building and starting containers..."
cd "$INSTALL_DIR"
$COMPOSE down --remove-orphans 2>/dev/null || true
$COMPOSE up -d --build

echo ""
log "Server is running on port ${PORT}"

# ── Optional: Nginx for HTTPS ────────────────────────────
if [ -n "$DOMAIN" ]; then
  echo ""
  ask "Install Nginx for reverse proxy + HTTPS? [Y/n]: "
  read -r do_nginx
  do_nginx="${do_nginx:-Y}"

  if [[ "$do_nginx" =~ ^[Yy] ]]; then

    # ── Install Nginx ──────────────────────────────────
    if command -v nginx &>/dev/null; then
      log "Nginx already installed: $(nginx -v 2>&1)"
    else
      warn "Installing Nginx..."
      apt-get update -qq && apt-get install -y -qq nginx
      log "Nginx installed"
    fi

    # ── Install Certbot ────────────────────────────────
    if ! command -v certbot &>/dev/null; then
      warn "Installing Certbot..."
      apt-get install -y -qq certbot python3-certbot-nginx
      log "Certbot installed"
    fi

    # ── Detect port 443 situation ──────────────────────
    PORT443_PID=$(ss -tlnp 'sport = :443' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
    PORT443_PROC=""
    if [ -n "$PORT443_PID" ]; then
      PORT443_PROC=$(ps -p "$PORT443_PID" -o comm= 2>/dev/null || echo "unknown")
    fi

    NGINX_CONF="/etc/nginx/sites-available/discord-alt"
    NGINX_LINK="/etc/nginx/sites-enabled/discord-alt"

    # Remove default site if exists
    rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

    if [ -n "$PORT443_PID" ] && [ "$PORT443_PROC" != "nginx" ]; then
      # 443 is taken by another process (e.g. xray)
      # Nginx listens on :80 only — xray can SNI-split to it
      warn "Port 443 is used by ${PORT443_PROC} (PID ${PORT443_PID})"
      warn "Nginx will listen on :80 only (no automatic HTTPS)"

      cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # Max upload size
    client_max_body_size 110m;

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;

        # WebSocket support (Socket.io)
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";

        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;

        proxy_read_timeout  3600;
        proxy_send_timeout  3600;
    }
}
EOF
      ln -sf "$NGINX_CONF" "$NGINX_LINK"
      nginx -t && systemctl reload nginx
      systemctl enable nginx 2>/dev/null || true
      log "Nginx configured: http://${DOMAIN} → localhost:${PORT}"
      warn "For HTTPS: configure ${PORT443_PROC} to forward ${DOMAIN} → 127.0.0.1:80"
      warn "  Or pass TLS locally and point xray fallback → 127.0.0.1:80"

    else
      # Port 443 is free — full HTTP + auto-HTTPS via certbot
      cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # Max upload size
    client_max_body_size 110m;

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;

        # WebSocket support (Socket.io)
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";

        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;

        proxy_read_timeout  3600;
        proxy_send_timeout  3600;
    }
}
EOF
      ln -sf "$NGINX_CONF" "$NGINX_LINK"

      if nginx -t; then
        systemctl enable --now nginx
        log "Nginx started on :80"
      else
        err "Nginx config test failed. Check /etc/nginx/sites-available/discord-alt"
      fi

      # ── Request SSL certificate ────────────────────
      ask "Request Let's Encrypt SSL certificate for ${DOMAIN}? [Y/n]: "
      read -r do_ssl
      do_ssl="${do_ssl:-Y}"

      if [[ "$do_ssl" =~ ^[Yy] ]]; then
        ask "Email for Let's Encrypt notifications: "
        read -r LE_EMAIL
        LE_EMAIL="${LE_EMAIL:-admin@${DOMAIN}}"

        if certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${LE_EMAIL}" --redirect; then
          log "SSL certificate issued — https://${DOMAIN}"
          # Enable auto-renewal
          systemctl enable certbot.timer 2>/dev/null || \
            (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet") | crontab -
          log "Auto-renewal configured"
        else
          warn "Certbot failed. Common reasons: DNS not pointed to this server yet."
          warn "Run manually later: certbot --nginx -d ${DOMAIN}"
        fi
      else
        warn "Skipped SSL. Run later: certbot --nginx -d ${DOMAIN}"
        log "App available at http://${DOMAIN}"
      fi
    fi

    echo ""
    echo "  ─── Nginx config ───"
    cat "$NGINX_CONF"
    echo "  ────────────────────"

  else
    warn "Skipped Nginx. Set up your own reverse proxy for HTTPS."
    echo ""
    log "Open http://YOUR_IP:${PORT} in your browser"
  fi
else
  echo ""
  log "Open http://YOUR_IP:${PORT} in your browser"
fi

# ── Firewall hint ────────────────────────────────────────
if command -v ufw &>/dev/null; then
  ufw allow "${PORT}/tcp" 2>/dev/null && log "Opened port ${PORT} in UFW"
  if [ -n "$DOMAIN" ]; then
    ufw allow 80/tcp 2>/dev/null
    ufw allow 443/tcp 2>/dev/null
    log "Opened ports 80, 443 in UFW for HTTPS"
  fi
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  Installation complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""
echo "  Useful commands:"
echo "    cd ${INSTALL_DIR}"
echo "    $COMPOSE logs -f          # view logs"
echo "    $COMPOSE restart          # restart"
echo "    $COMPOSE down             # stop"
echo "    $COMPOSE up -d --build    # rebuild & start"
echo ""
