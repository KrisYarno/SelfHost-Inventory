// @ts-check
/**
 * launch-gate/spike-a-title.mjs — the Spike A TITLE probe (plan Task 1.6; G2-9/G2P-6).
 *
 * WHY A SPAWNED SCRIPT. The launch suite is transpiled to CommonJS (ts-jest,
 * launch-gate/jest.config.mjs), and `ai` cannot load under that transform — the same
 * constraint that made the whole gate HTTP-driving in the first place. So the one
 * proof that needs the REAL `ai` + `ai-sdk-ollama` module graph in-process runs as
 * its own node ESM process: `spike-a.test.ts` syntax-checks this file with
 * `node --check` and then executes it, asserting the scripted TITLE_SCRIPT text and
 * usage came back through the genuine provider path rather than through the app.
 *
 * It is deliberately outside the TypeScript graph (tsconfig includes `**\/*.ts` only),
 * carries `// @ts-check` for editor/type feedback, and prints ONE line of JSON —
 * `{ text, usage }` — to stdout so the caller can compare exactly.
 *
 * Talks ONLY to the loopback choreography shim: no API key, no egress.
 */

import { generateText } from "ai";
import { createOllama } from "ai-sdk-ollama";

const BASE_URL = process.env.LAUNCH_GATE_SHIM_URL ?? "http://127.0.0.1:3102";
const MODEL = process.env.LAUNCH_GATE_MODEL ?? "gate-scripted";

// Constructed exactly as lib/assistant/providers.ts constructs it for an OLLAMA row
// (createOllama({ baseURL })), minus the registry indirection — the wire path under
// test is the provider's, not the registry's.
const ollama = createOllama({ baseURL: BASE_URL });

// NO `GATE:` prefix: any non-scenario prompt is a title call by definition (spec C7
// item 3), which is exactly the C6 shape this probes.
const result = await generateText({
  model: ollama(MODEL),
  prompt: "Summarise this conversation in a short title.",
  maxOutputTokens: 24,
});

process.stdout.write(
  `${JSON.stringify({
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
    finishReason: result.finishReason,
  })}\n`,
);
