# Production Deployment

This runbook deploys Discord Alt on an Ubuntu or Debian VPS. nginx terminates HTTPS, proxies the browser client and API to the internal Node app, and exposes mediasoup's UDP range. The shipped browser and native clients always connect to `https://lolihentai.online`.

## Deployment facts

- Public server IP: `143.47.177.235`
- Public web endpoint: `https://lolihentai.online`
- Required TCP ports: `80`, `443`
- Required UDP ports: `30000-30200`
- Internal app port: `3000` (Docker-only; do not publish it)
- Persistent data: `data/` (SQLite) and `uploads/`
- Required nginx value: `DOMAIN` must be a fully qualified hostname, such as `chat.example.com`

The certificate used by nginx must include `DNS:lolihentai.online` in its SAN because the clients connect by this fixed domain. The media server still announces `143.47.177.235` for WebRTC.

## 1. Prepare Ubuntu/Debian

Start with a current supported Ubuntu or Debian release and a sudo-capable user. Install the packages used by the runbook and installer:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git gnupg openssl tar coreutils
```

If the distribution has no `sha256sum` package name, it is provided by `coreutils`, which is normally already installed:

```bash
command -v sha256sum
```

Configure the host firewall. Do not open port `3000`:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 30000:30200/udp
sudo ufw enable
sudo ufw status verbose
```

Point the DNS `A` record for `lolihentai.online` at `143.47.177.235`. Client traffic uses the fixed domain endpoint while WebRTC media uses the fixed public IP.

## 2. Install Docker and obtain TLS

Install Docker Engine with the official convenience script, then log in again so the Docker group change takes effect:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

After starting a new login shell, verify both Docker and Compose:

```bash
docker --version
docker compose version
```

Obtain a certificate and private key from your chosen CA. If using standalone HTTP validation, port `80` must be temporarily free. Before installing, verify the certificate covers the exact deployment name and fixed IP:

```bash
openssl x509 -in /path/to/fullchain.pem -noout -subject -issuer -dates -ext subjectAltName
openssl x509 -in /path/to/fullchain.pem -checkhost lolihentai.online -noout
openssl pkey -in /path/to/privkey.pem -noout
```

The certificate and key must be a matching pair. `install.sh` checks expiry, hostname coverage, key readability, and the key match. It currently does not replace the separate IP-SAN check above, so perform that check explicitly.

## 3. Clone and configure

```bash
git clone https://github.com/bebraamogusa/discord-alt.git
cd discord-alt
```

The installer prompts for missing values interactively. For a repeatable install, set these values and preserve them through sudo:

```bash
export DOMAIN=chat.example.com
export MEDIASOUP_ANNOUNCED_IP=143.47.177.235
export TLS_CERT_FILE=/path/to/fullchain.pem
export TLS_KEY_FILE=/path/to/privkey.pem
sudo --preserve-env=DOMAIN,MEDIASOUP_ANNOUNCED_IP,TLS_CERT_FILE,TLS_KEY_FILE bash install.sh
```

`install.sh` creates or updates `.env` with these production values:

```dotenv
PORT=3000
MAX_FILE_SIZE=26214400
NODE_ENV=production
DOMAIN=chat.example.com
MEDIASOUP_ANNOUNCED_IP=143.47.177.235
JWT_SECRET=<unique random value, at least 32 characters>
CORS_ORIGIN=https://chat.example.com,http://tauri.localhost,tauri://localhost
COOKIE_SECURE=true
COOKIE_SAMESITE=none
```

`JWT_SECRET` is generated with `openssl rand -hex 48` when absent and is not printed. Keep `.env` mode `0600`. Optional application settings include `TEMP_FILE_MAX_AGE_SEC`, `JWT_ACCESS_TTL_SEC`, `JWT_REFRESH_TTL_SEC`, `UPLOADS_ROOT`, and `DB_PATH`; the Docker defaults are normally correct. Never commit `.env`, `data/`, `uploads/`, or certificate files.

For CI or a preflight check, all four deployment inputs are required in a noninteractive shell:

```bash
DOMAIN=chat.example.com \
MEDIASOUP_ANNOUNCED_IP=143.47.177.235 \
TLS_CERT_FILE=/path/to/fullchain.pem \
TLS_KEY_FILE=/path/to/privkey.pem \
bash install.sh --validate
```

`--validate` checks values and TLS without installing packages, changing files, or touching Docker. `--dry-run` performs the same validation and prints the deployment it would perform, also without changing files:

```bash
DOMAIN=chat.example.com MEDIASOUP_ANNOUNCED_IP=143.47.177.235 \
TLS_CERT_FILE=/path/to/fullchain.pem TLS_KEY_FILE=/path/to/privkey.pem \
bash install.sh --dry-run
```

Use `sudo bash install.sh` for a real install. The script installs missing Debian/Ubuntu packages, clones or fast-forwards the configured branch, prepares `data/`, `uploads/`, and `nginx/certs/`, copies the certificate and private key, then runs Compose with `--build`. It defaults to `25 MB` uploads; set `MAX_UPLOAD_MB` before installation if a different limit is required.

## 4. Start and verify

The installer starts the stack. These commands are also the manual startup and health procedure:

```bash
docker compose up -d --build --remove-orphans
docker compose ps
docker compose logs --tail=100 app
docker compose logs --tail=100 nginx
curl -fsS https://lolihentai.online/api/health
```

The `app` healthcheck polls `/api/health`; nginx listens on TCP `80` and `443`; mediasoup publishes UDP `30000-30200`. A successful health response is JSON containing `"ok":true`. The app and nginx containers retain at most three 10 MB JSON log files each.

Open `https://lolihentai.online/app` in a browser. Do not use an `http://` URL or a direct `:3000` URL. Never submit an email or password over HTTP.

## 5. First account and smoke tests

1. In the browser, choose **Register** and provide an email, username, and password of at least eight characters.
2. Sign out and sign back in to verify the refresh-cookie/session path.
3. Create a server and text channel in the browser UI if the new account has none.
4. Send a message, reload, and confirm message history is retained.
5. Attach a file below `MAX_FILE_SIZE`, confirm it appears, then download it.
6. Join a voice channel from two browser sessions, confirm microphone/audio, then test camera and screen sharing if needed.
7. Build or launch the native Windows client, register or sign in again, select a server and channel, and send a text message. Native and browser sessions are independent; the native client does not share browser cookies or local storage.

If voice connects but media does not flow, check the public IP and UDP firewall rule before changing application settings.

## 6. Updates and rollback

Back up first. Then update the checked-out branch and rebuild only this Compose project:

```bash
git status --short
git pull --ff-only
docker compose up -d --build --remove-orphans
docker compose ps
curl -fsS https://lolihentai.online/api/health
```

For a rollback, record the current commit, check out a known-good commit, and rebuild:

```bash
git rev-parse HEAD
git fetch --all --tags
git checkout <known-good-commit-or-tag>
docker compose up -d --build --remove-orphans
docker compose ps
curl -fsS https://lolihentai.online/api/health
```

Do not run global Docker prune commands on a host that runs other projects. The installer’s default cleanup is limited to this deployment’s unused build artifacts and apt cache.

## 7. TLS renewal

Renew the certificate with the same CA and ensure the renewed certificate still contains `DNS:lolihentai.online` (or the configured `DOMAIN`). Then install the renewed files and restart nginx:

```bash
openssl x509 -in /path/to/renewed/fullchain.pem -checkhost "$DOMAIN" -noout
sudo cp /path/to/renewed/fullchain.pem nginx/certs/fullchain.pem
sudo cp /path/to/renewed/privkey.pem nginx/certs/privkey.pem
sudo chmod 644 nginx/certs/fullchain.pem
sudo chmod 600 nginx/certs/privkey.pem
docker compose restart nginx
curl -fsS https://lolihentai.online/api/health
```

Alternatively rerun `install.sh` with the renewed `TLS_CERT_FILE` and `TLS_KEY_FILE`. Never expose or print the private key.

## 8. Backup, restore, and integrity verification

Stop the app while copying SQLite so its WAL is included consistently. This archive contains only persistent data, not credentials or TLS keys:

```bash
set -eu
mkdir -p backups
chmod 700 backups
backup="backups/discord-alt-backup-$(date +%Y%m%d-%H%M%S).tgz"
docker compose stop app
trap 'docker compose start app' EXIT
tar -czf "$backup" data uploads
tar -tzf "$backup" >/dev/null
sha256sum "$backup" > "$backup.sha256"
sha256sum -c "$backup.sha256"
echo "Created and verified $backup"
```

Store the archive and checksum separately from the VPS when possible. Keep `.env` in a separate encrypted secret store; it contains `JWT_SECRET` and is intentionally excluded from the archive.

Restore only after inspecting the archive and verifying its checksum:

```bash
set -eu
backup="backups/discord-alt-backup-YYYYMMDD-HHMMSS.tgz"
sha256sum -c "$backup.sha256"
tar -tzf "$backup"
docker compose stop app
trap 'docker compose start app' EXIT
tar -xzf "$backup" --no-same-owner
docker compose up -d app
docker compose ps
```

Verify SQLite integrity inside the application image after the restore:

```bash
docker compose exec -T app node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database('/app/data/discord-clone.db', { readonly: true }); const result = db.pragma('integrity_check', { simple: true }); if (result !== 'ok') { console.error(result); process.exit(1); } console.log('SQLite integrity: ok'); db.close();"
```

Then repeat the health, login, message, upload, and voice smoke tests. If the archive is corrupt or SQLite integrity is not `ok`, stop the app and restore a different known-good backup.

## Troubleshooting

| Symptom | Checks |
|---|---|
| `502 Bad Gateway` | `docker compose ps`; `docker compose logs app`; confirm the app healthcheck is healthy. |
| Certificate or browser security error | Inspect SAN with `openssl`; it must include `DNS:lolihentai.online`; confirm TCP `443` reaches this VPS. |
| HTTP redirects but login fails | Use `https://lolihentai.online`; verify `COOKIE_SECURE=true`, `COOKIE_SAMESITE=none`, and `CORS_ORIGIN`. Never send credentials over HTTP. |
| Voice has no audio/video | Confirm `MEDIASOUP_ANNOUNCED_IP=143.47.177.235`, UDP `30000-30200` is open at both the VPS firewall and provider firewall, and two browser peers are testing. |
| Upload rejected | Check the file is below `MAX_FILE_SIZE`, `uploads/` is writable, and `docker compose logs app` for multipart errors. |
| Installer stops before changes | Run `install.sh --validate`; check `DOMAIN`, public IP, readable PEM files, certificate expiry, hostname SAN, and matching private key. |
| Native client cannot connect | Verify the certificate has the `lolihentai.online` DNS SAN and that the browser health check succeeds at `https://lolihentai.online/api/health`. |
