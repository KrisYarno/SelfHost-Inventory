/** @jest-environment jsdom */
import { getJSON, setJSON } from "@/lib/safe-storage";

test("round-trips JSON", () => {
  setJSON("k", ["a", "b"]);
  expect(getJSON<string[]>("k", [])).toEqual(["a", "b"]);
});

test("getJSON falls back on garbage", () => {
  localStorage.setItem("bad", "{not json");
  expect(getJSON("bad", "fallback")).toBe("fallback");
});

test("setJSON swallows storage errors", () => {
  const spy = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
  expect(() => setJSON("k", 1)).not.toThrow();
  spy.mockRestore();
});
