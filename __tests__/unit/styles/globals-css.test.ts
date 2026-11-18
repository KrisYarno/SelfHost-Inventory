//
// Facelift F0-10 (plan 2026-11-17-facelift-f0, F0-10 + the REV 2 folds) — phone
// animations at normal speed, and readable dark-mode error text.
//
// 1. A `@media (max-width: 640px)` rule forced EVERY animation and transition on
//    a phone to 200 ms (`!important`), which cut short any longer motion (the
//    5 s timer bar ended in 200 ms). Only that `*, *::before, *::after` rule is
//    gone: the media block's `hover: none` and scrollbar rules stay, and the
//    `prefers-reduced-motion` block stays.
// 2. Dark `--destructive` is a FILL colour (0 62.8% 30.6%): as text on the dark
//    navy it is about 1.5-1.8:1. `text-destructive` now reads its own token,
//    `--destructive-text`: the light `--destructive` in light mode, the dark
//    `--negative` in dark mode. Fills (`bg-`, `border-`) keep `--destructive`.

import fs from "fs";
import path from "path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import resolveConfig from "tailwindcss/resolveConfig";
import tailwindConfig from "@/tailwind.config";

const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

/** The body of the first `<selector> {` block (these blocks hold no nested braces). */
function block(selector: string): string {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`no ${selector} block in globals.css`);
  return m[2];
}

function token(body: string, name: string): string {
  const m = body.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`no ${name} in block`);
  return m[1].trim();
}

describe("F0-10 — phone animations at normal speed", () => {
  it("no rule forces animation-duration or transition-duration to 200ms", () => {
    expect(css).not.toMatch(/animation-duration:\s*200ms/);
    expect(css).not.toMatch(/transition-duration:\s*200ms/);
  });

  it("the 640px block keeps its hover:none and scrollbar rules", () => {
    const start = css.indexOf("@media (max-width: 640px)");
    expect(start).toBeGreaterThan(-1);
    const after = css.slice(start, start + 1200);
    expect(after).toContain("@media (hover: none)");
    expect(after).toContain(".overflow-x-auto::-webkit-scrollbar");
  });

  it("the prefers-reduced-motion block stays", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: 0\.01ms !important/);
  });
});

describe("F0-10 — the destructive TEXT token", () => {
  it("light --destructive-text is the light --destructive; dark is the dark --negative", () => {
    const root = block(":root");
    const dark = block(".dark");
    expect(token(root, "--destructive-text")).toBe(token(root, "--destructive"));
    expect(token(dark, "--destructive-text")).toBe(token(dark, "--negative"));
    // and the dark fill itself is untouched
    expect(token(dark, "--destructive")).toBe("0 62.8% 30.6%");
  });

  it("the resolved config maps textColor.destructive.DEFAULT to --destructive-text; fills keep --destructive", () => {
    const theme = resolveConfig(tailwindConfig).theme as unknown as Record<string, Record<string, unknown>>;
    expect(theme.textColor.destructive).toEqual({
      DEFAULT: "hsl(var(--destructive-text) / <alpha-value>)",
      foreground: "hsl(var(--destructive-foreground))",
    });
    expect((theme.backgroundColor.destructive as Record<string, string>).DEFAULT).toBe("hsl(var(--destructive))");
    expect((theme.borderColor.destructive as Record<string, string>).DEFAULT).toBe("hsl(var(--destructive))");
    // extended, not replaced: every other text colour is still there. (F1-2
    // gave text-primary its own token, `--primary-text`; it is pinned in
    // f1-tokens.test.ts. The text-primary key itself must still exist.)
    expect((theme.textColor.primary as Record<string, string>).DEFAULT).toBe("hsl(var(--primary-text) / <alpha-value>)");
    expect(theme.textColor.negative).toBeDefined();
  });

  it("generated CSS: text-destructive (and its prefixed and opacity forms) read the token; bg-destructive does not", async () => {
    const result = await postcss([
      tailwindcss({
        ...tailwindConfig,
        content: [{ raw: '<div class="text-destructive hover:text-destructive text-destructive/70 bg-destructive">', extension: "html" }],
        corePlugins: { preflight: false },
      }),
    ]).process("@tailwind utilities;", { from: undefined });
    const out = result.css;

    const rule = (sel: string) => {
      const m = out.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`));
      if (!m) throw new Error(`no rule for ${sel}`);
      return m[1];
    };
    expect(rule("\\.text-destructive")).toMatch(/color: hsl\(var\(--destructive-text\) \/ var\(--tw-text-opacity/);
    expect(rule("\\.hover\\\\:text-destructive:hover")).toContain("var(--destructive-text)");
    expect(rule("\\.text-destructive\\\\/70")).toContain("hsl(var(--destructive-text) / 0.7)");
    expect(rule("\\.bg-destructive")).toContain("hsl(var(--destructive))");
    expect(rule("\\.bg-destructive")).not.toContain("--destructive-text");
  });
});
