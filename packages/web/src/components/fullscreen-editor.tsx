import { Maximize2Icon, Minimize2Icon, SaveIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[calc(100vh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-none gap-3 p-4">
        <div className="flex items-center gap-2 pr-8">
          <DialogTitle>{title}</DialogTitle>
          {dirty && <Badge variant="warning">unsaved</Badge>}
        </div>
        <DialogDescription className="sr-only">Full-screen editor. Press Escape to exit.</DialogDescription>
        <Textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (dirty && !saving) onSave?.();
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none font-mono text-[13px] leading-relaxed"
        />
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
