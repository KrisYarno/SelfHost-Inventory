//
// Facelift F1-2 and F1-3 (plan 2026-11-18-facelift-f1 REV 2) — the tokens.
//
// F1-2 (FL-A-9, FL-D-10, FL-B-4; G1-3..6):
//   - `--primary-text`: `text-primary` reads its own token in both themes. The
//     light --primary is a pale FILL (about 1.9:1 as text on the cream); the
//     text token is at least 4.5:1 against --background AND --surface in both
//     themes. Fills (bg-/border-/ring-primary) keep --primary.
//   - the Skeleton fill (`bg-foreground/10`) is distinguishable from --surface
//     and --background in both themes;
//   - light --surface-hover is 93% (was 96%), same hue and saturation.
// F1-3 (FL-A-14, FL-D-17, FL-A-8): one --dock-height variable, 0 at md and up.

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

// --- WCAG 2.x relative luminance / contrast, from an HSL token value ---------
type RGB = [number, number, number];
function hsl(value: string): RGB {
  const [h, s, l] = value.split(/\s+/).map((p) => parseFloat(p));
  const S = s / 100;
  const L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const luminance = ([r, g, b]: RGB) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `fg` at `alpha` composited over the opaque `bg`. */
const over = (fg: RGB, alpha: number, bg: RGB): RGB =>
  [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as RGB;

const THEMES = [
  ["light", () => block(":root")],
  ["dark", () => block(".dark")],
] as const;

describe("F1-2 — --primary-text", () => {
  it("light 30 80% 32%; dark 262 83% 72%", () => {
    expect(token(block(":root"), "--primary-text")).toBe("30 80% 32%");
    expect(token(block(".dark"), "--primary-text")).toBe("262 83% 72%");
    // the fills are untouched
    expect(token(block(":root"), "--primary")).toBe("35 70% 65%");
    expect(token(block(".dark"), "--primary")).toBe("262 83% 58%");
  });

  it.each(THEMES)("%s: at least 4.5:1 against --background and against --surface", (_name, body) => {
    const b = body();
    const text = hsl(token(b, "--primary-text"));
    expect(contrast(text, hsl(token(b, "--background")))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, hsl(token(b, "--surface")))).toBeGreaterThanOrEqual(4.5);
  });

  it("the resolved config maps textColor.primary to --primary-text; fills keep --primary", () => {
    const theme = resolveConfig(tailwindConfig).theme as unknown as Record<string, Record<string, unknown>>;
    expect(theme.textColor.primary).toEqual({
      DEFAULT: "hsl(var(--primary-text) / <alpha-value>)",
      foreground: "hsl(var(--primary-foreground))",
    });
    expect((theme.backgroundColor.primary as Record<string, string>).DEFAULT).toBe("hsl(var(--primary))");
    expect((theme.borderColor.primary as Record<string, string>).DEFAULT).toBe("hsl(var(--primary))");
    expect((theme.ringColor.primary as Record<string, string>).DEFAULT).toBe("hsl(var(--primary))");
    // extended, not replaced
    expect(theme.textColor.destructive).toBeDefined();
    expect(theme.textColor.negative).toBeDefined();
  });

  it("generated CSS: text-primary (prefixed, with opacity) reads the token; text-primary-foreground and bg-primary do not", async () => {
    const result = await postcss([
      tailwindcss({
        ...tailwindConfig,
        content: [
          {
            raw: '<div class="text-primary hover:text-primary text-primary/70 text-primary-foreground bg-primary">',
            extension: "html",
          },
        ],
        corePlugins: { preflight: false },
      }),
    ]).process("@tailwind utilities;", { from: undefined });
    const out = result.css;
    const rule = (sel: string) => {
      const m = out.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`));
      if (!m) throw new Error(`no rule for ${sel}`);
      return m[1];
    };
    expect(rule("\\.text-primary")).toMatch(/color: hsl\(var\(--primary-text\) \/ var\(--tw-text-opacity/);
    expect(rule("\\.hover\\\\:text-primary:hover")).toContain("var(--primary-text)");
    expect(rule("\\.text-primary\\\\/70")).toContain("hsl(var(--primary-text) / 0.7)");
    expect(rule("\\.text-primary-foreground")).toContain("hsl(var(--primary-foreground))");
    expect(rule("\\.bg-primary")).toContain("var(--primary)");
    expect(rule("\\.bg-primary")).not.toContain("--primary-text");
  });
});

describe("F1-2 — the Skeleton fill is distinguishable in both themes", () => {
  // The Skeleton's fill token, read off the component source (`bg-<token>/10`).
  const skeletonSrc = fs.readFileSync(path.join(process.cwd(), "components/ui/skeleton.tsx"), "utf8");
  const m = skeletonSrc.match(/\bbg-([a-z-]+)\/(\d+)\b/);

  it("the Skeleton fills with bg-foreground/10", () => {
    expect(m && `bg-${m[1]}/${m[2]}`).toBe("bg-foreground/10");
  });

  // "Distinguishable" is measured as the composited fill's luminance contrast
  // against the surface under it: at least 1.15:1. The old bg-primary/10
  // measured about 1.06:1 (light) and 1.07:1 (dark) and failed this.
  it.each(THEMES)("%s: the composited fill is at least 1.15:1 against --background and --surface", (_name, body) => {
    const b = body();
    const fill = hsl(token(b, `--${m![1]}`));
    const alpha = Number(m![2]) / 100;
    for (const under of ["--background", "--surface"]) {
      const base = hsl(token(b, under));
      expect(contrast(over(fill, alpha, base), base)).toBeGreaterThanOrEqual(1.15);
    }
  });
});

describe("F1-2 — light --surface-hover", () => {
  it("is 30 35% 93% (lightness 96% -> 93%, same hue and saturation); dark is unchanged", () => {
    expect(token(block(":root"), "--surface-hover")).toBe("30 35% 93%");
    expect(token(block(".dark"), "--surface-hover")).toBe("215 25% 27%");
  });
});

describe("F1-3 — the dock height", () => {
  it(":root sets --dock-height: calc(3.5rem + 1px), and an md media rule resets it to 0px", () => {
    const root = postcss.parse(css);
    const decls: Array<{ media: string | null; value: string }> = [];
    root.walkDecls("--dock-height", (d) => {
      const rule = d.parent as postcss.Rule;
      expect(rule.selector).toBe(":root");
      const media = rule.parent?.type === "atrule" && (rule.parent as postcss.AtRule).name === "media"
        ? (rule.parent as postcss.AtRule).params
        : null;
      decls.push({ media, value: d.value });
    });
    expect(decls).toEqual([
      { media: null, value: "calc(3.5rem + 1px)" },
      { media: "(min-width: 768px)", value: "0px" },
    ]);
  });

  it("compiled through Tailwind, both rules survive in the base layer", async () => {
    const result = await postcss([
      tailwindcss({ ...tailwindConfig, content: [{ raw: "<div></div>", extension: "html" }] }),
    ]).process(css, { from: undefined });
    const out = postcss.parse(result.css);
    const seen: string[] = [];
    out.walkDecls("--dock-height", (d) => {
      const parent = (d.parent as postcss.Rule).parent;
      const media = parent && parent.type === "atrule" ? `@media ${(parent as postcss.AtRule).params} ` : "";
      seen.push(`${media}${(d.parent as postcss.Rule).selector}=${d.value}`);
    });
    expect(seen).toEqual([":root=calc(3.5rem + 1px)", "@media (min-width: 768px) :root=0px"]);
  });
});
