/** @jest-environment node */
//
// A1 pack C2b (FR1, A1-OCC-1) — the csv Copy. A csv block's Copy writes the exact
// CSV as `text/plain` AND the same cells as an escaped, attribute-free `text/html`
// table, so a spreadsheet pastes cells instead of one column; every other block,
// a missing API or a refused rich write falls back to `writeText(value)`.
//
// `code-copy.ts` is React-free and Next-free, so it loads under the root jest
// transform directly. The clipboard here is a FAKE that records calls (its methods
// use `this`, so a detached `write` / `writeText` call would fail loudly); the real
// browser clipboard and a real spreadsheet paste are NOT exercised by this file.

import { copyCodeBlock, parseCsv, rowsToHtmlTable } from "@/components/assistant/code-copy";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeClipboardItem {
  constructor(public readonly items: Record<string, Blob>) {}
}

type Call = { method: "write"; items: unknown[] } | { method: "writeText"; text: string };

class FakeClipboard {
  calls: Call[] = [];
  constructor(private readonly opts: { writeRejects?: boolean; writeTextRejects?: boolean } = {}) {}
  async write(items: unknown[]): Promise<void> {
    this.calls.push({ method: "write", items });
    if (this.opts.writeRejects) throw new Error("NotAllowedError");
  }
  async writeText(text: string): Promise<void> {
    this.calls.push({ method: "writeText", text });
    if (this.opts.writeTextRejects) throw new Error("NotAllowedError");
  }
}

/** A clipboard with only `writeText` (the rich API is missing). */
class PlainClipboard {
  calls: Call[] = [];
  async writeText(text: string): Promise<void> {
    this.calls.push({ method: "writeText", text });
  }
}

async function blobText(item: unknown, type: string): Promise<string> {
  const blob = (item as FakeClipboardItem).items[type];
  expect(blob).toBeInstanceOf(Blob);
  expect(blob.type).toBe(type);
  return blob.text();
}

// ---------------------------------------------------------------------------
// parseCsv (RFC-4180)
// ---------------------------------------------------------------------------

describe("parseCsv", () => {
  test("plain rows and fields", () => {
    expect(parseCsv("sku,qty\nA-1,10\nB-2,20")).toEqual([
      ["sku", "qty"],
      ["A-1", "10"],
      ["B-2", "20"],
    ]);
  });

  test("double-quoted fields: the quotes are syntax, not value", () => {
    expect(parseCsv('"name","qty"\n"Alpha 1mg","10"')).toEqual([
      ["name", "qty"],
      ["Alpha 1mg", "10"],
    ]);
  });

  test("an embedded comma inside quotes stays in the field", () => {
    expect(parseCsv('name,note\n"Alpha, 1mg","a, b, c"')).toEqual([
      ["name", "note"],
      ["Alpha, 1mg", "a, b, c"],
    ]);
  });

  test('a doubled quote ("") inside quotes is one literal quote', () => {
    expect(parseCsv('name\n"say ""hi"""\n""""')).toEqual([["name"], ['say "hi"'], ['"']]);
  });

  test("LF, CR and CRLF inside quotes stay in the field", () => {
    expect(parseCsv('a,b\n"line 1\nline 2","x\r\ny"\n"p\rq",z')).toEqual([
      ["a", "b"],
      ["line 1\nline 2", "x\r\ny"],
      ["p\rq", "z"],
    ]);
  });

  test("CRLF rows (and a lone CR or LF ends a row too)", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseCsv("a\rb\nc")).toEqual([["a"], ["b"], ["c"]]);
  });

  test("a single trailing line break adds no row (LF and CRLF)", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("an empty value has no rows", () => {
    expect(parseCsv("")).toEqual([]);
  });

  test("empty fields are kept, including a trailing one", () => {
    expect(parseCsv("a,,c\n,,\nx,")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
      ["x", ""],
    ]);
  });

  test("a quoted empty field is one empty cell", () => {
    expect(parseCsv('a,""')).toEqual([["a", ""]]);
  });

  test("lenient: a mid-field quote is literal; an unterminated quote runs to the end", () => {
    expect(parseCsv('5" pipe,ok')).toEqual([['5" pipe', "ok"]]);
    expect(parseCsv('a,"open\nstill open')).toEqual([["a", "open\nstill open"]]);
  });

  test("values are never altered: formula-leading and padded values stay as written", () => {
    expect(parseCsv("v\n=SUM(A1:A2)\n+1\n@x\n  padded  ")).toEqual([
      ["v"],
      ["=SUM(A1:A2)"],
      ["+1"],
      ["@x"],
      ["  padded  "],
    ]);
  });
});

// ---------------------------------------------------------------------------
// rowsToHtmlTable
// ---------------------------------------------------------------------------

describe("rowsToHtmlTable", () => {
  test("row 1 is the header; the rest are body rows; exact markup", () => {
    expect(rowsToHtmlTable([["sku", "qty"], ["A-1", "10"], ["B-2", "20"]])).toBe(
      "<table><thead><tr><th>sku</th><th>qty</th></tr></thead>" +
        "<tbody><tr><td>A-1</td><td>10</td></tr><tr><td>B-2</td><td>20</td></tr></tbody></table>",
    );
  });

  test("a header-only table has an empty tbody", () => {
    expect(rowsToHtmlTable([["a", "b"]])).toBe(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody></tbody></table>",
    );
  });

  test("no rows -> empty string", () => {
    expect(rowsToHtmlTable([])).toBe("");
  });

  test("every cell is escaped (& < > \" '): a <script> in a cell stays text", () => {
    const html = rowsToHtmlTable([
      ["name"],
      ["<script>alert(1)</script>"],
      [`A & B "quoted" 'single' <b>bold</b>`],
    ]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>");
    expect(html).toContain("<td>A &amp; B &quot;quoted&quot; &#39;single&#39; &lt;b&gt;bold&lt;/b&gt;</td>");
  });

  test("NO attributes on any element", () => {
    const html = rowsToHtmlTable([["a", "b"], ["1", 'x" onclick="y']]);
    // Every tag is a bare open/close tag: `<name>` or `</name>`, nothing after the name.
    const tags = html.match(/<[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toMatch(/^<\/?[a-z]+>$/);
  });

  test("cell values are carried unaltered (formula-leading values included)", () => {
    expect(rowsToHtmlTable([["v"], ["=SUM(A1:A2)"], ["  padded  "]])).toContain(
      "<td>=SUM(A1:A2)</td></tr><tr><td>  padded  </td>",
    );
  });
});

// ---------------------------------------------------------------------------
// copyCodeBlock
// ---------------------------------------------------------------------------

describe("copyCodeBlock", () => {
  const CSV = 'sku,name,qty\r\nA-1,"Alpha, 1mg",10\nB-2,"say ""hi""\nthere",<script>\n';

  test("csv + the rich API: ONE write of text/plain (the exact value) and text/html (its table)", async () => {
    const clipboard = new FakeClipboard();
    await copyCodeBlock(CSV, "csv", { clipboard, ClipboardItem: FakeClipboardItem });

    expect(clipboard.calls).toHaveLength(1);
    const call = clipboard.calls[0];
    expect(call.method).toBe("write");
    const items = (call as { items: unknown[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(FakeClipboardItem);
    expect(Object.keys((items[0] as FakeClipboardItem).items).sort()).toEqual(["text/html", "text/plain"]);

    // text/plain is the block text, byte for byte (CRLF, quotes, trailing newline kept).
    expect(await blobText(items[0], "text/plain")).toBe(CSV);
    // text/html is the same cells as a table.
    const html = await blobText(items[0], "text/html");
    expect(html).toBe(rowsToHtmlTable(parseCsv(CSV)));
    expect(html).toBe(
      "<table><thead><tr><th>sku</th><th>name</th><th>qty</th></tr></thead><tbody>" +
        "<tr><td>A-1</td><td>Alpha, 1mg</td><td>10</td></tr>" +
        '<tr><td>B-2</td><td>say &quot;hi&quot;\nthere</td><td>&lt;script&gt;</td></tr>' +
        "</tbody></table>",
    );
  });

  test("the rich write rejects -> falls back to writeText(value)", async () => {
    const clipboard = new FakeClipboard({ writeRejects: true });
    await expect(copyCodeBlock(CSV, "csv", { clipboard, ClipboardItem: FakeClipboardItem })).resolves.toBeUndefined();
    expect(clipboard.calls.map((c) => c.method)).toEqual(["write", "writeText"]);
    expect((clipboard.calls[1] as { text: string }).text).toBe(CSV);
  });

  test("a ClipboardItem constructor that throws -> falls back to writeText(value)", async () => {
    const clipboard = new FakeClipboard();
    class ThrowingItem {
      constructor() {
        throw new TypeError("unsupported type");
      }
    }
    await copyCodeBlock(CSV, "csv", { clipboard, ClipboardItem: ThrowingItem });
    expect(clipboard.calls).toEqual([{ method: "writeText", text: CSV }]);
  });

  // A1 pack C2b REV 7 (FR2, A1-CRS-7): the language matches case-insensitively, so a
  // ```CSV block gets the spreadsheet paste too.
  test.each(["CSV", "Csv"])("csv in any case (%s) takes the rich write, not writeText", async (language) => {
    const clipboard = new FakeClipboard();
    await copyCodeBlock(CSV, language, { clipboard, ClipboardItem: FakeClipboardItem });
    expect(clipboard.calls.map((c) => c.method)).toEqual(["write"]);
    const items = (clipboard.calls[0] as { items: unknown[] }).items;
    expect(await blobText(items[0], "text/plain")).toBe(CSV);
    expect(await blobText(items[0], "text/html")).toBe(rowsToHtmlTable(parseCsv(CSV)));
  });

  test.each(["text", "json", "sql", "tsv"])("non-csv language (%s) -> writeText(value) only", async (language) => {
    const clipboard = new FakeClipboard();
    await copyCodeBlock("a,b\n1,2", language, { clipboard, ClipboardItem: FakeClipboardItem });
    expect(clipboard.calls).toEqual([{ method: "writeText", text: "a,b\n1,2" }]);
  });

  test("csv with no clipboard.write -> writeText(value)", async () => {
    const clipboard = new PlainClipboard();
    await copyCodeBlock(CSV, "csv", { clipboard, ClipboardItem: FakeClipboardItem });
    expect(clipboard.calls).toEqual([{ method: "writeText", text: CSV }]);
  });

  test("csv with no ClipboardItem -> writeText(value)", async () => {
    const clipboard = new FakeClipboard();
    await copyCodeBlock(CSV, "csv", { clipboard, ClipboardItem: undefined });
    expect(clipboard.calls).toEqual([{ method: "writeText", text: CSV }]);
  });

  test("csv with an empty value (no rows) -> writeText(\"\")", async () => {
    const clipboard = new FakeClipboard();
    await copyCodeBlock("", "csv", { clipboard, ClipboardItem: FakeClipboardItem });
    expect(clipboard.calls).toEqual([{ method: "writeText", text: "" }]);
  });

  test("writeText rejecting propagates (the button shows 'Could not copy')", async () => {
    const clipboard = new FakeClipboard({ writeTextRejects: true });
    await expect(copyCodeBlock("x", "text", { clipboard })).rejects.toThrow("NotAllowedError");
    const both = new FakeClipboard({ writeRejects: true, writeTextRejects: true });
    await expect(copyCodeBlock(CSV, "csv", { clipboard: both, ClipboardItem: FakeClipboardItem })).rejects.toThrow(
      "NotAllowedError",
    );
  });
});
