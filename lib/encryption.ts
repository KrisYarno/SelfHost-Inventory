/**
 * AES-256-GCM encryption utilities for sensitive data (API credentials, secrets)
 * Uses crypto module for secure encryption/decryption
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const ENCODING = 'base64';

/**
 * Get encryption key from environment variable
 * Key must be 32 bytes (256 bits), base64-encoded
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;

  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }

  try {
    const keyBuffer = Buffer.from(key, 'base64');

    if (keyBuffer.length !== 32) {
      throw new Error(`Invalid encryption key length: expected 32 bytes, got ${keyBuffer.length}`);
    }

    return keyBuffer;
  } catch (error) {
    throw new Error('ENCRYPTION_KEY must be a valid base64-encoded 32-byte string');
  }
}

/**
 * Generate a new encryption key (for initial setup)
 * Returns a base64-encoded 32-byte key
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 * Returns a base64-encoded string: iv.authTag.ciphertext
 *
 * @param plaintext - The string to encrypt
 * @returns Encrypted data as base64 string
 * @throws Error if encryption fails
 */
export function encryptValue(plaintext: string): string {
  try {
    const key = getEncryptionKey();
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', ENCODING);
    encrypted += cipher.final(ENCODING);

    const authTag = cipher.getAuthTag();

    // Format: iv.authTag.ciphertext
    const result = [
      iv.toString(ENCODING),
      authTag.toString(ENCODING),
      encrypted,
    ].join('.');

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Encryption failed: ${message}`);
  }
}

/**
 * Decrypt an encrypted string using AES-256-GCM
 * Expects format: iv.authTag.ciphertext (base64-encoded)
 *
 * @param ciphertext - The encrypted string to decrypt
 * @returns Decrypted plaintext
 * @throws Error if decryption fails or format is invalid
 */
export function decryptValue(ciphertext: string): string {
  try {
    const key = getEncryptionKey();

    // Split into components
    const parts = ciphertext.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted value format: expected iv.authTag.ciphertext');
    }

    const [ivBase64, authTagBase64, encryptedData] = parts;

    const iv = Buffer.from(ivBase64, ENCODING);
    const authTag = Buffer.from(authTagBase64, ENCODING);

    if (iv.length !== IV_LENGTH) {
      throw new Error(`Invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`);
    }

    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(`Invalid auth tag length: expected ${AUTH_TAG_LENGTH}, got ${authTag.length}`);
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData, ENCODING, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Decryption failed: ${message}`);
  }
}

/**
 * Check if a value appears to be encrypted (has correct format)
 * Does not verify validity, only format
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3) {
    return false;
  }

  // Basic validation of base64 format
  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  return parts.every(part => part.length > 0 && base64Regex.test(part));
}
