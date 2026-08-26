#!/usr/bin/env bash
set -euo pipefail

# Discord Alt — Docker install/update script
# - Validates deployment values and stages TLS before changing the deployment
# - Installs only required packages
# - Keeps host clean with safe cleanup (optional aggressive cleanup)

REPO_URL="${REPO_URL:-https://github.com/bebraamogusa/discord-alt.git}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-3000}"
MAX_UPLOAD_MB="${MAX_UPLOAD_MB:-25}"
MAX_FILE_SIZE="$((MAX_UPLOAD_MB * 1024 * 1024))"

VALIDATE_ONLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --validate) VALIDATE_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      printf 'Usage: sudo bash install.sh [--validate|--dry-run]\n'
      printf '  --validate  collect and validate deployment values without changing anything\n'
      printf '  --dry-run   validate values and show the deployment steps without changing anything\n'
      exit 0
      ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

DOMAIN="${DOMAIN:-}"
MEDIASOUP_ANNOUNCED_IP="${MEDIASOUP_ANNOUNCED_IP:-}"
JWT_SECRET="${JWT_SECRET:-}"
TLS_CERT_FILE="${TLS_CERT_FILE:-}"
TLS_KEY_FILE="${TLS_KEY_FILE:-}"

INSTALL_USER="${INSTALL_USER:-${SUDO_USER:-root}}"
INSTALL_USER_HOME="${INSTALL_USER_HOME:-$(getent passwd "${INSTALL_USER}" | cut -d: -f6)}"
if [ -z "${INSTALL_USER_HOME}" ]; then
  INSTALL_USER_HOME="/root"
fi

DEFAULT_INSTALL_DIR="${INSTALL_USER_HOME}/discord/discord-alt"
INSTALL_DIR="${INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"
LEGACY_INSTALL_DIR="${LEGACY_INSTALL_DIR:-/opt/discord-alt}"

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

env_value() {
  local env_file="$1"
  local key="$2"
  [ -f "$env_file" ] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$env_file"
}

prompt_value() {
  local name="$1"
  local prompt="$2"
  local current="${!name}"
  [ -n "$current" ] && return
  if [ ! -t 0 ] || [ ! -r /dev/tty ]; then
    err "${name} is required. Set ${name} in the environment for CI/noninteractive installs."
  fi
  printf '%s: ' "$prompt" >/dev/tty
  IFS= read -r current </dev/tty || err "Could not read ${name} from the terminal"
  [ -n "$current" ] || err "${name} cannot be empty"
  printf -v "$name" '%s' "$current"
}

valid_domain() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] && [[ "$1" != *..* ]] && [[ "$1" == *.* ]]
}

valid_ipv4() {
  local ip="$1" part a b c
  local -a parts
  IFS=. read -r -a parts <<< "$ip"
  [ "${#parts[@]}" -eq 4 ] || return 1
  for part in "${parts[@]}"; do
    [[ "$part" =~ ^[0-9]{1,3}$ ]] || return 1
    [ "$((10#$part))" -le 255 ] || return 1
  done
  a=$((10#${parts[0]})); b=$((10#${parts[1]})); c=$((10#${parts[2]})); d=$((10#${parts[3]}))

  [ "$a" -ne 0 ] || return 1
  [ "$a" -ne 10 ] || return 1
  { [ "$a" -ne 100 ] || [ "$b" -lt 64 ] || [ "$b" -gt 127 ]; } || return 1
  [ "$a" -ne 127 ] || return 1
  { [ "$a" -ne 169 ] || [ "$b" -ne 254 ]; } || return 1
  { [ "$a" -ne 172 ] || [ "$b" -lt 16 ] || [ "$b" -gt 31 ]; } || return 1
  { [ "$a" -ne 192 ] || [ "$b" -ne 0 ] || [ "$c" -ne 0 ]; } || return 1
  { [ "$a" -ne 192 ] || [ "$b" -ne 0 ] || [ "$c" -ne 2 ]; } || return 1
  { [ "$a" -ne 192 ] || [ "$b" -ne 168 ]; } || return 1
  { [ "$a" -ne 198 ] || [ "$b" -lt 18 ] || [ "$b" -gt 19 ]; } || return 1
  { [ "$a" -ne 198 ] || [ "$b" -ne 51 ] || [ "$c" -ne 100 ]; } || return 1
  { [ "$a" -ne 192 ] || [ "$b" -ne 88 ] || [ "$c" -ne 99 ]; } || return 1
  { [ "$a" -ne 203 ] || [ "$b" -ne 0 ] || [ "$c" -ne 113 ]; } || return 1
  [ "$a" -lt 224 ] || return 1
  [ "$ip" != "255.255.255.255" ]
}

valid_jwt_secret() {
  case "${1,,}" in
    change_this_to_a_long_random_secret_at_least_32_chars|change-me-in-env-min-32-characters-please|replace_with_a_long_random_secret|your_jwt_secret_here|the-generated-secret) return 1 ;;
  esac
  [ "${#1}" -ge 32 ]
}

load_existing_values() {
  local env_file="${INSTALL_DIR}/.env"
  local legacy_env="${LEGACY_INSTALL_DIR}/.env"
  [ -f "$env_file" ] || env_file="$legacy_env"
  if [ -f "$env_file" ]; then
    [ -n "$DOMAIN" ] || DOMAIN="$(env_value "$env_file" DOMAIN)"
    [ -n "$MEDIASOUP_ANNOUNCED_IP" ] || MEDIASOUP_ANNOUNCED_IP="$(env_value "$env_file" MEDIASOUP_ANNOUNCED_IP)"
    [ -n "$JWT_SECRET" ] || JWT_SECRET="$(env_value "$env_file" JWT_SECRET)"
  fi
  if [ -z "$TLS_CERT_FILE" ] && [ -r "${INSTALL_DIR}/nginx/certs/fullchain.pem" ]; then
    TLS_CERT_FILE="${INSTALL_DIR}/nginx/certs/fullchain.pem"
  fi
  if [ -z "$TLS_KEY_FILE" ] && [ -r "${INSTALL_DIR}/nginx/certs/privkey.pem" ]; then
    TLS_KEY_FILE="${INSTALL_DIR}/nginx/certs/privkey.pem"
  fi
}

collect_and_validate_values() {
  load_existing_values
  prompt_value DOMAIN "Public HTTPS domain (for example chat.example.com)"
  prompt_value MEDIASOUP_ANNOUNCED_IP "Public IPv4 address for mediasoup"

  if [ -z "$JWT_SECRET" ]; then
    command -v openssl >/dev/null 2>&1 || err "JWT_SECRET is missing and openssl is unavailable; install openssl or set JWT_SECRET explicitly"
    JWT_SECRET="$(openssl rand -hex 48)" || err "Could not generate JWT_SECRET with openssl"
    [ "${#JWT_SECRET}" -ge 64 ] || err "Generated JWT_SECRET was unexpectedly short"
  fi

  valid_domain "$DOMAIN" || err "DOMAIN must be a fully qualified hostname such as chat.example.com (not a URL or IP address)"
  valid_ipv4 "$MEDIASOUP_ANNOUNCED_IP" || err "MEDIASOUP_ANNOUNCED_IP must be a valid public IPv4 address"
  valid_jwt_secret "$JWT_SECRET" || err "JWT_SECRET must be at least 32 characters and must not be a placeholder; generate one with: openssl rand -hex 48"

  [ -n "$TLS_CERT_FILE" ] || TLS_CERT_FILE="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  [ -n "$TLS_KEY_FILE" ] || TLS_KEY_FILE="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
  if [ ! -r "$TLS_CERT_FILE" ]; then
    if [ -t 0 ] && [ -r /dev/tty ]; then
      TLS_CERT_FILE=""
      prompt_value TLS_CERT_FILE "TLS certificate PEM path"
    else
      err "TLS certificate not readable: ${TLS_CERT_FILE}. Set TLS_CERT_FILE or obtain a certificate before deploying"
    fi
  fi
  if [ ! -r "$TLS_KEY_FILE" ]; then
    if [ -t 0 ] && [ -r /dev/tty ]; then
      TLS_KEY_FILE=""
      prompt_value TLS_KEY_FILE "TLS private key PEM path"
    else
      err "TLS private key not readable: ${TLS_KEY_FILE}. Set TLS_KEY_FILE or obtain a certificate before deploying"
    fi
  fi
  command -v openssl >/dev/null 2>&1 || err "openssl is required to validate TLS prerequisites; install it before running the installer"
  openssl x509 -in "$TLS_CERT_FILE" -noout >/dev/null 2>&1 || err "TLS_CERT_FILE is not a readable PEM certificate: ${TLS_CERT_FILE}"
  openssl x509 -in "$TLS_CERT_FILE" -checkend 0 -noout >/dev/null 2>&1 || err "TLS certificate is expired: ${TLS_CERT_FILE}"
  openssl x509 -in "$TLS_CERT_FILE" -checkhost "$DOMAIN" -noout >/dev/null 2>&1 || err "TLS certificate does not cover DOMAIN=${DOMAIN}: ${TLS_CERT_FILE}"
  openssl pkey -in "$TLS_KEY_FILE" -noout >/dev/null 2>&1 || err "TLS_KEY_FILE is not a readable PEM private key: ${TLS_KEY_FILE}"
  cert_key_fingerprint="$(openssl x509 -in "$TLS_CERT_FILE" -pubkey -noout | openssl pkey -pubin -outform der 2>/dev/null | openssl dgst -sha256)" || err "Could not read the TLS certificate public key"
  private_key_fingerprint="$(openssl pkey -in "$TLS_KEY_FILE" -pubout -outform der 2>/dev/null | openssl dgst -sha256)" || err "Could not read the TLS private key public key"
  [ "$cert_key_fingerprint" = "$private_key_fingerprint" ] || err "TLS certificate and private key do not match"
  umask 077
}

show_dry_run() {
  info "Validation passed; no files, packages, containers, or services were changed"
  info "Would deploy domain ${DOMAIN}, mediasoup IP ${MEDIASOUP_ANNOUNCED_IP}, and TLS files from the configured paths"
}

if [ "${EUID}" -ne 0 ]; then
  if [ "$VALIDATE_ONLY" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    collect_and_validate_values
    show_dry_run
    exit 0
  fi
  err "Run as root: sudo bash install.sh"
fi

if [ "$VALIDATE_ONLY" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
  collect_and_validate_values
  show_dry_run
  exit 0
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

migrate_legacy_install() {
  if [ "${LEGACY_INSTALL_DIR}" = "${INSTALL_DIR}" ]; then
    return
  fi

  if [ ! -d "${LEGACY_INSTALL_DIR}" ]; then
    return
  fi

  warn "Found legacy install at ${LEGACY_INSTALL_DIR}"

  if [ -f "${LEGACY_INSTALL_DIR}/docker-compose.yml" ] || [ -f "${LEGACY_INSTALL_DIR}/compose.yml" ]; then
    info "Stopping legacy containers in ${LEGACY_INSTALL_DIR}"
    (
      cd "${LEGACY_INSTALL_DIR}"
      ${COMPOSE} down --remove-orphans || true
    )
  fi

  info "Migrating legacy runtime data to ${INSTALL_DIR} (if present)"
  mkdir -p "${INSTALL_DIR}"

  if [ -d "${LEGACY_INSTALL_DIR}/uploads" ]; then
    mkdir -p "${INSTALL_DIR}/uploads"
    cp -a "${LEGACY_INSTALL_DIR}/uploads/." "${INSTALL_DIR}/uploads/" || true
  fi

  if [ -d "${LEGACY_INSTALL_DIR}/data" ]; then
    mkdir -p "${INSTALL_DIR}/data"
    cp -a "${LEGACY_INSTALL_DIR}/data/." "${INSTALL_DIR}/data/" || true
  fi

  if [ -f "${LEGACY_INSTALL_DIR}/.env" ] && [ ! -f "${INSTALL_DIR}/.env" ]; then
    cp -a "${LEGACY_INSTALL_DIR}/.env" "${INSTALL_DIR}/.env"
  fi

  info "Removing legacy install dir ${LEGACY_INSTALL_DIR}"
  rm -rf "${LEGACY_INSTALL_DIR}"
  log "Legacy install removed"
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
  if [ "${INSTALL_USER}" != "root" ]; then
    chown -R "${INSTALL_USER}:${INSTALL_USER}" "${INSTALL_DIR}" || true
  fi
  log "Runtime directories prepared (uploads, data, nginx/certs)"
}

prepare_env() {
  local env_file="${INSTALL_DIR}/.env"

  if [ ! -f "$env_file" ]; then
    cat > "$env_file" <<EOF
PORT=${PORT}
MAX_FILE_SIZE=${MAX_FILE_SIZE}
NODE_ENV=production
DOMAIN=${DOMAIN}
MEDIASOUP_ANNOUNCED_IP=${MEDIASOUP_ANNOUNCED_IP}
JWT_SECRET=${JWT_SECRET}
CORS_ORIGIN=https://${DOMAIN},http://tauri.localhost,tauri://localhost
COOKIE_SECURE=true
COOKIE_SAMESITE=none
EOF
    log "Created .env"
  else
    upsert_env_var "$env_file" "PORT" "${PORT}"
    upsert_env_var "$env_file" "MAX_FILE_SIZE" "${MAX_FILE_SIZE}"
    upsert_env_var "$env_file" "NODE_ENV" "production"
    upsert_env_var "$env_file" "DOMAIN" "${DOMAIN}"
    upsert_env_var "$env_file" "MEDIASOUP_ANNOUNCED_IP" "${MEDIASOUP_ANNOUNCED_IP}"
    upsert_env_var "$env_file" "JWT_SECRET" "${JWT_SECRET}"
    upsert_env_var "$env_file" "CORS_ORIGIN" "https://${DOMAIN},http://tauri.localhost,tauri://localhost"
    upsert_env_var "$env_file" "COOKIE_SECURE" "true"
    upsert_env_var "$env_file" "COOKIE_SAMESITE" "none"
    log "Updated .env with deployment configuration (secret omitted)"
  fi
  chmod 600 "$env_file"
}

prepare_tls() {
  mkdir -p "${INSTALL_DIR}/nginx/certs"
  cp "$TLS_CERT_FILE" "${INSTALL_DIR}/nginx/certs/fullchain.pem"
  cp "$TLS_KEY_FILE" "${INSTALL_DIR}/nginx/certs/privkey.pem"
  chmod 644 "${INSTALL_DIR}/nginx/certs/fullchain.pem"
  chmod 600 "${INSTALL_DIR}/nginx/certs/privkey.pem"
  log "TLS certificate and private key installed (key contents omitted)"
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
  echo "Domain: ${DOMAIN}"
  echo "Mediasoup announced IP: ${MEDIASOUP_ANNOUNCED_IP}"
  echo ""
  echo "Useful commands:"
  echo "  cd ${INSTALL_DIR}"
  echo "  ${COMPOSE} ps"
  echo "  ${COMPOSE} logs -f"
  echo "  ${COMPOSE} restart"
  echo "  ${COMPOSE} down"
  echo "  ${COMPOSE} up -d --build"
  echo ""
  echo "TLS certificate: ${INSTALL_DIR}/nginx/certs/fullchain.pem"
}

main() {
  info "Collecting and validating deployment configuration"
  collect_and_validate_values
  if [ "$VALIDATE_ONLY" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    show_dry_run
    return
  fi
  info "Starting Discord Alt install/update"
  install_base_packages
  install_docker
  resolve_compose_cmd
  migrate_legacy_install
  fetch_repo
  prepare_runtime_dirs
  prepare_env
  prepare_tls
  deploy_compose
  safe_cleanup
  aggressive_docker_cleanup
  print_summary
}

main "$@"
