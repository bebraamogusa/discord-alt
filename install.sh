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

    CADDYFILE="/etc/caddy/Caddyfile"

    # ── Detect port 443 situation ──────────────────────
    # Check if something else (xray, nginx, etc.) already holds 443
    PORT443_PID=$(ss -tlnp 'sport = :443' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
    PORT443_PROC=""
    if [ -n "$PORT443_PID" ]; then
      PORT443_PROC=$(ps -p "$PORT443_PID" -o comm= 2>/dev/null || echo "unknown")
    fi

    if [ -n "$PORT443_PID" ] && [ "$PORT443_PROC" != "caddy" ]; then
      # Another process owns 443 (xray, nginx, etc.)
      # Caddy must NOT try to bind 443 — use a fallback HTTP port instead
      warn "Port 443 is used by ${PORT443_PROC} (PID ${PORT443_PID})"
      warn "Caddy will listen on HTTP-only port (no auto-HTTPS)"

      # Find the port Caddy was previously using (check existing Caddyfile)
      CADDY_PORT=""
      if [ -f "$CADDYFILE" ]; then
        CADDY_PORT=$(grep -oP '^:\K[0-9]+' "$CADDYFILE" | head -1)
      fi

      # If no existing port, find a free one
      if [ -z "$CADDY_PORT" ]; then
        for p in 8080 8443 9090 8880; do
          if ! ss -tlnp "sport = :${p}" 2>/dev/null | grep -q LISTEN; then
            CADDY_PORT=$p
            break
          fi
        done
      fi

      # Verify the chosen port is actually free (could be occupied by zombie caddy)
      if ss -tlnp "sport = :${CADDY_PORT}" 2>/dev/null | grep -q LISTEN; then
        CADDY_HOLDER=$(ss -tlnp "sport = :${CADDY_PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
        CADDY_HOLDER_NAME=$(ps -p "$CADDY_HOLDER" -o comm= 2>/dev/null || echo "")
        if [ "$CADDY_HOLDER_NAME" = "caddy" ]; then
          warn "Killing orphan caddy process (PID ${CADDY_HOLDER}) on port ${CADDY_PORT}..."
          kill "$CADDY_HOLDER" 2>/dev/null; sleep 1
          kill -9 "$CADDY_HOLDER" 2>/dev/null || true
        fi
      fi

      CADDY_PORT="${CADDY_PORT:-8080}"

      # Write Caddyfile — HTTP-only on chosen port, no domain (avoids auto-HTTPS)
      cp "$CADDYFILE" "${CADDYFILE}.bak" 2>/dev/null || true
      cat > "$CADDYFILE" <<EOF
:${CADDY_PORT} {
    reverse_proxy localhost:${PORT}
}
EOF
      log "Caddyfile: :${CADDY_PORT} → localhost:${PORT}"
      warn "Configure ${PORT443_PROC} to proxy ${DOMAIN} → 127.0.0.1:${CADDY_PORT}"
      warn "Or directly to 127.0.0.1:${PORT} (Caddy not strictly needed)"

    else
      # Port 443 is free or Caddy already owns it — use domain with auto-HTTPS
      # Kill any orphan caddy processes not managed by systemd
      if pgrep -x caddy &>/dev/null; then
        warn "Killing orphan caddy processes..."
        pkill -x caddy; sleep 1
        pkill -9 -x caddy 2>/dev/null || true
      fi

      # Check if this domain block already exists
      if grep -qF "${DOMAIN}" "$CADDYFILE" 2>/dev/null; then
        warn "Domain ${DOMAIN} already exists in Caddyfile — updating..."
        cp "$CADDYFILE" "${CADDYFILE}.bak"
        python3 -c "
import re
text = open('${CADDYFILE}').read()
pattern = re.escape('${DOMAIN}') + r'\s*\{[^}]*\}'
text = re.sub(pattern, '', text).strip()
open('${CADDYFILE}', 'w').write(text + '\n')
" 2>/dev/null || true
      fi

      echo "" >> "$CADDYFILE"
      cat >> "$CADDYFILE" <<EOF
${DOMAIN} {
    reverse_proxy localhost:${PORT}
}
EOF
    fi

    caddy fmt --overwrite "$CADDYFILE" 2>/dev/null || true
    log "Caddyfile written"
    echo "  ─── Caddyfile ───"
    cat "$CADDYFILE"
    echo "  ─────────────────"

    # ── Kill ALL orphan caddy processes before systemd start ──
    systemctl stop caddy 2>/dev/null || true
    if pgrep -x caddy &>/dev/null; then
      warn "Stopping orphan caddy processes..."
      pkill -x caddy 2>/dev/null; sleep 2
      pkill -9 -x caddy 2>/dev/null || true
      sleep 1
    fi

    # Verify nothing is on our target port
    if [ -n "$CADDY_PORT" ]; then
      CHECK_PORT=$CADDY_PORT
    else
      CHECK_PORT=443
    fi

    if ss -tlnp "sport = :${CHECK_PORT}" 2>/dev/null | grep -q caddy; then
      err "Could not free port ${CHECK_PORT} from caddy. Kill it manually: pkill -9 caddy"
    fi

    # ── Start Caddy via systemd ──────────────────────
    if systemctl start caddy; then
      systemctl enable caddy 2>/dev/null || true
      log "Caddy started successfully"
    else
      warn "Caddy failed to start. Diagnostics:"
      systemctl status caddy --no-pager -l 2>&1 | tail -5
      echo ""
      warn "Try: pkill -9 caddy && systemctl start caddy"
    fi

    if systemctl is-active --quiet caddy; then
      if [ -n "$PORT443_PID" ] && [ "$PORT443_PROC" != "caddy" ]; then
        log "Caddy running on :${CADDY_PORT}"
        echo ""
        log "App direct: http://YOUR_IP:${PORT}"
        warn "For HTTPS: configure ${PORT443_PROC} fallback → 127.0.0.1:${CADDY_PORT} or 127.0.0.1:${PORT}"
      else
        log "Caddy running — https://${DOMAIN}"
        echo ""
        log "Open https://${DOMAIN} in your browser"
      fi
    else
      echo ""
      warn "Caddy is not running."
      log "App is still available at http://YOUR_IP:${PORT}"
      warn "Debug: journalctl -xeu caddy.service"
    fi
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
