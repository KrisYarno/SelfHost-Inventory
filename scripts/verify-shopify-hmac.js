#!/usr/bin/env node
/**
 * Compute Shopify webhook HMAC for a raw JSON body.
 *
 * Usage:
 *   node scripts/verify-shopify-hmac.js --secret 'YOUR_API_SECRET_KEY' --body-base64 '...'
 *
 * You can copy `body-base64` from the app log line:
 *   "Webhook debug body (base64) for <integrationId>: <...>"
 */

const crypto = require("crypto");

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function normalizeSecret(value) {
  let s = String(value ?? "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const secret = normalizeSecret(getArg("--secret") || process.env.SHOPIFY_API_SECRET_KEY || "");
const bodyBase64 = getArg("--body-base64") || "";

if (!secret) {
  console.error("Missing --secret (or env SHOPIFY_API_SECRET_KEY).");
  process.exit(2);
}

if (!bodyBase64) {
  console.error("Missing --body-base64.");
  process.exit(2);
}

const body = Buffer.from(bodyBase64, "base64");
const computedSignature = crypto.createHmac("sha256", secret).update(body).digest("base64");
const rawBodySha256 = crypto.createHash("sha256").update(body).digest("hex");
const secretSha256 = crypto.createHash("sha256").update(secret, "utf8").digest("hex");

process.stdout.write(
  JSON.stringify(
    {
      computedSignature,
      rawBodySha256,
      secretLen: secret.length,
      secretSha256,
    },
    null,
    2
  ) + "\n"
);

