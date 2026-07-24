import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

/** AES-256-GCM encrypt, using CLICKUP_TOKEN_ENCRYPTION_KEY (base64, 32 bytes) as the key. */
export function encryptToken(plaintext: string, base64Key: string): string {
  const key = Buffer.from(base64Key, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((buf) => buf.toString('base64')).join('.');
}

export function decryptToken(ciphertext: string, base64Key: string): string {
  const key = Buffer.from(base64Key, 'base64');
  const [ivB64, authTagB64, encryptedB64] = ciphertext.split('.');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
