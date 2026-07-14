/** @jest-environment jsdom */
/**
 * Lane 5 S7 — the client download path (exportToCSV) shares the one escaper, so
 * it neutralizes formula injection too. Captures the Blob content the function
 * would download and asserts the =cmd() cell was prefixed with '.
 */

import { exportToCSV } from "@/lib/export-utils";

test("exportToCSV neutralizes a leading-formula cell (=cmd())", () => {
  let captured = "";
  const RealBlob = global.Blob;
  const blobSpy = jest
    .spyOn(global, "Blob")
    .mockImplementation((parts: any) => {
      captured = (parts as unknown[]).join("");
      return new RealBlob(parts);
    });
  // jsdom does not implement URL.createObjectURL; provide them.
  (URL as any).createObjectURL = jest.fn(() => "blob:x");
  (URL as any).revokeObjectURL = jest.fn();

  exportToCSV(
    [{ name: "=cmd()" }, { name: "+SUM(A1)" }, { name: "Widget" }],
    [{ key: "name", label: "Name" }],
    "x.csv"
  );

  expect(captured).toContain("'=cmd()");
  expect(captured).toContain("'+SUM(A1)");
  expect(captured).toContain("Widget");
  // No line/cell begins with a bare formula lead char.
  expect(/(^|\n|,)[=+\-@]/.test(captured)).toBe(false);

  blobSpy.mockRestore();
});
