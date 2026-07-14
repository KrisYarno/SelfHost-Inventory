import { escapeCSVCell, rowsToCSV } from "@/lib/csv";

describe("escapeCSVCell (RFC 4180)", () => {
  test("plain value is unquoted", () => {
    expect(escapeCSVCell("Widget")).toBe("Widget");
  });

  test("null / undefined => empty field", () => {
    expect(escapeCSVCell(null)).toBe("");
    expect(escapeCSVCell(undefined)).toBe("");
  });

  test("non-strings are stringified", () => {
    expect(escapeCSVCell(42)).toBe("42");
    expect(escapeCSVCell(0)).toBe("0");
  });

  test("comma => wrapped in quotes", () => {
    expect(escapeCSVCell("a,b")).toBe('"a,b"');
  });

  test("double-quote => wrapped and interior quotes doubled", () => {
    expect(escapeCSVCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  test("newline (LF) => wrapped (the bug the mass-update escaper missed)", () => {
    expect(escapeCSVCell("line1\nline2")).toBe('"line1\nline2"');
  });

  test("carriage return (CR) => wrapped", () => {
    expect(escapeCSVCell("line1\rline2")).toBe('"line1\rline2"');
  });

  test("alwaysQuote wraps even a plain value (preserves fully-quoted routes)", () => {
    expect(escapeCSVCell("Widget", true)).toBe('"Widget"');
    expect(escapeCSVCell("", true)).toBe('""'); // empty string still quotes under alwaysQuote
    expect(escapeCSVCell(null, true)).toBe(""); // ...but null/undefined stay empty
  });

  test("formula-injection IS neutralized (Lane 5 S7): leading =+-@ TAB CR get a ' prefix", () => {
    expect(escapeCSVCell("=1+1")).toBe("'=1+1");
    expect(escapeCSVCell("+cmd")).toBe("'+cmd");
    expect(escapeCSVCell("-2")).toBe("'-2");
    expect(escapeCSVCell("@ref")).toBe("'@ref");
    expect(escapeCSVCell("\tnope")).toBe("'\tnope");
    // A classic DDE payload is neutralized to inert text.
    expect(escapeCSVCell('=cmd()|"/C calc"!A0')).toBe("\"'=cmd()|\"\"/C calc\"\"!A0\"");
    // Prefix is applied BEFORE quoting: a value with both a lead char and a comma
    // gets the ' prefix inside the quotes.
    expect(escapeCSVCell("=1,2")).toBe("\"'=1,2\"");
    // A leading CR is neutralized AND quoted (CR still triggers RFC 4180 quoting).
    expect(escapeCSVCell("\rboom")).toBe("\"'\rboom\"");
  });

  test("safe leading characters are untouched", () => {
    expect(escapeCSVCell("Widget")).toBe("Widget");
    expect(escapeCSVCell("3.5mg")).toBe("3.5mg");
    expect(escapeCSVCell("(paren)")).toBe("(paren)");
  });
});

describe("rowsToCSV", () => {
  test("serializes a matrix, rows joined by newline", () => {
    const csv = rowsToCSV([
      ["Name", "Qty"],
      ["Widget", "5"],
      ["a,b", "10"],
    ]);
    expect(csv).toBe('Name,Qty\nWidget,5\n"a,b",10');
  });

  test("alwaysQuote quotes every cell", () => {
    const csv = rowsToCSV([["Name", "Qty"], ["Widget", "5"]], { alwaysQuote: true });
    expect(csv).toBe('"Name","Qty"\n"Widget","5"');
  });

  test("newline inside a data cell is quoted, keeping the CSV well-formed", () => {
    const csv = rowsToCSV([["Multi\nline", "1"]]);
    expect(csv).toBe('"Multi\nline",1');
  });
});
