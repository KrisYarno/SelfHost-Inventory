/**
 * concurrency-gate/global-teardown.ts — the ONE cleanup, and the leak gate
 * (pack C7a.1).
 *
 * `stopDatabase()` removes the container WITH `-v` and then PROVES it: the exact
 * recorded container id/name must no longer exist and every anonymous volume
 * recorded at boot must fail `docker volume inspect`. A rejection here fails the
 * run, which is what makes the leak assertions load-bearing rather than
 * decorative.
 */

import { stopDatabase } from "./db";

export default async function globalTeardown(): Promise<void> {
  await stopDatabase();
}
