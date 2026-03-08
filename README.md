# Discord Alt

Desktop messenger + self-hosted server for 2–5 people.  
Text chat, video calls, screen sharing, file uploads.

---

## Architecture

```
┌──────────────────────┐         ┌──────────────────────┐
│  Desktop App (Tauri)  │ ──────▶ │   Server (Docker)     │
│  Windows / Linux      │ Socket  │   Node.js + SQLite    │
│  ~5 MB                │  .io    │   VPS 1 CPU / 1 GB   │
└──────────────────────┘         └──────────────────────┘
        │                                 │
        └────── WebRTC P2P (media) ──────┘
```

## Project Structure

```
├── app/                          # Tauri desktop application
│   ├── package.json              # Tauri CLI
│   ├── scripts/
│   │   └── gen-icons.cjs         # Generates app icons (PNG + ICO)
│   ├── frontend/
│   │   ├── index.html            # UI + CSS
│   │   └── main.js               # App logic (chat, WebRTC, etc.)
│   └── src-tauri/
│       ├── Cargo.toml            # Rust dependencies
│       ├── tauri.conf.json       # Tauri config
│       ├── capabilities/
│       │   └── default.json      # Permission grants
│       └── src/
│           ├── main.rs           # Entry point
│           └── lib.rs            # Tray icon, notifications
│
├── server/                       # Signal server
│   ├── index.js                  # Fastify + Socket.io + SQLite
│   └── package.json
│
├── client/                       # Web client (standalone browser version)
│   └── index.html
│
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## 1. Deploy the Server

### One-command install (Ubuntu/Debian VPS)

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USER/discord-alt/main/install.sh | sudo bash
```

The script will:
- Install Docker, Docker Compose, git (if missing)
- Clone the repo to `/opt/discord-alt`
- Ask for domain, port, upload size
- Build and start the server
- Optionally install Caddy for automatic HTTPS
- Open firewall ports (UFW)

### Manual install

```bash
git clone <repo> && cd discord-alt
cp .env.example .env
# Edit .env if needed (PORT, MAX_FILE_SIZE)
docker-compose up -d
```

Server listens on port 3000. A web client is also available at `http://YOUR_IP:3000`.

### HTTPS (required for WebRTC on non-localhost)

**Option A — Caddy (simplest, auto HTTPS):**

```bash
sudo apt install caddy
```

Create `/etc/caddy/Caddyfile`:

```
chat.example.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl restart caddy
```

**Option B — nginx + certbot:**

```nginx
server {
    listen 80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    server_name chat.example.com;
    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

```bash
sudo certbot --nginx -d chat.example.com
```

---

## 2. Build the Desktop App

### Prerequisites

| Tool | Install |
|------|---------|
| **Rust** | [rustup.rs](https://rustup.rs) |
| **Node.js** >= 18 | [nodejs.org](https://nodejs.org) |
| **System libs** (Linux only) | See below |

**Linux build dependencies (Ubuntu/Debian):**

```bash
sudo apt install -y \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
  patchelf build-essential curl wget file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev
```

**Windows:** No extra dependencies — just Rust + Node.js.

### Build Steps

```bash
cd app

# Install Tauri CLI
npm install

# Generate app icons (PNG + ICO)
npm run icons

# Development mode (opens app window)
npm run dev

# Production build → .exe / .deb / .dmg
npm run build
```

### Build Output

| Platform | Output path |
|----------|-------------|
| Windows  | `src-tauri/target/release/bundle/nsis/*.exe` |
| Windows  | `src-tauri/target/release/bundle/msi/*.msi` |
| Linux    | `src-tauri/target/release/bundle/deb/*.deb` |
| Linux    | `src-tauri/target/release/bundle/appimage/*.AppImage` |
| macOS    | `src-tauri/target/release/bundle/dmg/*.dmg` |

---

## 3. Using the App

1. Launch the built application
2. Enter **Server Address** — e.g. `https://chat.example.com`
3. Enter your **Nickname**
4. Enter a **Room Code** or leave blank to create a new room
5. Click **Connect**

### Features

| Feature | How |
|---------|-----|
| Text chat | Type and press Enter |
| Share room | Click 📋 — copies room code to clipboard |
| Voice / video call | Click 📞, toggle 🎤 📹 |
| Screen share | Click 🖥️ during a call |
| Upload files | Click 📎, drag & drop, or Ctrl+V (images) |
| Notifications | Native OS notifications when window is not focused |
| System tray | Closing the window minimizes to tray. Right-click tray → Show / Quit |

---

## Environment Variables (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `MAX_FILE_SIZE` | `5242880` | Max upload in bytes (5 MB) |
| `UPLOADS_DIR` | `/app/uploads` | File storage path |
| `DB_PATH` | `/app/data/chat.db` | SQLite database path |

---

## TURN Server (optional)

For users behind strict/symmetric NAT, add a TURN server ([coturn](https://github.com/coturn/coturn)):

```bash
sudo apt install coturn
```

Edit `ICE_SERVERS` in `app/frontend/main.js`:

```js
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:YOUR_VPS:3478', username: 'user', credential: 'pass' },
];
```
