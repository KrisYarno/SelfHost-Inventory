"use client";

/**
 * components/assistant/markdown.tsx — the assistant message renderer (spec §12
 * D-B2, security-relevant).
 *
 * Contract:
 *   - element allowlist ONLY: p/br/h2/h3/ul/ol/li/strong/em/a/code/pre;
 *   - raw HTML is NOT parsed (no rehype-raw) and rehype-sanitize strips any
 *     disallowed element as defense-in-depth — a model-authored `<script>` or
 *     `<table>` never becomes a live node;
 *   - links are protocol-allowlisted (http/https/mailto) and always open with a
 *     safe rel/target;
 *   - model-authored markdown TABLES are unsupported (the `table` family is not
 *     in the allowlist, so remark-gfm's table output is stripped to inert text —
 *     structured tool results own tables via ToolResultTable);
 *   - fenced code gets a language label, internal horizontal scroll, and a 44px
 *     Copy button.
 *
 * Untrusted tool fields (product names) are NEVER routed through this renderer —
 * they render as escaped React text in ToolResultTable (D13). This component
 * renders only assistant-authored prose.
 *
 * The sanitize schema is a self-contained constant (`MARKDOWN_SANITIZE_SCHEMA`)
 * so the security contract is unit-testable without importing the ESM renderer.
 */

import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

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
    "h2",
    "h3",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "a",
    "code",
    "pre",
  ],
  attributes: {
    a: ["href"],
    code: ["className"],
  },
} as const;

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success("Code copied");
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Could not copy code");
        }
      }}
      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-md px-2 text-body-sm text-muted-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label="Copy code"
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
        <span className="text-body-sm font-medium text-muted-foreground">
          {language || "code"}
        </span>
        <CopyButton value={value} />
      </div>
      <pre className="overflow-x-auto p-3 text-body-sm">
        <code className="font-mono">{value}</code>
      </pre>
    </div>
  );
}

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
  // Render fenced code (with a language) as a labeled, scrollable, copyable
  // block; inline code stays a simple <code>.
  code: ({ className, children, ...rest }) => {
    const match = /language-(\w+)/.exec(className || "");
    if (match) {
      return <CodeBlock language={match[1]} value={String(children).replace(/\n$/, "")} />;
    }
    return (
      <code
        className="rounded bg-surface px-1 py-0.5 font-mono text-[0.9em]"
        {...rest}
      >
        {children}
      </code>
    );
  },
  // The CodeBlock provides its own <pre>; pass fenced children straight through
  // so a labeled block is not double-wrapped.
  pre: ({ children }) => <>{children}</>,
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
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]]}
        components={COMPONENTS}
      >
        {children}
      </Markdown>
    </div>
  );
}
