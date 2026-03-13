import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { createHash, randomUUID } from 'crypto';

const USERNAME_RE = /^[a-z0-9._]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function assertAge13OrMore(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) {
    const error = new Error('Invalid date_of_birth');
    error.statusCode = 400;
    throw error;
  }
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  if (age < 13) {
    const error = new Error('Age must be 13+');
    error.statusCode = 400;
    throw error;
  }
}

function assertRegistrationInput({ email, username, password, date_of_birth }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeUsername(username);

  if (!EMAIL_RE.test(normalizedEmail)) {
    const error = new Error('Invalid email format');
    error.statusCode = 400;
    throw error;
  }

  if (!USERNAME_RE.test(normalizedUsername)) {
    const error = new Error('Invalid username. Use 3-32 chars: a-z0-9._');
    error.statusCode = 400;
    throw error;
  }

  if (String(password || '').length < 8) {
    const error = new Error('Password must be at least 8 chars');
    error.statusCode = 400;
    throw error;
  }

  assertAge13OrMore(date_of_birth);
  return { normalizedEmail, normalizedUsername };
}

function makeAccessToken({ jwtSecret, jwtAccessTtlSec }, user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    jwtSecret,
    { expiresIn: jwtAccessTtlSec }
  );
}

function makeRefreshToken() {
  return randomUUID();
}

function publicUserFromRow(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: user.email,
    phone: user.phone,
    avatar: user.avatar,
    banner: user.banner,
    accent_color: user.accent_color,
    bio: user.bio,
    pronouns: user.pronouns,
    status: user.status,
    custom_status_text: user.custom_status_text,
    custom_status_emoji: user.custom_status_emoji,
    custom_status_expires_at: user.custom_status_expires_at,
    locale: user.locale,
    theme: user.theme,
    message_font_size: user.message_font_size,
    mfa_enabled: user.mfa_enabled,
    flags: user.flags,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export function buildAuthService({ db, snowflake, config }) {
  const now = () => nowSec();

  const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL');
  const findUserByUsername = db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL');
  const findUserById = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL');

  const insertUser = db.prepare(`
    INSERT INTO users (
      id, username, display_name, email, password_hash,
      created_at, updated_at, locale, theme, message_font_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'en-US', 'dark', 16)
  `);

  const insertUserSettings = db.prepare('INSERT INTO user_settings (user_id) VALUES (?)');

  const insertSession = db.prepare(`
    INSERT INTO user_sessions (id, user_id, refresh_token, device, ip, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const findSessionByRefresh = db.prepare(
    'SELECT * FROM user_sessions WHERE refresh_token = ?'
  );

  const deleteSessionByRefresh = db.prepare('DELETE FROM user_sessions WHERE refresh_token = ?');
  const deleteSessionById = db.prepare('DELETE FROM user_sessions WHERE id = ?');
  const updateSessionRefresh = db.prepare(
    'UPDATE user_sessions SET refresh_token = ?, expires_at = ?, last_used_at = ?, ip = ?, device = ? WHERE id = ?'
  );

  const upsertMfaTicket = db.prepare(
    `INSERT INTO mfa_tickets (ticket, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ticket) DO UPDATE SET user_id=excluded.user_id, expires_at=excluded.expires_at, created_at=excluded.created_at`
  );
  const findMfaTicket = db.prepare('SELECT * FROM mfa_tickets WHERE ticket = ?');
  const deleteMfaTicket = db.prepare('DELETE FROM mfa_tickets WHERE ticket = ?');
  const cleanupExpiredMfaTickets = db.prepare('DELETE FROM mfa_tickets WHERE expires_at <= ?');

  const updateMfaSecret = db.prepare('UPDATE users SET mfa_secret = ?, updated_at = ? WHERE id = ?');
  const enableMfa = db.prepare('UPDATE users SET mfa_enabled = 1, updated_at = ? WHERE id = ?');
  const disableMfa = db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, updated_at = ? WHERE id = ?');
  const deleteBackupCodesForUser = db.prepare('DELETE FROM user_mfa_backup_codes WHERE user_id = ?');
  const insertBackupCode = db.prepare(
    'INSERT INTO user_mfa_backup_codes (id, user_id, code_hash, used, created_at) VALUES (?, ?, ?, 0, ?)'
  );

  const createSessionTx = db.transaction((user, meta) => {
    const refreshToken = makeRefreshToken();
    const sessionId = randomUUID();
    const createdAt = now();
    const expiresAt = createdAt + config.jwtRefreshTtlSec;
    insertSession.run(
      sessionId,
      user.id,
      refreshToken,
      meta?.device || null,
      meta?.ip || null,
      createdAt,
      expiresAt,
      createdAt
    );
    return { refreshToken, expiresAt };
  });

  return {
    publicUser: publicUserFromRow,

    async register({ email, username, password, date_of_birth, meta }) {
      const { normalizedEmail, normalizedUsername } = assertRegistrationInput({
        email,
        username,
        password,
        date_of_birth,
      });

      if (findUserByEmail.get(normalizedEmail)) {
        const error = new Error('Email already in use');
        error.statusCode = 409;
        throw error;
      }
      if (findUserByUsername.get(normalizedUsername)) {
        const error = new Error('Username already in use');
        error.statusCode = 409;
        throw error;
      }

      const id = snowflake.generate();
      const ts = now();
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });

      db.transaction(() => {
        insertUser.run(
          id,
          normalizedUsername,
          normalizedUsername,
          normalizedEmail,
          passwordHash,
          ts,
          ts
        );
        insertUserSettings.run(id);
      })();

      const user = findUserById.get(id);
      const { refreshToken } = createSessionTx(user, meta);
      const token = makeAccessToken(config, user);

      return {
        token,
        refreshToken,
        user: publicUserFromRow(user),
      };
    },

    async login({ email, password, meta }) {
      const normalizedEmail = normalizeEmail(email);
      const user = findUserByEmail.get(normalizedEmail);
      if (!user) {
        const error = new Error('Invalid credentials');
        error.statusCode = 401;
        throw error;
      }

      const ok = await argon2.verify(user.password_hash, String(password || ''));
      if (!ok) {
        const error = new Error('Invalid credentials');
        error.statusCode = 401;
        throw error;
      }

      cleanupExpiredMfaTickets.run(now());

      if (user.mfa_enabled) {
        const ticket = randomUUID();
        upsertMfaTicket.run(ticket, user.id, now() + 300, now());
        return {
          mfa: true,
          ticket,
        };
      }

      const { refreshToken } = createSessionTx(user, meta);
      const token = makeAccessToken(config, user);
      return {
        token,
        refreshToken,
        user: publicUserFromRow(user),
      };
    },

    async verifyMfaTicket({ ticket, code, meta }) {
      cleanupExpiredMfaTickets.run(now());
      const row = findMfaTicket.get(ticket);
      if (!row || row.expires_at <= now()) {
        const error = new Error('MFA ticket expired');
        error.statusCode = 401;
        throw error;
      }

      const user = findUserById.get(row.user_id);
      if (!user || !user.mfa_secret) {
        const error = new Error('MFA not configured');
        error.statusCode = 401;
        throw error;
      }

      const verified = speakeasy.totp.verify({
        secret: user.mfa_secret,
        encoding: 'base32',
        token: String(code || ''),
        window: 1,
      });
      if (!verified) {
        const error = new Error('Invalid MFA code');
        error.statusCode = 401;
        throw error;
      }

      deleteMfaTicket.run(ticket);
      const { refreshToken } = createSessionTx(user, meta);
      const token = makeAccessToken(config, user);

      return {
        token,
        refreshToken,
        user: publicUserFromRow(user),
      };
    },

    async refresh(refreshToken, meta) {
      if (!refreshToken) {
        const error = new Error('Missing refresh token');
        error.statusCode = 401;
        throw error;
      }

      const session = findSessionByRefresh.get(refreshToken);
      if (!session || session.expires_at <= now()) {
        if (session) deleteSessionById.run(session.id);
        const error = new Error('Invalid refresh token');
        error.statusCode = 401;
        throw error;
      }

      const user = findUserById.get(session.user_id);
      if (!user) {
        deleteSessionById.run(session.id);
        const error = new Error('Session user missing');
        error.statusCode = 401;
        throw error;
      }

      const nextRefresh = makeRefreshToken();
      const expiresAt = now() + config.jwtRefreshTtlSec;
      updateSessionRefresh.run(
        nextRefresh,
        expiresAt,
        now(),
        meta?.ip || null,
        meta?.device || null,
        session.id
      );

      return {
        token: makeAccessToken(config, user),
        refreshToken: nextRefresh,
        user: publicUserFromRow(user),
      };
    },

    logout(refreshToken) {
      if (!refreshToken) return;
      deleteSessionByRefresh.run(refreshToken);
    },

    async beginEnableMfa(userId) {
      const user = findUserById.get(userId);
      if (!user) {
        const error = new Error('User not found');
        error.statusCode = 404;
        throw error;
      }

      const secret = speakeasy.generateSecret({
        name: `Discord Clone (${user.email})`,
        issuer: 'Discord Clone',
        length: 32,
      });

      updateMfaSecret.run(secret.base32, now(), userId);
      const otpauth = secret.otpauth_url;
      const qrDataUrl = await QRCode.toDataURL(otpauth);

      return {
        secret: secret.base32,
        otpauth_url: otpauth,
        qr_code_data_url: qrDataUrl,
      };
    },

    async confirmEnableMfa(userId, code) {
      const user = findUserById.get(userId);
      if (!user || !user.mfa_secret) {
        const error = new Error('MFA setup not initialized');
        error.statusCode = 400;
        throw error;
      }

      const verified = speakeasy.totp.verify({
        secret: user.mfa_secret,
        encoding: 'base32',
        token: String(code || ''),
        window: 1,
      });
      if (!verified) {
        const error = new Error('Invalid MFA code');
        error.statusCode = 400;
        throw error;
      }

      const backupCodes = [];
      db.transaction(() => {
        enableMfa.run(now(), userId);
        deleteBackupCodesForUser.run(userId);
        for (let index = 0; index < 10; index += 1) {
          const codePlain = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
          backupCodes.push(codePlain);
          const codeHash = createHash('sha256').update(codePlain).digest('hex');
          insertBackupCode.run(randomUUID(), userId, codeHash, now());
        }
      })();

      return { backup_codes: backupCodes };
    },

    async disableMfaForUser(userId, code) {
      const user = findUserById.get(userId);
      if (!user || !user.mfa_enabled || !user.mfa_secret) {
        const error = new Error('MFA is not enabled');
        error.statusCode = 400;
        throw error;
      }

      const verified = speakeasy.totp.verify({
        secret: user.mfa_secret,
        encoding: 'base32',
        token: String(code || ''),
        window: 1,
      });
      if (!verified) {
        const error = new Error('Invalid MFA code');
        error.statusCode = 400;
        throw error;
      }

      db.transaction(() => {
        disableMfa.run(now(), userId);
        deleteBackupCodesForUser.run(userId);
      })();
    },
  };
}
