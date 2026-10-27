"use client";

/**
 * components/assistant/markdown.tsx — the assistant message renderer (spec §12
 * D-B2, security-relevant; assistant A1 pack C1/C2).
 *
 * Contract:
 *   - element allowlist ONLY: p/br/h1-h6/hr/ul/ol/li/strong/em/del/sup/a/code/pre
 *     and the table family (table/thead/tbody/tr/th/td). Tables, every heading
 *     level, `hr`, `del` and `sup` are inert structure: no attribute is allowed on
 *     any of them (h1 renders as an h2, h4-h6 as an h3; `del` is GFM strikethrough,
 *     so a struck figure renders struck instead of reading as a second real figure;
 *     `sup` is a GFM footnote marker, so "12[^a]" renders "12", a space and a
 *     superscript marker — its text reads "12 1", never a plain "121");
 *   - strikethrough is `~~x~~` ONLY (`singleTilde: false`): "~12/day" and "20~25"
 *     render literally, never as a struck run of real figures;
 *   - raw HTML in model output is REMOVED, never shown: there is no rehype-raw, and
 *     rehype-sanitize drops `raw` nodes before react-markdown's raw->text step, so a
 *     model-authored `<script>` or `<table onclick>` never becomes a node or a
 *     visible string;
 *   - links are protocol-allowlisted (http/https/mailto) and always open with a
 *     safe rel/target;
 *   - markdown tables render inside a focusable, labelled horizontal-scroll region,
 *     widened to their widest row: a row with more cells than its header keeps every
 *     cell (the header gets an empty `th` per added column) — no cell is ever dropped —
 *     and the widened table is followed by a short italic note that its columns may
 *     be shifted (that row's figures sit under the wrong headers);
 *   - EVERY fenced block (with or without a language) gets a language label
 *     ("text" when absent), internal horizontal scroll, and a 44px Copy button;
 *     `code` alone is inline code only. The `blocks` prop carries the turn's state:
 *     "busy" disables Copy (a block still being written cannot be copied); "cut-off"
 *     says "Answer cut off — the last line may be incomplete" in the block header
 *     (Copy still copies the exact text — values are never altered — and its toast
 *     says "Copied — the last line may be incomplete");
 *   - a soft line break (a single newline — LF, CRLF or a lone CR — inside a
 *     paragraph) renders as a `br` (`remarkSoftBreaks`), so model lines never
 *     collapse into one run-on line;
 *   - the ONE raw-HTML exception: a bare `<br>` tag (any case, `<br/>`, attributes
 *     dropped, a block line's surrounding spaces allowed; `<br-foo>` is not one)
 *     becomes a markdown line break (`remarkSoftBreaks`) before the sanitizer runs,
 *     so `10<br>20` in a table cell renders two figures on two lines, never "1020";
 *     a line ending right after it is the same break, not a second one. Nothing of
 *     the tag survives. Every OTHER inline raw HTML (inside a paragraph, heading,
 *     emphasis, link, table cell…) becomes a single space, so the figures on either
 *     side never fuse (`10<sup>2</sup>`, `10<!-- x -->20`); block-level raw HTML is
 *     left to the sanitizer, which removes it.
 *
 * Untrusted tool fields (product names) render only through ToolResultTable, as
 * escaped React text (D13). Product names the model echoes into its prose do pass
 * through this renderer — as escaped text within the allowlist above.
 *
 * The sanitize schema is a self-contained constant (`MARKDOWN_SANITIZE_SCHEMA`)
 * so the security contract is unit-testable without importing the ESM renderer;
 * the rendered output is pinned through a spawned ESM probe
 * (__tests__/unit/components/assistant-markdown-render.test.ts).
 */

import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyCodeBlock } from "@/components/assistant/code-copy";

/**
 * The rehype-sanitize schema. Self-contained (does NOT extend `defaultSchema`)
 * so the allowlist is explicit and testable. Anything not listed in `tagNames`
 * is removed; `script`/`style` are stripped WITH their content.
 */
export const MARKDOWN_SANITIZE_SCHEMA = {
  strip: ["script", "style"],
  clobberPrefix: "assistant-md",
  clobber: [],
  ancestors: {},
  protocols: {
    href: ["http", "https", "mailto"],
  },
  tagNames: [
    "p",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "del",
    "sup",
    "a",
    "code",
    "pre",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ],
  attributes: {
    a: ["href"],
    code: ["className"],
  },
} as const;

/** The minimal mdast shape `remarkSoftBreaks` touches (no mdast/unist dependency). */
type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  /** `table` only: one entry per column; mdast-util-to-hast renders that many cells. */
  align?: (string | null)[];
};

/** A line ending: CRLF, a lone CR, or LF. */
const SOFT_BREAK = /\r\n?|\n/;
const LEADING_LINE_ENDING = /^(?:\r\n?|\n)/;

/** A raw `<br>` tag alone: `<br>`, `<br/>`, `<BR>`, `<br class="x">`, a block line's
 *  surrounding spaces — nothing else (`<br-foo>` is not a `<br>`). */
const BR_TAG = /^\s*<br(?=[\s/>])[^>]*>\s*$/i;

/** The mdast parents whose `html` children are BLOCK html (left to the sanitizer);
 *  every other parent is a phrasing container (paragraph, heading, emphasis, strong,
 *  delete, link, table cell…). */
const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

/** The note a widened table carries, as its next sibling (A1 pack C12). */
const SHIFTED_COLUMNS_NOTE = "A row in this table has more cells than its header, so its columns may be shifted.";

/** Normalizes `node` in place; returns true when `node` is a table it widened (the
 *  caller then puts the note right after it). */
function normalize(node: MdastNode): boolean {
  let widened = false;
  if (node.type === "table" && Array.isArray(node.align) && node.children) {
    // mdast-util-to-hast's table-row renders exactly `align.length` cells, so a row
    // wider than its header would silently lose its last cells.
    const widest = node.children.reduce((w, row) => Math.max(w, row.children?.length ?? 0), 0);
    widened = node.align.length < widest;
    while (node.align.length < widest) node.align.push(null);
  }
  const children = node.children;
  if (!children) return widened;
  let changed = false;
  let afterBrTag = false;
  const next: MdastNode[] = [];
  for (const child of children) {
    const brTag = child.type === "html" && typeof child.value === "string" && BR_TAG.test(child.value);
    if (brTag) {
      // A fresh node: the tag's text and attributes are dropped, never carried.
      next.push({ type: "break" });
      changed = true;
    } else if (child.type === "html" && !BLOCK_PARENTS.has(node.type)) {
      // Inline raw HTML: the sanitizer would drop it and fuse its neighbours, so it
      // becomes one space. Nothing of the tag survives.
      next.push({ type: "text", value: " " });
      changed = true;
    } else if (child.type === "text" && typeof child.value === "string") {
      // The line ending right after a `<br>` is that same break, not a second one.
      const value = afterBrTag ? child.value.replace(LEADING_LINE_ENDING, "") : child.value;
      if (value !== child.value || SOFT_BREAK.test(value)) {
        value.split(SOFT_BREAK).forEach((piece, i) => {
          if (i > 0) next.push({ type: "break" });
          if (piece !== "") next.push({ type: "text", value: piece });
        });
        changed = true;
      } else {
        next.push(child);
      }
    } else if (child.type === "footnoteReference") {
      // A space before the marker: "12" + "1" is "12 1" as text too (copy-paste, a
      // screen reader), never "121".
      next.push({ type: "text", value: " " }, child);
      changed = true;
    } else {
      const childWidened = normalize(child);
      next.push(child);
      if (childWidened) {
        // The wide row's figures sit under the wrong headers: say so, right after it.
        next.push({
          type: "paragraph",
          children: [{ type: "emphasis", children: [{ type: "text", value: SHIFTED_COLUMNS_NOTE }] }],
        });
        changed = true;
      }
    }
    afterBrTag = brTag;
  }
  if (changed) node.children = next;
  return widened;
}

/**
 * Remark plugin: every soft line break becomes a hard `break` node (remark-breaks'
 * behaviour, in-repo). Walks the WHOLE tree: each `text` node at any depth
 * (paragraphs, emphasis, strong, links, list items, table cells, blockquotes) is
 * split on `\r\n` / a lone `\r` / `\n` into its pieces interleaved with `break`
 * nodes, in sibling order. `code` / `inlineCode` hold literal values (not `text`
 * children) and are untouched.
 *
 * Also (A1 pack C2 REV 7, C11):
 *   - an `html` node, inline or block, whose value is a bare `<br>` tag
 *     (`/^\s*<br(?=[\s/>])[^>]*>\s*$/i`: attributes, a self-closing slash and a block
 *     line's surrounding spaces allowed; `<br-foo>` is NOT one) is replaced by a
 *     `break` — nothing of the tag (no attribute) survives. GFM table cells cannot
 *     hold a newline, so a model writes `10<br>20`; the sanitizer would drop the tag
 *     and fuse the figures into "1020". A `text` sibling right after it that STARTS
 *     with a line ending loses that one line ending, so `10<br>\n20` is ONE break;
 *   - every OTHER `html` node whose parent is a phrasing container (any parent but
 *     `root`, `blockquote`, `listItem`, `footnoteDefinition`) is replaced by a
 *     single-space `text` node: the sanitizer would drop it and fuse its neighbours
 *     (`10<sup>2</sup>` -> "102", `10<!-- x -->20` -> "1020"). Block-level `html` is
 *     left as it is (the sanitizer removes it);
 *   - every `table` whose widest row has more cells than `align.length` gets `align`
 *     extended with `null` to that width: mdast-util-to-hast renders exactly
 *     `align.length` cells per row, so an extra cell (an unescaped `|` in a product
 *     name is enough) would vanish. The header row then shows an empty `th` for each
 *     added column; a table whose rows all fit is untouched;
 *   - (pack C12) a table so widened gets, as its NEXT sibling in the same parent, a
 *     `paragraph` > `emphasis` > `text` note: "A row in this table has more cells than
 *     its header, so its columns may be shifted." — every cell is kept, but that row's
 *     figures sit under the wrong headers;
 *   - (pack C12) a single-space `text` node goes right before every
 *     `footnoteReference`, so `12[^a]` reads "12 1" as text, never "121".
 */
export function remarkSoftBreaks() {
  return (tree: MdastNode) => {
    normalize(tree);
  };
}

/** A fenced block's turn state (A1 pack C11): "busy" = the turn is still writing it;
 *  "cut-off" = the turn stopped mid-answer, so its last line may be incomplete. */
type CodeBlocks = "complete" | "busy" | "cut-off";

// Read by CodeBlock; set by AssistantMarkdown's `blocks` prop.
const CodeBlocksContext = React.createContext<CodeBlocks>("complete");

// The exact block text is always copied; a csv block also carries an HTML table of
// the same cells so a spreadsheet pastes cells, not one column (A1 pack C2b). A block
// still being written cannot be copied: `disabled`, same label and size (pack C11). A
// cut-off block's copy says its last line may be incomplete (pack C12).
function CopyButton({
  value,
  language,
  disabled,
  cutOff,
}: {
  value: string;
  language: string;
  disabled: boolean;
  cutOff: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={async () => {
        try {
          await copyCodeBlock(value, language, {
            clipboard: navigator.clipboard,
            ClipboardItem: globalThis.ClipboardItem,
          });
          setCopied(true);
          toast.success(cutOff ? "Copied — the last line may be incomplete" : "Copied");
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Could not copy");
        }
      }}
      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-md px-2 text-body-sm text-muted-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50"
      aria-label={`Copy ${language}`}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const blocks = React.useContext(CodeBlocksContext);
  return (
    <div className="my-3 overflow-hidden rounded-md border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="text-body-sm font-medium text-muted-foreground">{language}</span>
          {blocks === "cut-off" && (
            <span className="text-body-sm text-muted-foreground">
              Answer cut off — the last line may be incomplete
            </span>
          )}
        </div>
        <CopyButton value={value} language={language} disabled={blocks === "busy"} cutOff={blocks === "cut-off"} />
      </div>
      <pre className="overflow-x-auto p-3 text-body-sm">
        <code className="font-mono">{value}</code>
      </pre>
    </div>
  );
}

type CodeChildProps = { className?: unknown; children?: unknown };

// Every override takes only the props it renders: react-markdown's `node` prop is
// never spread onto the DOM.
const COMPONENTS: React.ComponentProps<typeof Markdown>["components"] = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div
      role="region"
      aria-label="Table — scrolls sideways"
      tabIndex={0}
      className="my-3 overflow-x-auto rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <table className="w-full border-collapse text-body-sm tabular-nums">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface">{children}</thead>,
  th: ({ children }) => (
    <th scope="col" className="border-b border-border px-3 py-2 text-left font-semibold align-bottom">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b border-border px-3 py-2 align-top">{children}</td>,
  // h1 takes the h2 styles and h4-h6 the h3 styles (the wrapper's [&_h2]/[&_h3]).
  h1: ({ children }) => <h2>{children}</h2>,
  h4: ({ children }) => <h3>{children}</h3>,
  h5: ({ children }) => <h3>{children}</h3>,
  h6: ({ children }) => <h3>{children}</h3>,
  hr: () => <hr className="my-4 border-border" />,
  // `pre` OWNS every fenced block, with or without a language: it reads the
  // language and the text from its single child element's props (the `code`
  // element react-markdown hands it) and renders a labelled, copyable block.
  pre: ({ children }) => {
    const child = React.Children.toArray(children).find(React.isValidElement) as
      | React.ReactElement<CodeChildProps>
      | undefined;
    const className = typeof child?.props.className === "string" ? child.props.className : "";
    const match = /(?:^|\s)language-(\S+)/.exec(className);
    const raw = child?.props.children;
    const value = (raw === undefined ? "" : String(raw)).replace(/\n$/, "");
    return <CodeBlock language={match ? match[1] : "text"} value={value} />;
  },
  // `code` is INLINE code only — block code never reaches here (see `pre`).
  code: ({ className, children }) => (
    <code className={cn("rounded bg-surface px-1 py-0.5 font-mono text-[0.9em]", className)}>
      {children}
    </code>
  ),
};

export function AssistantMarkdown({
  children,
  blocks = "complete",
}: {
  children: string;
  /** The turn's state for its fenced blocks (A1 pack C11); default "complete". */
  blocks?: "complete" | "busy" | "cut-off";
}) {
  return (
    <div
      className={cn(
        "text-body leading-relaxed",
        "[&_p]:my-2 [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-h3 [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-h4",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5 [&_strong]:font-semibold",
      )}
    >
      <CodeBlocksContext.Provider value={blocks}>
        <Markdown
          remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkSoftBreaks]}
          rehypePlugins={[[rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]]}
          components={COMPONENTS}
        >
          {children}
        </Markdown>
      </CodeBlocksContext.Provider>
    </div>
  );
}
