import type { RepoView } from "@my-ai-slaves/shared";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** The repos a task works in: the first is the main one (the CLI runs there), the rest are opened as they are. */
export interface RepoSelection {
  main: string | undefined;
  extras: string[];
}

const machine = (r: RepoView) => r.host ?? null;
const where = (r: RepoView) => (r.host ? `on ${r.host}` : "on this Mac");

/**
 * Multi-select for the composer. Tick several repos for cross-repo work; they must be on the same
 * machine (one CLI run reaches them all), so ticking one elsewhere switches to it instead.
 */
export function RepoPicker({
  repos,
  value,
  onChange,
}: {
  repos: RepoView[];
  value: RepoSelection;
  onChange: (next: RepoSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const main = repos.find((r) => r.id === value.main);
  const extras = value.extras.map((id) => repos.find((r) => r.id === id)).filter((r): r is RepoView => Boolean(r));
  const selected = new Set([value.main, ...value.extras]);

  const toggle = (repo: RepoView) => {
    if (!main || machine(repo) !== machine(main)) return onChange({ main: repo.id, extras: [] });
    if (repo.id === main.id) {
      // Unticking the main repo: the next one takes over. The last repo can't be unticked.
      const [next, ...rest] = value.extras;
      if (next) onChange({ main: next, extras: rest });
      return;
    }
    onChange({
      main: main.id,
      extras: selected.has(repo.id) ? value.extras.filter((id) => id !== repo.id) : [...value.extras, repo.id],
    });
  };

  const makeMain = (repo: RepoView) => {
    if (!main) return;
    onChange({ main: repo.id, extras: [main.id, ...value.extras.filter((id) => id !== repo.id)] });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Repositories"
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md border border-transparent px-2.5 text-xs font-medium text-ink transition-colors hover:bg-paper-2 focus-visible:border-signal/70 focus-visible:ring-3 focus-visible:ring-signal/15 focus-visible:outline-none data-[state=open]:border-signal/70"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">
              {main ? `${main.name}${main.host ? ` · ${main.host}` : ""}` : "Repository"}
            </span>
            {extras.length > 0 && (
              <span
                className="num shrink-0 rounded-full bg-ink px-1.5 text-[10px] leading-4 text-paper"
                title={`Also: ${extras.map((r) => r.name).join(", ")}`}
              >
                +{extras.length}
              </span>
            )}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <ul className="scroll-quiet max-h-72 overflow-auto p-1" role="listbox" aria-multiselectable aria-label="Repositories">
          {repos.map((repo) => {
            const on = selected.has(repo.id);
            const isMain = repo.id === main?.id;
            const elsewhere = main && machine(repo) !== machine(main);
            return (
              <li key={repo.id} className="group/row relative">
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(repo)}
                  title={
                    elsewhere
                      ? `${repo.name} is ${where(repo)}: picking it switches to it (a task's repos share one machine)`
                      : isMain && extras.length === 0
                        ? "A task needs at least one repo"
                        : repo.path
                  }
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-md py-1.5 pr-2 pl-2 text-left transition-colors hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                      on ? "border-ink bg-ink text-paper" : "border-rule-strong bg-surface",
                    )}
                    aria-hidden
                  >
                    {on && <CheckIcon className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {repo.name}
                    {repo.host && <span className="text-muted-foreground"> · {repo.host}</span>}
                    {repo.availability.state === "unreachable" && (
                      <span className="text-warning-ink"> (unreachable)</span>
                    )}
                  </span>
                  {isMain && extras.length > 0 && (
                    <span className="label-mono shrink-0 text-[10px] text-muted-foreground">main</span>
                  )}
                </button>
                {on && !isMain && (
                  <button
                    type="button"
                    onClick={() => makeMain(repo)}
                    className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-signal-ink opacity-0 transition-opacity group-hover/row:opacity-100 hover:underline focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
                  >
                    Make main
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="border-t border-rule px-3 py-2 text-[11px] leading-snug text-muted-foreground">
          Tick several to work across repos. The task runs in the <span className="font-medium text-ink-2">main</span>{" "}
          repo. The others are opened as they are: the app doesn&apos;t create, switch or commit anything there. Their ticked
          prompts say how to handle changes.
        </p>
      </PopoverContent>
    </Popover>
  );
}
