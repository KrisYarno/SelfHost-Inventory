/**
 * concurrency-gate/clients.ts — one racer, one client, one database session
 * (plan P-2; pack C7a.1).
 *
 * The `@/lib/prisma` SINGLETON is never used here. Two "concurrent" calls that
 * share one client can still be serialized by the client's own transaction
 * bookkeeping — the proof this gate exists to produce needs two independent
 * sessions really contending on InnoDB row locks, which is what two clients give
 * you.
 *
 * Every client a scenario opens is `$disconnect()`ed at the end of that
 * scenario: an open pool holds the jest worker alive past the last assertion.
 */

import { PrismaClient } from "@prisma/client";
import { gateDatabaseUrl } from "./state";

/** A NEW client on every call — the frozen form. (`datasourceUrl` also exists on
 *  Prisma 6; the pack names `datasources`, so that is what this uses.) */
export function openClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: gateDatabaseUrl() } } });
}
