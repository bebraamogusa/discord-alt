# Discord Alt

Discord Alt is a self-hosted chat service with a browser client and a small native Windows client. The server runs Node.js, SQLite, mediasoup, and nginx in Docker Compose.

The shipped clients use one fixed production endpoint:

```text
https://lolihentai.online
```

This is a fixed production URL, not a configurable server field. Its TLS certificate must contain `DNS:lolihentai.online` in the Subject Alternative Name (SAN).

## Capabilities

| Capability | Browser at the fixed HTTPS endpoint | Native Windows client |
|---|---:|---:|
| Register and sign in | Yes | Yes |
| Guild/server and text-channel navigation | Yes | Yes |
| Read and send text messages | Yes | Yes |
| Upload and download files | Yes | No |
| Voice and video | Yes | No |
| Screen sharing | Yes | No |
| Browser notifications and realtime Socket.io updates | Yes | No |

The browser client is the supported and complete client. The native Windows client is legacy and unsupported: it currently provides account access, guild/channel navigation, message history, and text messaging only. Do not use it for production troubleshooting or expect feature parity, accessibility fixes, or ongoing maintenance there.

The native client repaints automatically for window input and only uses a short bounded poll while an HTTP task is active, so an idle window does not run an unconditional timer.

## Production deployment

Follow [`DEPLOY.md`](DEPLOY.md) for the executable production procedure. It covers:

- Ubuntu/Debian prerequisites, firewall rules, and Docker Compose
- The fixed public IP and the required IP SAN certificate
- Required `.env` values and `install.sh --validate` / `--dry-run`
- Health checks, logs, first account setup, uploads, and voice verification
- Updates, rollback, TLS renewal, and integrity-checked backup/restore

The public firewall should expose only TCP `80`, TCP `443`, and UDP `30000-30200`. Port `3000` is the internal app port behind nginx and must not be published to the Internet.

## Quick operational commands

Run these from the deployment directory after installation:

```bash
docker compose ps
docker compose logs -f app
docker compose logs -f nginx
docker compose up -d --build
curl -fsS https://lolihentai.online/api/health
```

Never enter credentials through an `http://` URL or send them through a proxy that downgrades HTTPS. Use the fixed `https://` endpoint only.

## Build the native client

Install Rust with [rustup](https://rustup.rs) and Node.js 18 or newer on Windows. Then:

```powershell
cd app
npm install
npm run package:windows
```

The distributable executable is `app/release-staging/discord-alt.exe`; the package also includes its SHA-256 checksum and deployment documentation. The build output in `app/src-tauri/target` is temporary and may be deleted after packaging. The client already targets `https://lolihentai.online`; it does not ask for a server URL.

## Tests

The server suite uses Node.js 20 or newer. Browser startup coverage uses Playwright Chromium and creates a temporary SQLite database and upload directory; it does not contact the production service.

```powershell
cd server
npm install
npx playwright install chromium
npm run test
npm run test:e2e
```

`npm run test:e2e:headed` is available for local diagnosis. The E2E runner starts the server with media workers and cron jobs disabled because voice and scheduled cleanup are outside its startup/auth contract.

## Repository layout

```text
server/                 Node.js API, auth, SQLite, Socket.io, mediasoup
client/                 Browser client served by the API
app/src-tauri/          Native Windows client source
docker-compose.yml      App and nginx services
nginx/                  HTTPS reverse-proxy template and certificate mount
install.sh              Ubuntu/Debian install and update script
DEPLOY.md               Production runbook
```
