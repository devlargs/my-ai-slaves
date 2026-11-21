import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/*
 * The agent's replies are markdown (headings, tables, lists, code). Rendered here with the app's
 * tokens. Raw HTML in the text is not rendered (react-markdown escapes it).
 */
const components: Components = {
  h1: ({ node: _, ...p }) => <h3 className="mt-4 mb-1.5 text-[15px] font-semibold text-ink first:mt-0" {...p} />,
  h2: ({ node: _, ...p }) => <h3 className="mt-4 mb-1.5 text-sm font-semibold text-ink first:mt-0" {...p} />,
  h3: ({ node: _, ...p }) => <h4 className="mt-3 mb-1 text-[13px] font-semibold text-ink first:mt-0" {...p} />,
  h4: ({ node: _, ...p }) => <h5 className="mt-3 mb-1 text-[13px] font-semibold text-ink-2 first:mt-0" {...p} />,
  p: ({ node: _, ...p }) => <p className="my-1.5 first:mt-0 last:mb-0" {...p} />,
  ul: ({ node: _, ...p }) => <ul className="my-1.5 list-disc space-y-1 pl-5 marker:text-muted-foreground" {...p} />,
  ol: ({ node: _, ...p }) => <ol className="my-1.5 list-decimal space-y-1 pl-5 marker:text-muted-foreground" {...p} />,
  li: ({ node: _, ...p }) => <li className="pl-0.5 [&>input]:mr-1.5" {...p} />,
  a: ({ node: _, ...p }) => (
    <a className="text-signal-ink underline underline-offset-2 hover:no-underline" target="_blank" rel="noreferrer" {...p} />
  ),
  strong: ({ node: _, ...p }) => <strong className="font-semibold text-ink" {...p} />,
  blockquote: ({ node: _, ...p }) => (
    <blockquote className="my-2 border-l-2 border-rule-strong pl-3 text-ink-2" {...p} />
  ),
  hr: () => <hr className="my-3 border-rule" />,
  code: ({ node: _, className, ...p }) => (
    <code
      className={cn(
        "rounded bg-paper-2 px-1 py-px font-mono text-[11.5px] text-ink-2 break-words",
        // Inside a fenced block the <pre> carries the background.
        "[pre_&]:bg-transparent [pre_&]:p-0",
        className,
      )}
      {...p}
    />
  ),
  pre: ({ node: _, ...p }) => (
    <pre
      className="scroll-quiet my-2 overflow-x-auto rounded-md border border-rule bg-paper-2 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed"
      {...p}
    />
  ),
  table: ({ node: _, ...p }) => (
    <div className="scroll-quiet my-2 overflow-x-auto rounded-md border border-rule">
      <table className="w-full border-collapse text-left text-[12.5px]" {...p} />
    </div>
  ),
  thead: ({ node: _, ...p }) => <thead className="bg-paper-2" {...p} />,
  th: ({ node: _, ...p }) => <th className="border-b border-rule px-2.5 py-1.5 font-semibold text-ink" {...p} />,
  td: ({ node: _, ...p }) => <td className="border-t border-rule px-2.5 py-1.5 align-top text-ink-2" {...p} />,
};

// Memoized: parsing is the expensive part, and the same text is often rendered again unchanged.
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("min-w-0 text-[13px] leading-relaxed text-ink break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
