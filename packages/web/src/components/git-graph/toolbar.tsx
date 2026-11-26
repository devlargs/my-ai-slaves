import type { GitHistory, LocalBranch, PullMode, StashEntry } from "@my-ai-slaves/shared";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  ChevronDownIcon,
  GitBranchPlusIcon,
  Loader2Icon,
  Redo2Icon,
  Undo2Icon,
} from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, storageGet } from "@/lib/utils";

export const PULL_KEY = "git-graph.pull-mode";
const PULL_LABELS: Record<PullMode, string> = {
  fetch: "Fetch All",
  "pull-ff": "Pull (fast-forward if possible)",
  "pull-ff-only": "Pull (fast-forward only)",
  "pull-rebase": "Pull (rebase)",
};
export const storedPullMode = (): PullMode => {
  const v = storageGet(PULL_KEY);
  return v && v in PULL_LABELS ? (v as PullMode) : "pull-ff";
};

export type GitAction = "undo" | "redo" | "pull" | "push" | "branch" | "stash" | "pop" | "ref";

function ToolButton({
  icon,
  label,
  title,
  busy,
  disabled,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-w-11 cursor-pointer flex-col items-center gap-0.5 rounded-md px-1.5 py-1 lg:min-w-14 lg:px-2 text-[11px] text-ink-2 hover:bg-paper-2 hover:text-ink",
        "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-2 [&_svg]:size-4",
        className,
      )}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : icon}
      {label}
    </button>
  );
}

/** Undo, Redo, Pull (with its default mode), Push, Branch, Stash and Pop, like GitKraken's toolbar. */
export function GitToolbar({
  history,
  current,
  hasChanges,
  topStash,
  acting,
  pullMode,
  onPullMode,
  onAction,
}: {
  history: GitHistory | null;
  /** The checked-out branch, what Push sends; null on a detached HEAD. */
  current: LocalBranch | null;
  /** The checkout has uncommitted changes (something to stash). */
  hasChanges: boolean;
  /** stash@{0}, what Pop brings back. */
  topStash: StashEntry | undefined;
  acting: GitAction | null;
  pullMode: PullMode;
  onPullMode: (mode: PullMode) => void;
  onAction: (action: GitAction) => void;
}) {
  const [menu, setMenu] = useState(false);
  const off = acting !== null || history === null;
  return (
    <div className="flex items-center gap-0.5">
      <ToolButton
        icon={<Undo2Icon />}
        label="Undo"
        title={history?.undo ? `Undo ${history.undo}` : "Nothing to undo"}
        busy={acting === "undo"}
        disabled={off || !history?.undo}
        onClick={() => onAction("undo")}
      />
      <ToolButton
        icon={<Redo2Icon />}
        label="Redo"
        title={history?.redo ? `Redo ${history.redo}` : "Nothing to redo"}
        busy={acting === "redo"}
        disabled={off || !history?.redo}
        onClick={() => onAction("redo")}
      />
      <div className="flex items-stretch">
        <ToolButton
          icon={<ArrowDownToLineIcon />}
          label={pullMode === "fetch" ? "Fetch" : "Pull"}
          title={PULL_LABELS[pullMode]}
          busy={acting === "pull"}
          disabled={off}
          onClick={() => onAction("pull")}
          className="rounded-r-none pr-1"
        />
        <Popover open={menu} onOpenChange={setMenu}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title="Choose what Pull does"
              disabled={off}
              className="flex cursor-pointer items-start rounded-r-md px-0.5 pt-1.5 text-ink-2 hover:bg-paper-2 hover:text-ink disabled:cursor-default disabled:opacity-40"
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-1.5">
            <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
              Select a default pull/fetch operation to execute when clicking this button
            </p>
            <div role="radiogroup" aria-label="Pull operation" className="flex flex-col">
              {(Object.keys(PULL_LABELS) as PullMode[]).map((mode) => {
                const on = mode === pullMode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      onPullMode(mode);
                      setMenu(false);
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink-2 hover:bg-paper-2 hover:text-ink",
                      on && "bg-signal-soft text-ink hover:bg-signal-soft",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                        on ? "border-signal" : "border-rule-strong",
                      )}
                    >
                      {on && <span className="size-1.5 rounded-full bg-signal" />}
                    </span>
                    {PULL_LABELS[mode]}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <ToolButton
        icon={<ArrowUpFromLineIcon />}
        label="Push"
        title={
          !current
            ? "No branch is checked out, nothing to push"
            : current.upstream
              ? `Push ${current.name} to ${current.upstream}`
              : `Push ${current.name} and set its upstream`
        }
        busy={acting === "push"}
        disabled={off || !current}
        onClick={() => onAction("push")}
      />
      <ToolButton
        icon={<GitBranchPlusIcon />}
        label="Branch"
        title="Create a branch here and check it out"
        busy={acting === "branch"}
        disabled={off}
        onClick={() => onAction("branch")}
      />
      <ToolButton
        icon={<ArchiveIcon />}
        label="Stash"
        title={hasChanges ? "Stash every uncommitted change (untracked files too)" : "No changes to stash"}
        busy={acting === "stash"}
        disabled={off || !hasChanges}
        onClick={() => onAction("stash")}
      />
      <ToolButton
        icon={<ArchiveRestoreIcon />}
        label="Pop"
        title={topStash ? `Pop ${topStash.message}` : "No stashes to pop"}
        busy={acting === "pop"}
        disabled={off || !topStash}
        onClick={() => onAction("pop")}
      />
    </div>
  );
}
