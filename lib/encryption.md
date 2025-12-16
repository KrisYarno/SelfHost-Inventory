# Encryption Utilities

AES-256-GCM encryption utilities for securing sensitive data like API credentials and webhook secrets.

## Features

- **AES-256-GCM** encryption algorithm (industry standard)
- 96-bit initialization vectors (IV) for GCM mode
- 128-bit authentication tags for message integrity
- Base64 encoding for storage/transmission
- Secure key derivation from environment variables

## Setup

### Generate an Encryption Key

```bash
# In Node.js REPL or a script:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Or use the utility function:

```typescript
import { generateEncryptionKey } from '@/lib/encryption';
console.log(generateEncryptionKey());
```

### Configure Environment Variable

Add to your `.env` file:

```env
ENCRYPTION_KEY=your_base64_encoded_32_byte_key_here
```

**Important:** The key must be exactly 32 bytes (256 bits) when decoded from base64.

## Usage

### Encrypting Values

```typescript
import { encryptValue } from '@/lib/encryption';

// Encrypt sensitive data
const apiKey = 'sk_live_abc123...';
const encrypted = encryptValue(apiKey);

// Store encrypted value in database
await prisma.platformConfig.create({
  data: {
    platform: 'SHOPIFY',
    apiKeyEncrypted: encrypted,
  },
});
```

### Decrypting Values

```typescript
import { decryptValue } from '@/lib/encryption';

// Retrieve encrypted value from database
const config = await prisma.platformConfig.findUnique({
  where: { platform: 'SHOPIFY' },
});

// Decrypt for use
const apiKey = decryptValue(config.apiKeyEncrypted);

// Use the decrypted API key
const response = await fetch('https://api.shopify.com/...', {
  headers: { 'X-Shopify-Access-Token': apiKey },
});
```

### Checking Encryption Format

```typescript
import { isEncrypted } from '@/lib/encryption';

const value = 'abc.def.ghi';
if (isEncrypted(value)) {
  const decrypted = decryptValue(value);
}
```

## Encrypted Value Format

Encrypted values are stored as base64-encoded strings with the format:

```
iv.authTag.ciphertext
```

- **iv**: Initialization vector (12 bytes, base64-encoded)
- **authTag**: Authentication tag (16 bytes, base64-encoded)
- **ciphertext**: Encrypted data (variable length, base64-encoded)

Example:
```
dGVzdGl2MTIz.YXV0aHRhZzEyMzQ1Ng==.Y2lwaGVydGV4dGRhdGE=
```

## Security Considerations

### Key Management

1. **Never commit encryption keys to version control**
2. Store keys in secure environment variables or secrets management
3. Use different keys for development, staging, and production
4. Rotate keys periodically and re-encrypt data

### Best Practices

- **Encrypt at rest**: Store sensitive credentials encrypted in the database
- **Decrypt just-in-time**: Only decrypt when needed for API calls
- **Don't log decrypted values**: Never log sensitive data in plaintext
- **Use HTTPS**: Always transmit encrypted values over secure connections

### Key Rotation

When rotating keys:

1. Generate a new encryption key
2. Decrypt all sensitive values with the old key
3. Re-encrypt with the new key
4. Update the `ENCRYPTION_KEY` environment variable
5. Restart the application

## Error Handling

The encryption utilities throw errors for invalid inputs:

```typescript
try {
  const decrypted = decryptValue(encryptedValue);
} catch (error) {
  if (error.message.includes('Decryption failed')) {
    // Invalid format, wrong key, or tampered data
    console.error('Failed to decrypt value');
  }
}
```

Common errors:

- `ENCRYPTION_KEY environment variable is not set`
- `Invalid encryption key length: expected 32 bytes`
- `Invalid encrypted value format: expected iv.authTag.ciphertext`
- `Decryption failed: Unsupported state or unable to authenticate data`

## Implementation Details

### Algorithm: AES-256-GCM

- **Cipher**: AES (Advanced Encryption Standard)
- **Key Size**: 256 bits (32 bytes)
- **Mode**: GCM (Galois/Counter Mode)
- **IV Size**: 96 bits (12 bytes) - NIST recommended for GCM
- **Auth Tag Size**: 128 bits (16 bytes)

### Why GCM?

GCM (Galois/Counter Mode) provides:

1. **Authenticated encryption**: Ensures data hasn't been tampered with
2. **Performance**: Hardware acceleration on modern CPUs
3. **Parallelizable**: Encryption/decryption can be parallelized
4. **NIST approved**: FIPS 140-2 compliant

## Example: Platform Configuration

```typescript
import { encryptValue, decryptValue } from '@/lib/encryption';

// Encrypting Shopify credentials
async function saveShopifyConfig(
  shopDomain: string,
  apiKey: string,
  apiSecret: string
) {
  await prisma.platformConfig.create({
    data: {
      platform: 'SHOPIFY',
      shopDomain,
      apiKeyEncrypted: encryptValue(apiKey),
      apiSecretEncrypted: encryptValue(apiSecret),
    },
  });
}

// Using encrypted credentials
async function fetchShopifyOrders(configId: number) {
  const config = await prisma.platformConfig.findUnique({
    where: { id: configId },
  });

  if (!config) {
    throw new Error('Config not found');
  }

  // Decrypt credentials
  const apiKey = decryptValue(config.apiKeyEncrypted);
  const apiSecret = decryptValue(config.apiSecretEncrypted);

  // Use credentials
  const response = await fetch(
    `https://${config.shopDomain}/admin/api/2025-10/orders.json`,
    {
      headers: {
        'X-Shopify-Access-Token': apiKey,
      },
    }
  );

  return response.json();
}
```

## Testing

```typescript
import { encryptValue, decryptValue, generateEncryptionKey } from '@/lib/encryption';

describe('Encryption', () => {
  beforeAll(() => {
    // Set test encryption key
    process.env.ENCRYPTION_KEY = generateEncryptionKey();
  });

  it('should encrypt and decrypt values', () => {
    const plaintext = 'secret-api-key-123';
    const encrypted = encryptValue(plaintext);
    const decrypted = decryptValue(encrypted);

    expect(decrypted).toBe(plaintext);
    expect(encrypted).not.toBe(plaintext);
  });

  it('should produce different ciphertexts for same plaintext', () => {
    const plaintext = 'secret';
    const encrypted1 = encryptValue(plaintext);
    const encrypted2 = encryptValue(plaintext);

    // Different IVs ensure different ciphertexts
    expect(encrypted1).not.toBe(encrypted2);

    // But both decrypt to same plaintext
    expect(decryptValue(encrypted1)).toBe(plaintext);
    expect(decryptValue(encrypted2)).toBe(plaintext);
  });
});
```
