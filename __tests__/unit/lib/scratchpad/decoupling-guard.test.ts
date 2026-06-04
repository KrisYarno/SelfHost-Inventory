/** @jest-environment node */
import { execSync } from "child_process";

const ALLOWED = ["lib/scratchpad/", "app/api/scratchpad/", "app/(app)/scratchpad/", "components/scratchpad/"];

it("P4: scratchpad data is referenced only inside its own feature dirs (display-only leaf)", () => {
  let out = "";
  try {
    out = execSync(
      'grep -rnE "scratchpadPrices|productScratchpadPrice|product_scratchpad_prices" app lib components',
      { encoding: "utf8", cwd: process.cwd() },
    );
  } catch (e: any) {
    out = e.stdout?.toString() ?? ""; // grep exits 1 when no matches
  }
  const leaks = out
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const path = line.split(":")[0];
      return !ALLOWED.some((dir) => path.startsWith(dir));
    });
  expect(leaks).toEqual([]); // any hit = a real-pricing/report/sync leak
});
