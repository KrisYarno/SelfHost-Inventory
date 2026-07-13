-- Lane 5 chain repair (2026-07-13): this migration predates 20251103161510_init_baseline,
-- whose generated DDL already contains its full effect. On existing databases this file is
-- recorded as applied (never re-run); on FRESH databases the original content crashed the
-- replay (it altered tables the baseline had not yet created). No-op'd so the chain replays.
-- NEVER run `prisma migrate dev` against dev/staging/prod (deploy-only): dev would detect this
-- file's modified checksum on retained databases and demand a reset.
SELECT 1;
