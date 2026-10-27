"use client";

/**
 * components/assistant/markdown.tsx — the assistant message renderer (spec §12
 * D-B2, security-relevant; assistant A1 pack C1/C2).
 *
 * Contract:
 *   - element allowlist ONLY: p/br/h1-h6/hr/ul/ol/li/strong/em/a/code/pre and the
 *     table family (table/thead/tbody/tr/th/td). Tables, every heading level and
 *     `hr` are inert structure: no attribute is allowed on any of them (h1 renders
 *     as an h2, h4-h6 as an h3);
 *   - raw HTML in model output is REMOVED, never shown: there is no rehype-raw, and
 *     rehype-sanitize drops `raw` nodes before react-markdown's raw->text step, so a
 *     model-authored `<script>` or `<table onclick>` never becomes a node or a
 *     visible string;
 *   - links are protocol-allowlisted (http/https/mailto) and always open with a
 *     safe rel/target;
 *   - markdown tables render inside a focusable, labelled horizontal-scroll region;
 *   - EVERY fenced block (with or without a language) gets a language label
 *     ("text" when absent), internal horizontal scroll, and a 44px Copy button;
 *     `code` alone is inline code only;
 *   - a soft line break (a single newline inside a paragraph) renders as a `br`
 *     (`remarkSoftBreaks`), so model lines never collapse into one run-on line.
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
type MdastNode = { type: string; value?: string; children?: MdastNode[] };

const SOFT_BREAK = /\r?\n/;

function splitSoftBreaks(node: MdastNode): void {
  const children = node.children;
  if (!children) return;
  let changed = false;
  const next: MdastNode[] = [];
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string" && SOFT_BREAK.test(child.value)) {
      child.value.split(SOFT_BREAK).forEach((piece, i) => {
        if (i > 0) next.push({ type: "break" });
        if (piece !== "") next.push({ type: "text", value: piece });
      });
      changed = true;
    } else {
      splitSoftBreaks(child);
      next.push(child);
    }
  }
  if (changed) node.children = next;
}

/**
 * Remark plugin: every soft line break becomes a hard `break` node (remark-breaks'
 * behaviour, in-repo). Walks the WHOLE tree: each `text` node at any depth
 * (paragraphs, emphasis, strong, links, list items, table cells, blockquotes) is
 * split on `\r\n` / `\n` into its pieces interleaved with `break` nodes, in sibling
 * order. `code` / `inlineCode` hold literal values (not `text` children) and are
 * untouched.
 */
export function remarkSoftBreaks() {
  return (tree: MdastNode) => {
    splitSoftBreaks(tree);
  };
}

// The exact block text is always copied; a csv block also carries an HTML table of
// the same cells so a spreadsheet pastes cells, not one column (A1 pack C2b).
function CopyButton({ value, language }: { value: string; language: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await copyCodeBlock(value, language, {
            clipboard: navigator.clipboard,
            ClipboardItem: globalThis.ClipboardItem,
          });
          setCopied(true);
          toast.success("Copied");
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Could not copy");
        }
      }}
      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-md px-2 text-body-sm text-muted-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label={`Copy ${language}`}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  return (
    <div className="my-3 overflow-hidden rounded-md border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-1">
        <span className="text-body-sm font-medium text-muted-foreground">{language}</span>
        <CopyButton value={value} language={language} />
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

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div
      className={cn(
        "text-body leading-relaxed",
        "[&_p]:my-2 [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-h3 [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-h4",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5 [&_strong]:font-semibold",
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm, remarkSoftBreaks]}
        rehypePlugins={[[rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]]}
        components={COMPONENTS}
      >
        {children}
      </Markdown>
    </div>
  );
}
