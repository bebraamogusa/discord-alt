const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const files = [
  ['client/api.js', "export const PRODUCTION_SERVER_URL = 'https://lolihentai.online';"],
  ['app/frontend/main.js', "const SERVER_URL = 'https://lolihentai.online';"],
  ['app/src-tauri/src/main.rs', 'const PRODUCTION_SERVER_URL: &str = "https://lolihentai.online";'],
];

for (const [relative, required] of files) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  if (!source.includes(required)) throw new Error(`${relative} is missing the fixed production endpoint`);
}

const forbidden = [
  ['client/api.js', 'da_server_url'],
  ['client/app.html', 'server-url'],
  ['client/src/auth.js', 'setServerUrl'],
  ['app/frontend/main.js', 'inp-server'],
  ['app/src-tauri/src/main.rs', 'server-url.txt'],
];

const clientApp = fs.readFileSync(path.join(root, 'client/app.js'), 'utf8');
if (!clientApp.includes("API.get('/api/guilds/@me')")) {
  throw new Error('client/app.js must load guilds from /api/guilds/@me');
}
if (clientApp.includes("API.get('/api/users/@me/guilds')")) {
  throw new Error('client/app.js still uses the nonexistent guild endpoint');
}

const auth = fs.readFileSync(path.join(root, 'client/src/auth.js'), 'utf8');
if (!auth.includes("typeof socket.disconnect === 'function'")) {
  throw new Error('client logout must guard disconnect calls');
}
if (!auth.includes('window.socket')) {
  throw new Error('client logout must use the active gateway socket fallback');
}

for (const [relative, value] of forbidden) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  if (source.includes(value)) throw new Error(`${relative} still contains ${value}`);
}

console.log('production server policy checks passed');
