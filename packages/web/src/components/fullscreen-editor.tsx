import { ColumnsIcon, EyeIcon, Maximize2Icon, Minimize2Icon, PencilIcon, SaveIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ViewMode = "edit" | "split" | "preview";
const MODE_KEY = "slaves.fullscreenEditor.mode";
const MODES: { id: ViewMode; label: string; icon: typeof EyeIcon }[] = [
  { id: "edit", label: "Edit", icon: PencilIcon },
  { id: "split", label: "Split", icon: ColumnsIcon },
  { id: "preview", label: "Preview", icon: EyeIcon },
];

function readMode(): ViewMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "edit" || v === "split" || v === "preview") return v;
  } catch {
    /* storage unavailable */
  }
  return "edit";
}

/** Splits leading YAML frontmatter (`---` … `---`) off, so it shows as a block instead of a rule + heading. */
function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1] ?? "", body: text.slice(m[0].length) };
}

function MarkdownPreview({ text }: { text: string }) {
  const { frontmatter, body } = splitFrontmatter(text);
  if (!text.trim()) return <p className="text-[13px] text-muted-foreground">Nothing to preview.</p>;
  return (
    <>
      {frontmatter !== null && (
        <pre className="scroll-quiet mb-3 overflow-x-auto rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-2">
          {frontmatter}
        </pre>
      )}
      <Markdown>{body}</Markdown>
    </>
  );
}

/** Small ⤢ button that opens a FullscreenEditor. */
export function FullscreenButton({ onClick, label = "Open full screen" }: { onClick: () => void; label?: string }) {
  return (
    <Button size="icon-sm" variant="ghost" onClick={onClick} title={label} aria-label={label}>
      <Maximize2Icon />
    </Button>
  );
}

/**
 * Full-window editor for long text (base prompts). It edits the same draft as the inline
 * textarea, so switching between the two never loses anything. ⌘/Ctrl+S saves, Esc exits.
 * Edit / Split / Preview renders the text as markdown; the chosen view is remembered.
 */
export function FullscreenEditor({
  open,
  onOpenChange,
  title,
  note,
  value,
  onChange,
  placeholder,
  dirty,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Small text under the editor, e.g. where it is stored. */
  note?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  dirty?: boolean;
  saving?: boolean;
  onSave?: () => void;
}) {
  const [mode, setModeState] = useState<ViewMode>(readMode);
  const setMode = (m: ViewMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable */
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (dirty && !saving) onSave?.();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[calc(100vh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-none gap-3 p-4">
        <div className="flex items-center gap-2 pr-8">
          <DialogTitle>{title}</DialogTitle>
          {dirty && <Badge variant="warning">unsaved</Badge>}
          <div role="group" aria-label="View" className="ml-auto flex rounded-md border border-rule p-0.5">
            {MODES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={mode === id}
                onClick={() => setMode(id)}
                className={cn(
                  "inline-flex h-6 cursor-pointer items-center gap-1 rounded px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:text-ink [&_svg]:size-3.5",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--color-focus)",
                  mode === id && "bg-paper-2 text-ink",
                )}
              >
                <Icon /> {label}
              </button>
            ))}
          </div>
        </div>
        <DialogDescription className="sr-only">Full-screen editor. Press Escape to exit.</DialogDescription>
        <div className="flex min-h-0 flex-1 gap-3" onKeyDown={onKeyDown}>
          {mode !== "preview" && (
            <Textarea
              autoFocus
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none font-mono text-[13px] leading-relaxed"
            />
          )}
          {mode !== "edit" && (
            <div
              tabIndex={-1}
              className="scroll-quiet min-h-0 min-w-0 flex-1 overflow-y-auto rounded-md border border-rule px-5 py-4 outline-none"
            >
              <MarkdownPreview text={value} />
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-muted-foreground">
            {note ? `${note} · ` : ""}
            {value.length.toLocaleString()} characters · ⌘S to save · Esc to exit
          </span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
              <Minimize2Icon /> Exit full screen
            </Button>
            {onSave && (
              <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
                <SaveIcon /> Save
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
