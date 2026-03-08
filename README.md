# Discord Alt

Group chat with video calls, screen sharing and image uploads.  
Runs on any VPS with Docker. Supports 2–5 users per room.

## Quick Start

```bash
cp .env.example .env
docker-compose up -d
```

Open `http://YOUR_IP:3000`.

---

## Features

- Login by nickname (no registration)
- Rooms by link — create or share
- Text chat with message history (SQLite)
- Audio / video calls (WebRTC mesh, browser-to-browser)
- Screen sharing (`getDisplayMedia`)
- Image upload via drag & drop, clipboard paste, or attach button

---

## HTTPS with Caddy (recommended)

WebRTC and `getDisplayMedia` require HTTPS (except localhost).  
Caddy auto-provisions Let's Encrypt certificates.

### 1. Install Caddy on the host

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/apt/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudflare.com/apt/stable.list' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

### 2. Create `/etc/caddy/Caddyfile`

```
chat.example.com {
    reverse_proxy localhost:3000
}
```

### 3. Restart Caddy

```bash
sudo systemctl restart caddy
```

Caddy gets a certificate automatically. Point your DNS A-record to the VPS IP.

---

## Alternative: nginx + certbot

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
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo certbot --nginx -d chat.example.com
```

---

## Environment Variables

| Variable       | Default   | Description                |
|----------------|-----------|----------------------------|
| `PORT`         | `3000`    | Internal server port       |
| `MAX_FILE_SIZE`| `5242880` | Max upload size in bytes   |
| `UPLOADS_DIR`  | `/app/uploads` | Image storage path    |
| `DB_PATH`      | `/app/data/chat.db` | SQLite DB path    |

---

## Architecture

```
Browser ──Socket.io──▶ Fastify (Node.js)
       ◀──WebRTC────▶ Browser (mesh P2P)
                       │
                       ├── SQLite (messages)
                       └── /uploads (images)
```

- **Signaling** goes through Socket.io on the server
- **Media streams** flow directly between browsers (WebRTC mesh)
- Works for 2–5 participants; for more, add a TURN server or switch to an SFU

## TURN Server (optional)

For users behind strict/symmetric NAT, add a TURN server.  
The easiest option is [coturn](https://github.com/coturn/coturn):

```bash
sudo apt install coturn
```

Then add TURN credentials to the `ICE` array in `client/index.html`:

```js
const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:YOUR_VPS_IP:3478', username: 'user', credential: 'pass' },
];
```

---

## Project Structure

```
├── client/
│   └── index.html        # Full frontend (HTML + CSS + JS)
├── server/
│   ├── index.js           # Backend (Fastify + Socket.io + SQLite)
│   └── package.json
├── uploads/               # Uploaded images (volume)
├── data/                  # SQLite database (volume)
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```
