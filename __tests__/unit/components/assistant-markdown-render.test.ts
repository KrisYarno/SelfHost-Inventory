/** @jest-environment node */
//
// Assistant A1 (M1, pack C2) — render pins for the REAL assistant markdown renderer.
//
// react-markdown is ESM-only and cannot load under the root jest transform (that is
// why lane4-assistant-ui.test.tsx mocks it). So this suite spawns a plain node ESM
// probe (__tests__/support/render-markdown-probe.mjs) that bundles
// components/assistant/markdown.tsx with esbuild and renders it with react-dom/server;
// the HTML comes back as JSON and is parsed here with jsdom. No mock, no copy.
//
// The FIRST test is the harness self-check. Every pin runs only after it is green: a
// probe that fails to load is a harness failure, never a red-first result.
//
// Product names are synthetic.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { JSDOM } from "jsdom";

const PROBE = path.resolve(__dirname, "../../support/render-markdown-probe.mjs");
const PROBE_TIMEOUT_MS = 60_000;

function spawnProbe(inputs: string[]) {
  return spawnSync(process.execPath, [PROBE], {
    input: JSON.stringify(inputs),
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
  });
}

/** Render every input through the probe; throws (never returns partial) on a load error. */
function renderAll(inputs: string[]): string[] {
  const r = spawnProbe(inputs);
  if (r.error) throw new Error(`render probe failed to spawn: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`render probe exited ${r.status} (signal ${r.signal}):\n${r.stderr}`);
  }
  const out: unknown = JSON.parse(r.stdout);
  if (!Array.isArray(out) || out.length !== inputs.length || !out.every((h) => typeof h === "string")) {
    throw new Error(`render probe returned an unexpected payload: ${r.stdout.slice(0, 200)}`);
  }
  return out as string[];
}

const parse = (html: string): Document => new JSDOM(html).window.document;
const text = (el: Element | null | undefined): string => el?.textContent ?? "";

let harnessOk = false;

describe("assistant markdown render probe (A1 C2)", () => {
  test("harness self-check: the probe loads the real component and renders hello as <p>hello</p>", () => {
    const [html] = renderAll(["hello"]);
    expect(html).toContain("<p>hello</p>");
    const doc = parse(html);
    expect(doc.querySelectorAll("p")).toHaveLength(1);
    expect(text(doc.querySelector("p"))).toBe("hello");
    harnessOk = true;
  }, 90_000);

  describe("render pins", () => {
    const TABLE_4 = [
      "| Product | On hand | Cost | Sold |",
      "|---|---|---|---|",
      "| Alpha 1mg | 10 | $1.00 | 3 |",
      "| Beta 2mg | 20 | $2.00 | 4 |",
    ].join("\n");
    const cols12 = Array.from({ length: 12 }, (_, i) => `c${i + 1}`);
    const TABLE_12 = [
      `| ${cols12.join(" | ")} |`,
      `|${cols12.map(() => "---").join("|")}|`,
      `| ${cols12.map((_, i) => String(i)).join(" | ")} |`,
    ].join("\n");

    const CASES = {
      table4: TABLE_4,
      bareFence: "```\nline one\nline two\nline three\n```",
      csvFence: "```csv\nname,qty\nAlpha 1mg,10\n```",
      inlineCode: "Use the `x` value here.",
      rawHtml: '<table onclick="x"><tr><td>a</td></tr></table>\n\nSome <b onclick="y">bold</b> text.',
      headings: "# Title\n\n#### Detail",
      image: "![i](https://x/y.png)",
      jsLink: "[x](javascript:alert(1))",
      softBreak: "Alpha 1mg: 10\nBeta 2mg: 20",
      crlf: "a\r\nb",
      strongBreak: "**Alpha\nBeta**",
      twoBreaks: "x\ny\nz",
      listBreak: "- one\n  two",
      blockquote: "> quoted\nline",
      hr: "First paragraph.\n\n---\n\nSecond paragraph.",
      emptyFence: "```\n```",
      unterminatedFence: "```\na\nb",
      cellCode: "| Name | Note |\n|---|---|\n| Alpha 1mg | `code` |",
      tableInList: "- Products\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |",
      table12: TABLE_12,
      cellBr: "| On hand | Note |\n|---|---|\n| 10<br>20 | x |",
      brSlash: "Line A<br/>Line B",
      brUpper: "Line A<BR>Line B",
      brAttr: 'a<br onclick="x">b',
      brOnlyLine: "First paragraph.\n\n<br>\n\nSecond paragraph.",
      codeBr: "Type `a<br>b` here.",
      boldTag: "Some <b>x</b> text.",
      strike: "~~$12.00~~ $10.00",
    } as const;
    type CaseName = keyof typeof CASES;

    const html = {} as Record<CaseName, string>;
    const doc = {} as Record<CaseName, Document>;

    beforeAll(() => {
      if (!harnessOk) {
        throw new Error("harness self-check is not green — no render pin result is evidence");
      }
      const names = Object.keys(CASES) as CaseName[];
      const out = renderAll(names.map((n) => CASES[n]));
      names.forEach((n, i) => {
        html[n] = out[i];
        doc[n] = parse(out[i]);
      });
    }, 90_000);

    test("pin 1 (R): a 4-column table renders inside the focusable scroll region with scoped headers", () => {
      const d = doc.table4;
      const tables = d.querySelectorAll("table");
      expect(tables).toHaveLength(1);
      const table = tables[0];
      const region = table.parentElement as Element;
      expect(region.getAttribute("role")).toBe("region");
      expect(region.getAttribute("aria-label")).toBe("Table — scrolls sideways");
      expect(region.getAttribute("tabindex")).toBe("0");
      expect(region.className.split(/\s+/)).toContain("overflow-x-auto");

      const ths = Array.from(table.querySelectorAll("th"));
      expect(ths).toHaveLength(4);
      for (const th of ths) expect(th.getAttribute("scope")).toBe("col");
      expect(ths.map((th) => text(th))).toEqual(["Product", "On hand", "Cost", "Sold"]);
      const tds = Array.from(table.querySelectorAll("td"));
      expect(tds.map((td) => text(td))).toEqual([
        "Alpha 1mg", "10", "$1.00", "3",
        "Beta 2mg", "20", "$2.00", "4",
      ]);

      for (const name of table.getAttributeNames()) expect(["class"]).toContain(name);
      for (const th of ths) for (const name of th.getAttributeNames()) expect(["class", "scope"]).toContain(name);
      for (const td of tds) for (const name of td.getAttributeNames()) expect(["class"]).toContain(name);
    });

    test("pin 2 (R): a bare three-line fence is a pre block with a 'Copy text' button", () => {
      const d = doc.bareFence;
      const pres = d.querySelectorAll("pre");
      expect(pres).toHaveLength(1);
      expect(text(pres[0])).toBe("line one\nline two\nline three");
      expect(d.querySelector('button[aria-label="Copy text"]')).not.toBeNull();
      for (const code of Array.from(d.querySelectorAll("code"))) {
        expect(code.closest("pre")).not.toBeNull();
      }
    });

    test("pin 3: a csv fence is labelled csv", () => {
      const pre = doc.csvFence.querySelector("pre");
      expect(pre).not.toBeNull();
      const header = (pre as Element).parentElement?.firstElementChild;
      expect(text(header?.querySelector("span"))).toBe("csv");
    });

    test("pin 3 (R, label): the csv fence's Copy button says 'Copy csv'", () => {
      const d = doc.csvFence;
      expect(d.querySelector('button[aria-label="Copy csv"]')).not.toBeNull();
      expect(d.querySelector('button[aria-label="Copy code"]')).toBeNull();
    });

    test("pin 4: inline code in a sentence is a code with no pre ancestor", () => {
      const codes = Array.from(doc.inlineCode.querySelectorAll("code"));
      expect(codes).toHaveLength(1);
      expect(text(codes[0])).toBe("x");
      expect(codes[0].closest("pre")).toBeNull();
      expect(doc.inlineCode.querySelector("pre")).toBeNull();
    });

    test("pin 5: raw HTML is removed — no element, no attribute, no visible tag text", () => {
      const d = doc.rawHtml;
      expect(d.querySelector("table")).toBeNull();
      expect(d.querySelector("b")).toBeNull();
      expect(html.rawHtml).not.toContain("onclick");
      expect(d.querySelector("[onclick]")).toBeNull();
      expect(d.body.textContent).toContain("bold");
      expect(d.body.textContent).not.toContain("<table");
      expect(d.body.textContent).not.toContain("<b");
    });

    test("pin 6 (R): h1 renders as an h2 and h4 as an h3; images are not rendered", () => {
      const d = doc.headings;
      expect(d.querySelector("h1")).toBeNull();
      expect(d.querySelector("h4")).toBeNull();
      expect(text(d.querySelector("h2"))).toBe("Title");
      expect(text(d.querySelector("h3"))).toBe("Detail");
      expect(doc.image.querySelector("img")).toBeNull();
    });

    test("pin 7: a javascript: link never keeps its href", () => {
      for (const a of Array.from(doc.jsLink.querySelectorAll("a"))) {
        expect((a.getAttribute("href") ?? "").toLowerCase().startsWith("javascript:")).toBe(false);
      }
      expect(html.jsLink.toLowerCase()).not.toContain('href="javascript:');
    });

    test("pin 8 (R): a soft line break is a br inside one paragraph; CRLF too, with no CR left", () => {
      const ps = doc.softBreak.querySelectorAll("p");
      expect(ps).toHaveLength(1);
      expect(ps[0].querySelectorAll("br")).toHaveLength(1);
      expect(text(ps[0])).toContain("Alpha 1mg: 10");
      expect(text(ps[0])).toContain("Beta 2mg: 20");

      expect(doc.crlf.querySelectorAll("br")).toHaveLength(1);
      // The RAW HTML string, not the DOM: jsdom normalises CR to LF while parsing, so a
      // textContent check could never fail (A1-CRS-3). React leaves `\r` unescaped.
      expect(html.crlf).not.toContain("\r");
    });

    test("pin 9 (R): soft breaks split text at any depth — inside strong, twice in one node, in a list item", () => {
      const strong = doc.strongBreak.querySelector("strong");
      expect(strong).not.toBeNull();
      expect((strong as Element).querySelectorAll("br")).toHaveLength(1);

      expect(doc.twoBreaks.querySelectorAll("p br")).toHaveLength(2);

      const li = doc.listBreak.querySelector("li");
      expect(li).not.toBeNull();
      expect((li as Element).querySelectorAll("br")).toHaveLength(1);
    });

    test("pin 10 (R): an unwrapped blockquote keeps its two lines apart with a br", () => {
      const d = doc.blockquote;
      expect(d.querySelector("blockquote")).toBeNull();
      expect(d.querySelectorAll("br")).toHaveLength(1);
      expect(d.body.textContent).toContain("quoted");
      expect(d.body.textContent).toContain("line");
    });

    test("pin 11 (R): a thematic break renders an hr between the two paragraphs", () => {
      const root = doc.hr.body.firstElementChild as Element;
      const tags = Array.from(root.children).map((el) => el.tagName.toLowerCase());
      expect(tags).toEqual(["p", "hr", "p"]);
    });

    test("pin 12 (R): an empty fence is an empty pre block; an unterminated fence holds both lines", () => {
      const empty = doc.emptyFence.querySelectorAll("pre");
      expect(empty).toHaveLength(1);
      expect(text(empty[0])).toBe("");
      expect(doc.emptyFence.body.textContent).not.toContain("undefined");

      const open = doc.unterminatedFence.querySelectorAll("pre");
      expect(open).toHaveLength(1);
      expect(text(open[0])).toBe("a\nb");
    });

    test("pin 13: code in a cell, a table in a list item, a 12-column table in the scroll wrapper", () => {
      const cellCode = doc.cellCode.querySelector("td code");
      expect(cellCode).not.toBeNull();
      expect(text(cellCode)).toBe("code");

      expect(doc.tableInList.querySelector("li table")).not.toBeNull();

      const d = doc.table12;
      expect(d.querySelectorAll("th")).toHaveLength(12);
      const region = d.querySelector("table")?.closest('[role="region"]');
      expect(region).not.toBeNull();
      expect((region as Element).className.split(/\s+/)).toContain("overflow-x-auto");
    });

    // A1 pack C2 REV 7 (FR2, A1-CRS-2): the sanitizer drops raw HTML, so a model's
    // `<br>` used to vanish and fuse the figures on either side ("10<br>20" -> "1020").
    test("pin 14 (R): a <br> in a table cell is a line break, never a fused figure", () => {
      const td = doc.cellBr.querySelector("tbody td");
      expect(td).not.toBeNull();
      const cell = td as Element;
      expect(cell.querySelectorAll("br")).toHaveLength(1);
      const br = cell.querySelector("br") as Element;
      // A markdown hard break renders `<br>` plus a newline text node (mdast-util-to-hast),
      // so the text after the br starts with "\n".
      expect(br.previousSibling?.textContent).toBe("10");
      expect(br.nextSibling?.textContent?.trim()).toBe("20");
      expect(text(cell)).toBe("10\n20");
      expect(doc.cellBr.body.textContent).not.toContain("1020");
    });

    test("pin 14 (R): <br/>, <BR> and <br onclick> in a paragraph are bare breaks", () => {
      for (const name of ["brSlash", "brUpper"] as const) {
        const p = doc[name].querySelector("p") as Element;
        expect({ name, brs: p.querySelectorAll("br").length }).toEqual({ name, brs: 1 });
        const br = p.querySelector("br") as Element;
        expect(br.previousSibling?.textContent).toBe("Line A");
        expect(br.nextSibling?.textContent?.trim()).toBe("Line B");
      }

      const p = doc.brAttr.querySelector("p") as Element;
      expect(p.querySelectorAll("br")).toHaveLength(1);
      expect((p.querySelector("br") as Element).getAttributeNames()).toEqual([]);
      expect(html.brAttr).not.toContain("onclick");
      expect(text(p)).toBe("a\nb");
    });

    test("pin 14 (R): a line holding only <br> between two paragraphs renders, as a break", () => {
      const d = doc.brOnlyLine;
      const ps = Array.from(d.querySelectorAll("p"));
      expect(ps.map((p) => text(p))).toEqual(["First paragraph.", "Second paragraph."]);
      expect(d.querySelectorAll("br")).toHaveLength(1);
      expect(d.body.textContent).not.toContain("<br");
    });

    test("pin 14: inline code keeps a literal <br>; any other raw HTML is still removed", () => {
      const code = doc.codeBr.querySelector("code");
      expect(text(code)).toBe("a<br>b");
      expect(doc.codeBr.querySelector("br")).toBeNull();

      expect(doc.boldTag.querySelector("b")).toBeNull();
      expect(text(doc.boldTag.querySelector("p"))).toBe("Some x text.");
    });

    // A1 pack C1/C2 REV 7 (FR2, A1-CRS-6): a struck figure reads as struck, not as a
    // second real figure.
    test("pin 15 (R): ~~$12.00~~ $10.00 renders a bare del around the struck figure only", () => {
      const p = doc.strike.querySelector("p") as Element;
      const dels = p.querySelectorAll("del");
      expect(dels).toHaveLength(1);
      expect(text(dels[0])).toBe("$12.00");
      expect(dels[0].getAttributeNames()).toEqual([]);
      expect(dels[0].nextSibling?.textContent).toBe(" $10.00");
      expect(text(p)).toBe("$12.00 $10.00");
    });

    test("C2 guard: no override spreads react-markdown's node prop onto the DOM", () => {
      for (const name of Object.keys(CASES) as CaseName[]) {
        expect({ name, nodeAttr: doc[name].querySelector("[node]") !== null }).toEqual({ name, nodeAttr: false });
      }
    });
  });
});
