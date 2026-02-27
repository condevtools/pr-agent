import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_BYTES = 16;

/**
 * Resolve the 32-byte encryption key from the DB_ENCRYPTION_KEY env var.
 * The env var must be a 64-character hex string (32 bytes).
 */
function getEncryptionKey(): Buffer {
  const hex = process.env["DB_ENCRYPTION_KEY"];
  if (!hex) {
    throw new Error(
      "DB_ENCRYPTION_KEY environment variable is required for API key encryption. " +
        "Provide a 64-character hex string (32 bytes).",
    );
  }
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "DB_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).",
    );
  }
  return Buffer.from(hex, "hex");
}

export interface EncryptedPayload {
  /** Ciphertext with appended GCM auth tag (ciphertext + 16-byte tag). */
  encrypted: Buffer;
  /** 12-byte initialization vector. */
  iv: Buffer;
}

/**
 * Encrypt a plaintext API key using AES-256-GCM.
 *
 * The returned `encrypted` buffer contains the ciphertext concatenated with
 * the 16-byte GCM authentication tag, so the caller only needs to persist
 * two columns: `api_key_encrypted` and `api_key_iv`.
 */
export function encryptApiKey(plaintext: string): EncryptedPayload {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: Buffer.concat([encrypted, authTag]),
    iv,
  };
}

/**
 * Decrypt an API key previously encrypted with {@link encryptApiKey}.
 *
 * @param encrypted - Ciphertext with appended 16-byte GCM auth tag.
 * @param iv        - The 12-byte initialization vector stored alongside.
 */
export function decryptApiKey(encrypted: Buffer, iv: Buffer): string {
  const key = getEncryptionKey();

  // Split ciphertext and auth tag
  const ciphertext = encrypted.subarray(0, encrypted.length - AUTH_TAG_BYTES);
  const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
