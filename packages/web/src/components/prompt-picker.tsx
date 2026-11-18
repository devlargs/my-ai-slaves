import type { SavedPromptView } from "@my-ai-slaves/shared";
import { CheckIcon, LibraryBigIcon, XIcon } from "lucide-react";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The saved prompt library, refetched whenever a picker opens so edits elsewhere show up. */
export function usePromptLibrary() {
  const [prompts, setPrompts] = useState<SavedPromptView[]>([]);
  const reload = useCallback(() => {
    api
      .getPrompts()
      .then(setPrompts)
      .catch(() => {});
  }, []);
  useEffect(reload, [reload]);
  return { prompts, reload };
}

export interface BoundPrompts {
  ids: string[];
  setIds: Dispatch<SetStateAction<string[]>>;
}

/** State for prompts bound to one message. Ids are kept in library order. */
export function useBoundPrompts(): BoundPrompts {
  const [ids, setIds] = useState<string[]>([]);
  return { ids, setIds };
}

/** Toolbar button + popover to bind saved prompts to the message being written. */
export function PromptPicker({ bound, library }: { bound: BoundPrompts; library: ReturnType<typeof usePromptLibrary> }) {
  const [open, setOpen] = useState(false);
  const selected = new Set(bound.ids);
  // Functional update: quick successive clicks each see the latest selection.
  const toggle = (id: string) =>
    bound.setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return library.prompts.filter((p) => next.has(p.id)).map((p) => p.id);
    });

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) library.reload();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={cn("gap-1 px-2", bound.ids.length > 0 && "text-ink")}
          title="Bind saved prompts to this message"
          aria-label="Saved prompts"
        >
          <LibraryBigIcon />
          Prompts
          {bound.ids.length > 0 && (
            <span className="num rounded-full bg-ink px-1.5 text-[10px] leading-4 text-paper">{bound.ids.length}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top">
        <div className="flex items-center justify-between border-b border-rule px-3 py-2">
          <span className="label-mono">Bind saved prompts</span>
          <a href="#/prompts" className="text-xs text-signal-ink underline-offset-4 hover:underline" onClick={() => setOpen(false)}>
            Manage
          </a>
        </div>
        {library.prompts.length === 0 ? (
          <p className="px-3 py-3 text-[13px] leading-relaxed text-muted-foreground">
            No saved prompts yet. Add some on the{" "}
            <a href="#/prompts" className="text-signal-ink underline-offset-4 hover:underline" onClick={() => setOpen(false)}>
              Prompts
            </a>{" "}
            page.
          </p>
        ) : (
          <ul className="scroll-quiet max-h-72 overflow-auto p-1" role="listbox" aria-multiselectable>
            {library.prompts.map((p) => {
              const on = selected.has(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(p.id)}
                    className="flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                        on ? "border-ink bg-ink text-paper" : "border-rule-strong bg-surface",
                      )}
                      aria-hidden
                    >
                      {on && <CheckIcon className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink">{p.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {p.body.trim().split("\n")[0] || "(empty)"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="border-t border-rule px-3 py-2 text-[11px] text-muted-foreground">
          Sent after the base prompts, before your message, in library order.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** Chips for the prompts bound to the message being written. */
export function BoundPromptChips({ bound, library }: { bound: BoundPrompts; library: ReturnType<typeof usePromptLibrary> }) {
  if (bound.ids.length === 0) return null;
  const byId = new Map(library.prompts.map((p) => [p.id, p]));
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Bound prompts">
      {bound.ids.map((id) => (
        <li
          key={id}
          className="flex h-6 items-center gap-1 rounded-full border border-rule bg-paper-2 pr-0.5 pl-2.5 text-[11px] font-medium text-ink-2"
          title={byId.get(id)?.body}
        >
          <LibraryBigIcon className="size-3 text-muted-foreground" />
          {byId.get(id)?.name ?? id}
          <button
            type="button"
            aria-label={`Unbind ${byId.get(id)?.name ?? id}`}
            onClick={() => bound.setIds((prev) => prev.filter((x) => x !== id))}
            className="flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-paper-3 hover:text-ink"
          >
            <XIcon className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
