#!/usr/bin/env node
/**
 * Lane 5 I6 deploy manifest (spec §3 I6; codex #17).
 *
 * Copy-over deploys (SFTP) cannot propagate deletions: a file removed from the repo lingers
 * on the server and can break the build (the staging rehearsal hit 56 stale files). This tool
 * turns the runbook's hand-built deletion block into a repeatable artifact.
 *
 * Stale = files present under <targetDir> (recursive, repo-relative POSIX paths) that are
 *   - NOT tracked in git (`git ls-files` from the local repo), AND
 *   - NOT matched by the protect list below.
 *
 * The protect list shields server-owned state that legitimately lives only on the server
 * (env files, server compose, dumps, backups, uploads, logs, build/deps caches) so the tool
 * never suggests deleting them.
 *
 * Usage:  node scripts/deploy-manifest.js <targetDir> [--json]
 * Output: newline-delimited stale paths (or a JSON array with --json) + a `STALE: <n> files`
 *         summary on stderr. Exit code is always 0 (informational tool; no server automation).
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Exact protect list (spec §3 I6). `dir/**` = anything under dir; `*.ext` / `.env*` /
// `compose.*.yml` = basename globs matched at any depth; bare names = exact basename.
const PROTECT_LIST = [
  ".env*",
  "docker-compose.yml",
  "compose.*.yml",
  "staging.sh",
  "staging-initdb/**",
  "dumps/**",
  "*.sql",
  "*.sql.gz",
  "*.log",
  "node_modules/**",
  ".next/**",
  // Build/VCS metadata the deploy must never touch. `.git/**` matters when the
  // target is a clone (the staging copy is): without it, every object and hook
  // in .git/ reports as "stale" and drowns the real list.
  ".git/**",
  "public/uploads/**",
  "backup/**",
];

/** Match a single basename against a `*`-glob pattern (zero or one `*`). */
function matchBasenameGlob(basename, pattern) {
  const star = pattern.indexOf("*");
  if (star === -1) return basename === pattern;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    basename.length >= prefix.length + suffix.length &&
    basename.startsWith(prefix) &&
    basename.endsWith(suffix)
  );
}

/** True if the repo-relative POSIX path is shielded by the protect list. */
function isProtected(relPath, protectList = PROTECT_LIST) {
  const basename = relPath.split("/").pop();
  for (const pattern of protectList) {
    if (pattern.endsWith("/**")) {
      const dirPrefix = pattern.slice(0, -3);
      if (relPath === dirPrefix || relPath.startsWith(dirPrefix + "/")) return true;
    } else if (!pattern.includes("/")) {
      // basename pattern, matched at any depth
      if (matchBasenameGlob(basename, pattern)) return true;
    } else if (relPath === pattern) {
      return true;
    }
  }
  return false;
}

/** Recursively list every file under `targetDir` as relative POSIX paths. */
function walkFiles(targetDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(targetDir, full).split(path.sep).join("/"));
    }
  };
  walk(targetDir);
  return out;
}

/** Tracked files (repo-relative POSIX) from `git ls-files`, spawned once. */
function getTrackedFiles(cwd = process.cwd()) {
  const raw = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return raw.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Core: target files that are neither tracked nor protected. */
function computeStale(targetDir, trackedFiles, protectList = PROTECT_LIST) {
  const tracked = new Set(trackedFiles);
  return walkFiles(targetDir).filter(
    (rel) => !tracked.has(rel) && !isProtected(rel, protectList)
  );
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const targetDir = args.find((a) => !a.startsWith("--"));

  if (!targetDir) {
    console.error("Usage: node scripts/deploy-manifest.js <targetDir> [--json]");
    return; // exit 0 always (informational tool)
  }
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    console.error(`[deploy-manifest] target is not a directory: ${targetDir}`);
    return;
  }

  const stale = computeStale(targetDir, getTrackedFiles()).sort();

  if (asJson) {
    process.stdout.write(JSON.stringify(stale) + "\n");
  } else {
    for (const rel of stale) process.stdout.write(rel + "\n");
  }
  console.error(`STALE: ${stale.length} files`);
}

module.exports = {
  PROTECT_LIST,
  matchBasenameGlob,
  isProtected,
  walkFiles,
  getTrackedFiles,
  computeStale,
  main,
};

if (require.main === module) {
  main(process.argv);
}
