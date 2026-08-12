//
// Phase 0a — artifact envelope + text rendering.
//
// HOUSE RULES ENCODED HERE:
//  - Every figure carries a definition string. `figure()` throws without one,
//    so a number cannot reach an artifact undefined.
//  - Every disclosure rides WITH the number it qualifies: disclosures are a
//    property OF the figure, not a footnote at the bottom of the page.
//  - A structurally-unpopulated slot is `null` + a named reason, never 0.
//
const fs = require("fs");
const path = require("path");

/**
 * A reported number.
 * @param {number|string|null} value
 * @param {string} definition how the number is computed, in words
 * @param {Array<{label: string, value: unknown, reason: string}>} [disclosures]
 */
function figure(value, definition, disclosures = []) {
  if (typeof definition !== "string" || definition.trim().length === 0) {
    throw new Error("figure() requires a definition string (house rule)");
  }
  return { value, definition, disclosures };
}

/**
 * A slot that is structurally unpopulated: null + a named reason. NEVER 0.
 * @param {string} reason
 * @param {string} definition
 */
function emptySlot(reason, definition) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("emptySlot() requires a named reason (truthful-data north star)");
  }
  return { value: null, definition, reason, structurallyEmpty: true, disclosures: [] };
}

/** A qualifier that travels with a figure. */
function disclosure(label, value, reason) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("disclosure() requires a reason");
  }
  return { label, value, reason };
}

/** A table of rows plus the per-column definitions that make it readable. */
function table(rows, definition, columnDefinitions = {}, disclosures = []) {
  if (typeof definition !== "string" || definition.trim().length === 0) {
    throw new Error("table() requires a definition string (house rule)");
  }
  return { rowCount: rows.length, rows, definition, columnDefinitions, disclosures };
}

function isFigure(v) {
  return v && typeof v === "object" && "definition" in v && "disclosures" in v && !("rows" in v);
}

function isTable(v) {
  return v && typeof v === "object" && Array.isArray(v.rows) && "columnDefinitions" in v;
}

function fmt(v) {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${l}`.replace(/\s+$/, "")).join("\n");
}

function renderNode(key, node, depth, out) {
  const pad = "  ".repeat(depth);
  if (isFigure(node)) {
    const marker = node.structurallyEmpty ? " [STRUCTURALLY EMPTY]" : "";
    out.push(`${pad}${key}: ${fmt(node.value)}${marker}`);
    out.push(wrap(`def: ${node.definition}`, 92, `${pad}    `));
    if (node.reason) out.push(wrap(`reason: ${node.reason}`, 92, `${pad}    `));
    for (const d of node.disclosures || []) {
      out.push(wrap(`disclosure ${d.label} = ${fmt(d.value)} — ${d.reason}`, 92, `${pad}    `));
    }
    return;
  }
  if (isTable(node)) {
    out.push(`${pad}${key}: ${node.rowCount} row(s)`);
    out.push(wrap(`def: ${node.definition}`, 92, `${pad}    `));
    for (const [col, def] of Object.entries(node.columnDefinitions || {})) {
      out.push(wrap(`col ${col}: ${def}`, 92, `${pad}      `));
    }
    for (const d of node.disclosures || []) {
      out.push(wrap(`disclosure ${d.label} = ${fmt(d.value)} — ${d.reason}`, 92, `${pad}    `));
    }
    const cols = node.rows.length > 0 ? Object.keys(node.rows[0]) : [];
    if (cols.length > 0) {
      out.push(`${pad}    ${cols.join(" | ")}`);
      for (const r of node.rows) {
        out.push(`${pad}    ${cols.map((c) => fmt(r[c])).join(" | ")}`);
      }
    }
    return;
  }
  if (node && typeof node === "object" && !Array.isArray(node) && !(node instanceof Date)) {
    out.push(`${pad}${key}:`);
    for (const [k, v] of Object.entries(node)) renderNode(k, v, depth + 1, out);
    return;
  }
  out.push(`${pad}${key}: ${fmt(node)}`);
}

/**
 * Human-readable rendering of an artifact. Same content as the JSON, no more
 * and no less — the text file is what a person reads in the diagnosis report,
 * the JSON is what gets committed next to it.
 */
function renderText(artifact) {
  const out = [];
  out.push("=".repeat(94));
  out.push(`${artifact.check} — ${artifact.title}`);
  out.push("=".repeat(94));
  out.push(`generatedAt: ${artifact.generatedAt}`);
  if (artifact.repoHead) out.push(`repoHead:    ${artifact.repoHead}`);
  if (artifact.connection) {
    out.push(`database:    ${artifact.connection.host ?? "unknown"}/${artifact.connection.database ?? "unknown"}`);
  }
  out.push("");
  out.push(wrap(artifact.purpose, 92, ""));
  out.push("");
  for (const [k, v] of Object.entries(artifact.sections || {})) {
    out.push("-".repeat(94));
    renderNode(k, v, 0, out);
    out.push("");
  }
  if ((artifact.notes || []).length > 0) {
    out.push("-".repeat(94));
    out.push("NOTES");
    for (const n of artifact.notes) out.push(wrap(`- ${n}`, 92, ""));
    out.push("");
  }
  return out.join("\n");
}

/** JSON.stringify replacer: BigInt and Date are not JSON-native. */
function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

/**
 * Write both artifacts for one check. Returns the two absolute paths.
 * @param {string} outDir
 * @param {object} artifact
 */
function writeArtifact(outDir, artifact) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${artifact.check}.json`);
  const textPath = path.join(outDir, `${artifact.check}.txt`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`, "utf8");
  fs.writeFileSync(textPath, `${renderText(artifact)}\n`, "utf8");
  return { jsonPath, textPath };
}

module.exports = {
  figure,
  emptySlot,
  disclosure,
  table,
  renderText,
  writeArtifact,
  jsonReplacer,
};
