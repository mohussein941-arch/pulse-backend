// utils/crypto.js — AES-256-GCM encryption for credentials stored at rest
// Format: iv(hex):authTag(hex):ciphertext(hex)

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES  = 16;

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key    = getKey();
  const iv     = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext    += cipher.final('hex');
  const tag      = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${tag}:${ciphertext}`;
}

function decrypt(value) {
  if (value == null) return null;
  // Graceful fallback: if value isn't in encrypted format, treat as plaintext
  // This handles legacy unencrypted values during migration
  const parts = value.split(':');
  if (parts.length !== 3) return value;

  const [ivHex, tagHex, ciphertext] = parts;
  // Basic sanity check — iv is 16 bytes = 32 hex chars
  if (ivHex.length !== 32) return value;

  const key      = getKey();
  const iv       = Buffer.from(ivHex, 'hex');
  const tag      = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted  = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted     += decipher.final('utf8');
  return decrypted;
}

// Mask a key/token for safe display — shows first 8 + last 4 chars
function mask(value) {
  if (!value || value.length < 12) return '***';
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

module.exports = { encrypt, decrypt, mask };
