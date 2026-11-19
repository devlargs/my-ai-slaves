import type { RepoPrompt, SavedPromptView } from "@my-ai-slaves/shared";
import { CheckIcon, FolderGit2Icon, LibraryBigIcon, type LucideIcon, XIcon } from "lucide-react";
import { type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface PromptOption {
  id: string;
  name: string;
  body: string;
  /** Repo prompts: pre-ticked on new tasks. */
  default?: boolean;
}

export interface PromptSource {
  prompts: PromptOption[];
  /** Which list `prompts` belongs to (the repo id, or "library"); null until the first load. */
  loadedFor: string | null;
  reload(): void;
}

/** The saved prompt library, refetched whenever a picker opens so edits elsewhere show up. */
export function usePromptLibrary(): PromptSource {
  const [prompts, setPrompts] = useState<SavedPromptView[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const reload = useCallback(() => {
    api
      .getPrompts()
      .then((list) => {
        setPrompts(list);
        setLoadedFor("library");
      })
      .catch(() => {});
  }, []);
  useEffect(reload, [reload]);
  return { prompts, loadedFor, reload };
}

/** One repo's prompts (from the Repos page). Switching repos clears the list until the new one loads. */
export function useRepoPrompts(repo: string | undefined): PromptSource {
  const [state, setState] = useState<{ repo: string | null; prompts: RepoPrompt[] }>({ repo: null, prompts: [] });
  const reload = useCallback(() => {
    if (!repo) return;
    api
      .getRepoPrompts(repo)
      .then((prompts) => setState({ repo, prompts }))
      .catch(() => {});
  }, [repo]);
  useEffect(() => {
    setState({ repo: null, prompts: [] });
    reload();
  }, [reload]);
  return { prompts: state.prompts, loadedFor: state.repo, reload };
}

const NO_PROMPTS: RepoPrompt[] = [];

/**
 * The prompts of every repo ticked for a task (the main one first), and which are ticked from each.
 * A repo's default prompts come pre-ticked when it's added.
 */
export function useRepoPromptSets(repoIds: string[]) {
  const [lists, setLists] = useState<Record<string, RepoPrompt[]>>({});
  const [ticked, setTicked] = useState<Record<string, string[]>>({});
  const requested = useRef(new Set<string>());

  const load = useCallback((repo: string, tickDefaults: boolean) => {
    api
      .getRepoPrompts(repo)
      .then((prompts) => {
        setLists((prev) => ({ ...prev, [repo]: prompts }));
        if (tickDefaults) setTicked((prev) => ({ ...prev, [repo]: prompts.filter((p) => p.default).map((p) => p.id) }));
      })
      .catch(() => {});
  }, []);

  const key = repoIds.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the list of repos
  useEffect(() => {
    for (const repo of [...requested.current]) {
      if (repoIds.includes(repo)) continue;
      // Dropped: forget its ticks, so adding it again starts from its defaults.
      requested.current.delete(repo);
      setTicked(({ [repo]: _, ...rest }) => rest);
    }
    for (const repo of repoIds) {
      if (requested.current.has(repo)) continue;
      requested.current.add(repo);
      load(repo, true);
    }
  }, [key, load]);

  const source = (repo: string): PromptSource => ({
    prompts: lists[repo] ?? NO_PROMPTS,
    loadedFor: lists[repo] ? repo : null,
    reload: () => load(repo, false),
  });
  const bound = (repo: string): BoundPrompts => ({
    ids: ticked[repo] ?? [],
    setIds: (update) =>
      setTicked((prev) => {
        const current = prev[repo] ?? [];
        const next = typeof update === "function" ? update(current) : update;
        return next === current ? prev : { ...prev, [repo]: next };
      }),
  });
  /** Ticked ids per repo; a repo whose list hasn't loaded yet is left out (the server sends its defaults). */
  const tickedFor = (repo: string): string[] | undefined => (lists[repo] ? (ticked[repo] ?? []) : undefined);
  const resetToDefaults = () =>
    setTicked(Object.fromEntries(Object.entries(lists).map(([repo, prompts]) => [repo, prompts.filter((p) => p.default).map((p) => p.id)])));
  const count = repoIds.reduce((n, repo) => n + (ticked[repo]?.length ?? 0), 0);
  return { source, bound, tickedFor, resetToDefaults, count };
}

export interface BoundPrompts {
  ids: string[];
  setIds: Dispatch<SetStateAction<string[]>>;
}

/** State for prompts bound to one message. Ids are kept in list order. */
export function useBoundPrompts(): BoundPrompts {
  const [ids, setIds] = useState<string[]>([]);
  return { ids, setIds };
}

/** One group in the picker: a prompt list and what's ticked from it. */
export interface PromptSection {
  key: string;
  title: string;
  icon: LucideIcon;
  source: PromptSource;
  bound: BoundPrompts;
  manageHref: string;
  /** Shown when the list is empty. */
  empty: ReactNode;
}

export const repoSection = (repo: string | undefined, source: PromptSource, bound: BoundPrompts): PromptSection => ({
  key: `repo:${repo ?? ""}`,
  title: repo ? `${repo} prompts` : "Repo prompts",
  icon: FolderGit2Icon,
  source,
  bound,
  manageHref: "#/repos",
  empty: "This repo has no prompts yet. Add some on the Repos page.",
});

export const librarySection = (source: PromptSource, bound: BoundPrompts): PromptSection => ({
  key: "library",
  title: "Saved prompts",
  icon: LibraryBigIcon,
  source,
  bound,
  manageHref: "#/prompts",
  empty: "No saved prompts yet. Add some on the Prompts page.",
});

/** Toolbar button + popover to tick which prompts go with the message being written. */
export function PromptPicker({ sections, footer }: { sections: PromptSection[]; footer: ReactNode }) {
  const [open, setOpen] = useState(false);
  const count = sections.reduce((n, s) => n + s.bound.ids.length, 0);

  return (
    <>
    {sections.map((s) => (
      <Prune key={s.key} section={s} />
    ))}
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) for (const s of sections) s.source.reload();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={cn("gap-1 px-2", count > 0 && "text-ink")}
          title="Pick the prompts to send with this message"
          aria-label="Prompts"
        >
          <LibraryBigIcon />
          Prompts
          {count > 0 && <span className="num rounded-full bg-ink px-1.5 text-[10px] leading-4 text-paper">{count}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top">
        <div className="scroll-quiet max-h-96 overflow-auto">
          {sections.map((section, i) => (
            <PickerSection key={section.key} section={section} first={i === 0} onNavigate={() => setOpen(false)} />
          ))}
        </div>
        <p className="border-t border-rule px-3 py-2 text-[11px] leading-snug text-muted-foreground">{footer}</p>
      </PopoverContent>
    </Popover>
    </>
  );
}

/** A prompt deleted elsewhere can't stay ticked (the server would refuse the task). */
function Prune({ section: { source, bound } }: { section: PromptSection }) {
  const { prompts, loadedFor } = source;
  const { setIds } = bound;
  useEffect(() => {
    if (loadedFor === null) return;
    setIds((prev) => {
      const next = prev.filter((id) => prompts.some((p) => p.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [prompts, loadedFor, setIds]);
  return null;
}

function PickerSection({ section, first, onNavigate }: { section: PromptSection; first: boolean; onNavigate: () => void }) {
  const { source, bound } = section;
  const selected = new Set(bound.ids);
  // Functional update: quick successive clicks each see the latest selection.
  const toggle = (id: string) =>
    bound.setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return source.prompts.filter((p) => next.has(p.id)).map((p) => p.id);
    });

  return (
    <section className={cn(!first && "border-t border-rule")}>
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="label-mono truncate">{section.title}</span>
        <a
          href={section.manageHref}
          className="shrink-0 text-xs text-signal-ink underline-offset-4 hover:underline"
          onClick={onNavigate}
        >
          Manage
        </a>
      </div>
      {source.prompts.length === 0 ? (
        <p className="px-3 pb-3 text-[13px] leading-relaxed text-muted-foreground">
          {source.loadedFor === null ? "Loading…" : section.empty}
        </p>
      ) : (
        <ul className="p-1 pt-0" role="listbox" aria-multiselectable aria-label={section.title}>
          {source.prompts.map((p) => {
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
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-ink">{p.name}</span>
                      {p.default && <span className="label-mono shrink-0 text-[10px] text-muted-foreground">default</span>}
                    </span>
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
    </section>
  );
}

/** Chips for the prompts ticked for the message being written. */
export function BoundPromptChips({ sections }: { sections: PromptSection[] }) {
  const chips = sections.flatMap((section) => {
    const byId = new Map(section.source.prompts.map((p) => [p.id, p]));
    return section.bound.ids.map((id) => ({ section, id, prompt: byId.get(id) }));
  });
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Prompts sent with this message">
      {chips.map(({ section, id, prompt }) => {
        const Icon = section.icon;
        const name = prompt?.name ?? id;
        return (
          <li
            key={`${section.key}:${id}`}
            className="flex h-6 items-center gap-1 rounded-full border border-rule bg-paper-2 pr-0.5 pl-2.5 text-[11px] font-medium text-ink-2"
            title={`${section.title}: ${prompt?.body ?? ""}`}
          >
            <Icon className="size-3 text-muted-foreground" />
            {name}
            <button
              type="button"
              aria-label={`Don't send ${name}`}
              onClick={() => section.bound.setIds((prev) => prev.filter((x) => x !== id))}
              className="flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-paper-3 hover:text-ink"
            >
              <XIcon className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
