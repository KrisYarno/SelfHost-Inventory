import { shouldAutoLoad, AUTO_LOAD_PAGE_LIMIT } from "@/lib/inventory-page-utils";

test("auto-load gate caps at the limit", () => {
  expect(AUTO_LOAD_PAGE_LIMIT).toBe(3);
  expect(shouldAutoLoad(2, true, 3)).toBe(true);
  expect(shouldAutoLoad(3, true, 3)).toBe(false);
  expect(shouldAutoLoad(3, false, 6)).toBe(false);
});
