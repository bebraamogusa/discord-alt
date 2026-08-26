const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', 'client');
const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'src', 'auth.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'src', 'ui.js'), 'utf8');
const errors = [];

if (!/export async function logout\(\)[\s\S]*?method: 'POST'[\s\S]*?credentials: 'include'/.test(api)) errors.push('API.logout must use a direct credentialed POST');
if (!/logoutInProgress = true;[\s\S]*?API\.clearTokens\(\);[\s\S]*?const serverLogout = API\.logout\(\);/.test(auth)) errors.push('logout must start idempotently and clear tokens before server logout');
if (!/if \(logoutInProgress\) return;/.test(auth)) errors.push('logout reentrancy guard is missing');
if (!/API\.post\('\/api\/auth\/mfa\/totp', \{ ticket: mfaTicket, code \}\)/.test(auth)) errors.push('MFA ticket endpoint handling is missing');
if (!/id="auth-mfa"[\s\S]*?id="mfa-code"[\s\S]*?id="mfa-back"/.test(html)) errors.push('accessible MFA input and back controls are missing');
if (!/export async function fetchProtectedFile\(path\)[\s\S]*?Authorization[\s\S]*?res\.status === 401[\s\S]*?tryRefresh\(\)[\s\S]*?URL\.createObjectURL/.test(api)) errors.push('protected file fetch must authenticate, refresh once, and return an object URL');
if (/<(?:img|video|audio)[^>]*\bsrc="[^"\n]*\/files\//.test(ui)) errors.push('attachment media must not render protected /files/ URLs directly into src');
if (!/data-attachment-src=/.test(ui) || !/function hydrateAttachments\(root\)/.test(ui) || !/function hydrateAttachment\(el\)[\s\S]*?acquireMedia\(/.test(ui) || !/function acquireMedia\(src\)[\s\S]*?API\.fetchProtectedFile/.test(ui)) errors.push('attachment media must hydrate through the authenticated file fetch helper');
if (!/releaseMedia[\s\S]*?URL\.revokeObjectURL/.test(ui) || !/refs <= 0/.test(ui)) errors.push('attachment object URLs must be revoked when discarded');

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('client auth checks passed');
}
