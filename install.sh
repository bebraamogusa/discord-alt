#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
#  Discord Alt — Server Install Script
#  Usage: curl -fsSL https://raw.githubusercontent.com/YOUR_USER/discord-alt/main/install.sh | bash
#  Or:    wget -qO- https://raw.githubusercontent.com/YOUR_USER/discord-alt/main/install.sh | bash
# ═══════════════════════════════════════════════════════════

REPO="https://github.com/YOUR_USER/discord-alt.git"
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
  git pull --ff-only
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

# ── Optional: Caddy for HTTPS ────────────────────────────
if [ -n "$DOMAIN" ]; then
  echo ""
  ask "Install Caddy for automatic HTTPS? [Y/n]: "
  read -r do_caddy
  do_caddy="${do_caddy:-Y}"

  if [[ "$do_caddy" =~ ^[Yy] ]]; then
    if command -v caddy &>/dev/null; then
      log "Caddy already installed"
    else
      warn "Installing Caddy..."
      apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
      curl -1sLf 'https://dl.cloudflare.com/apt/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
      curl -1sLf 'https://dl.cloudflare.com/apt/stable.list' \
        | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      apt-get update -qq && apt-get install -y -qq caddy
      log "Caddy installed"
    fi

    # Write Caddyfile
    cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy localhost:${PORT}
}
EOF
    systemctl restart caddy
    systemctl enable caddy
    log "Caddy configured for ${DOMAIN} with auto HTTPS"
    echo ""
    log "Open https://${DOMAIN} in your browser"
  else
    warn "Skipped Caddy. Set up your own reverse proxy for HTTPS."
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
