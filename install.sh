#!/usr/bin/env bash
set -euo pipefail

# Discord Alt — Docker-only install/update script
# - Does NOT configure SSL/nginx (you already manage it)
# - Installs only required packages
# - Keeps host clean with safe cleanup (optional aggressive cleanup)

REPO_URL="${REPO_URL:-https://github.com/bebraamogusa/discord-alt.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/discord-alt}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-3000}"
MAX_UPLOAD_MB="${MAX_UPLOAD_MB:-25}"
MAX_FILE_SIZE="$((MAX_UPLOAD_MB * 1024 * 1024))"

# Cleanup modes:
# SAFE_CLEANUP=1  -> prune builder cache + dangling images + apt cache/autoremove
# AGGRESSIVE_DOCKER_CLEANUP=1 -> additionally prune ALL stopped containers/networks/unused images/volumes globally
SAFE_CLEANUP="${SAFE_CLEANUP:-1}"
AGGRESSIVE_DOCKER_CLEANUP="${AGGRESSIVE_DOCKER_CLEANUP:-0}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

if [ "${EUID}" -ne 0 ]; then
  err "Run as root: sudo bash install.sh"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  err "This script supports Debian/Ubuntu (apt-get)"
fi

install_base_packages() {
  info "Installing required host packages..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git gnupg
  log "Base packages ready"
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker already installed: $(docker --version)"
    return
  fi

  warn "Docker not found — installing..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  log "Docker installed"
}

resolve_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
    return
  fi

  warn "docker compose plugin missing — installing docker-compose-plugin..."
  apt-get install -y -qq docker-compose-plugin

  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
    log "Docker Compose plugin ready"
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
    log "Using docker-compose binary"
    return
  fi

  err "Docker Compose is not available after installation"
}

upsert_env_var() {
  local env_file="$1"
  local key="$2"
  local value="$3"

  if grep -qE "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf "\n%s=%s\n" "$key" "$value" >> "$env_file"
  fi
}

fetch_repo() {
  if [ -d "${INSTALL_DIR}/.git" ]; then
    info "Existing repo detected — updating..."
    cd "${INSTALL_DIR}"
    git fetch --all --prune
    git checkout "${BRANCH}"
    git pull --ff-only origin "${BRANCH}"
  else
    info "Cloning repository..."
    git clone --branch "${BRANCH}" --single-branch "${REPO_URL}" "${INSTALL_DIR}"
    cd "${INSTALL_DIR}"
  fi

  log "Repository ready at ${INSTALL_DIR}"
}

prepare_runtime_dirs() {
  mkdir -p "${INSTALL_DIR}/uploads" "${INSTALL_DIR}/data" "${INSTALL_DIR}/nginx/certs"
  log "Runtime directories prepared (uploads, data, nginx/certs)"
}

prepare_env() {
  local env_file="${INSTALL_DIR}/.env"

  if [ ! -f "$env_file" ]; then
    cat > "$env_file" <<EOF
PORT=${PORT}
MAX_FILE_SIZE=${MAX_FILE_SIZE}
EOF
    log "Created .env"
  else
    upsert_env_var "$env_file" "PORT" "${PORT}"
    upsert_env_var "$env_file" "MAX_FILE_SIZE" "${MAX_FILE_SIZE}"
    log "Updated .env (PORT, MAX_FILE_SIZE)"
  fi
}

deploy_compose() {
  cd "${INSTALL_DIR}"

  info "Stopping old project containers (this project only)..."
  ${COMPOSE} down --remove-orphans || true

  info "Building and starting containers..."
  ${COMPOSE} up -d --build --remove-orphans

  log "Containers are up"
}

safe_cleanup() {
  if [ "${SAFE_CLEANUP}" != "1" ]; then
    warn "Safe cleanup skipped (SAFE_CLEANUP=${SAFE_CLEANUP})"
    return
  fi

  info "Running safe cleanup (no deletion of active containers/volumes)..."
  docker builder prune -f >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  apt-get autoremove -y -qq >/dev/null 2>&1 || true
  apt-get clean -y >/dev/null 2>&1 || true
  log "Safe cleanup completed"
}

aggressive_docker_cleanup() {
  if [ "${AGGRESSIVE_DOCKER_CLEANUP}" != "1" ]; then
    return
  fi

  warn "Running AGGRESSIVE Docker cleanup (global prune, may remove unused resources of other projects)..."
  docker system prune -af --volumes || true
  log "Aggressive Docker cleanup completed"
}

print_summary() {
  echo ""
  echo -e "${GREEN}════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  Install/Update complete (Docker-only mode)${NC}"
  echo -e "${GREEN}════════════════════════════════════════════${NC}"
  echo ""
  echo "Path: ${INSTALL_DIR}"
  echo "Port: ${PORT}"
  echo "Max upload: ${MAX_UPLOAD_MB} MB"
  echo ""
  echo "Useful commands:"
  echo "  cd ${INSTALL_DIR}"
  echo "  ${COMPOSE} ps"
  echo "  ${COMPOSE} logs -f"
  echo "  ${COMPOSE} restart"
  echo "  ${COMPOSE} down"
  echo "  ${COMPOSE} up -d --build"
  echo ""
  echo "SSL/nginx is intentionally NOT configured by this script."
}

main() {
  info "Starting Discord Alt install/update (Docker-only, no SSL setup)"
  install_base_packages
  install_docker
  resolve_compose_cmd
  fetch_repo
  prepare_runtime_dirs
  prepare_env
  deploy_compose
  safe_cleanup
  aggressive_docker_cleanup
  print_summary
}

main "$@"
