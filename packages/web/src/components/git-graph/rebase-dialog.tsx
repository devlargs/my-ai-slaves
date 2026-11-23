import type { RebaseAction, RebaseStep } from "@my-ai-slaves/shared";
import { ChevronDownIcon, ChevronUpIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const REBASE_ACTIONS: { value: RebaseAction; label: string; hint: string }[] = [
  { value: "pick", label: "Pick", hint: "keep the commit" },
  { value: "reword", label: "Reword", hint: "keep it, with a new message" },
  { value: "squash", label: "Squash", hint: "fold into the commit below, keeping both messages" },
  { value: "fixup", label: "Fixup", hint: "fold into the commit below, dropping this message" },
  { value: "drop", label: "Drop", hint: "remove the commit" },
];

/**
 * GitKraken's interactive rebase: the commits to replay, newest on top; pick / reword / squash /
 * fixup / drop each one and move them up or down. Nothing runs until "Start Rebase".
 */
export function RebaseDialog({
  repoId,
  onto,
  branch,
  onClose,
  onDone,
}: {
  repoId: string;
  onto: string | null;
  branch: string;
  onClose: () => void;
  onDone: () => void;
}) {
  /** Oldest first, the order git replays them in. */
  const [steps, setSteps] = useState<(RebaseStep & { subject: string; original: string })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSteps(null);
    setError(null);
    setBusy(false);
    if (!onto) return;
    let live = true;
    api.getRebasePlan(repoId, onto).then(
      (plan) => live && setSteps(plan.commits.map((c) => ({ hash: c.hash, action: "pick", subject: c.subject, original: c.subject }))),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [repoId, onto]);

  const update = (i: number, change: Partial<RebaseStep>) =>
    setSteps((list) => list && list.map((s, n) => (n === i ? { ...s, ...change } : s)));
  const move = (i: number, by: number) =>
    setSteps((list) => {
      if (!list || i + by < 0 || i + by >= list.length) return list;
      const next = [...list];
      [next[i], next[i + by]] = [next[i + by]!, next[i]!];
      return next;
    });
  const firstKept = steps?.find((s) => s.action !== "drop");
  const problem = !steps
    ? null
    : steps.length === 0
      ? "Nothing to rebase: the branch has no commits that aren't already there."
      : firstKept && (firstKept.action === "squash" || firstKept.action === "fixup")
        ? "The bottom commit can't be squashed: there's nothing below it to squash into."
        : steps.some((s) => s.action === "reword" && !s.subject.trim())
          ? "A reworded commit needs a message."
          : null;

  const start = async () => {
    if (!steps || !onto || problem) return;
    setBusy(true);
    setError(null);
    try {
      await api.gitRefAction(repoId, {
        op: "interactive-rebase",
        ref: onto,
        steps: steps.map((s) => (s.action === "reword" ? { hash: s.hash, action: s.action, message: s.subject } : { hash: s.hash, action: s.action })),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open={onto !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>
          Interactive rebase <span className="font-mono text-signal-ink">{branch}</span> onto{" "}
          <span className="font-mono text-signal-ink">{onto}</span>
        </DialogTitle>
        <DialogDescription>Newest on top. Squash and fixup fold a commit into the one below it.</DialogDescription>
        {!steps && !error && (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
          </div>
        )}
        {steps && steps.length > 0 && (
          <div className="scroll-quiet flex max-h-[55vh] flex-col overflow-y-auto rounded-md border border-rule">
            {[...steps].reverse().map((s, n) => {
              const i = steps.length - 1 - n;
              return (
                <div key={s.hash} className={cn("flex items-center gap-2 border-b border-rule px-2 py-1.5 last:border-b-0", s.action === "drop" && "opacity-50")}>
                  <div className="flex flex-col">
                    <button
                      type="button"
                      title="Move up (later)"
                      disabled={busy || i === steps.length - 1}
                      onClick={() => move(i, 1)}
                      className="cursor-pointer rounded px-0.5 text-muted-foreground hover:text-ink disabled:cursor-default disabled:opacity-30"
                    >
                      <ChevronUpIcon className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Move down (earlier)"
                      disabled={busy || i === 0}
                      onClick={() => move(i, -1)}
                      className="cursor-pointer rounded px-0.5 text-muted-foreground hover:text-ink disabled:cursor-default disabled:opacity-30"
                    >
                      <ChevronDownIcon className="size-3.5" />
                    </button>
                  </div>
                  <select
                    value={s.action}
                    disabled={busy}
                    title={REBASE_ACTIONS.find((a) => a.value === s.action)?.hint}
                    onChange={(e) => update(i, { action: e.target.value as RebaseAction })}
                    className="h-7 w-24 shrink-0 cursor-pointer rounded-md border border-rule bg-paper px-1.5 text-xs text-ink outline-none focus:border-signal"
                  >
                    {REBASE_ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground">{s.hash.slice(0, 7)}</span>
                  {s.action === "reword" ? (
                    <Input
                      value={s.subject}
                      disabled={busy}
                      onChange={(e) => setSteps((list) => list && list.map((x, k) => (k === i ? { ...x, subject: e.target.value } : x)))}
                      className="h-7 flex-1 text-xs"
                    />
                  ) : (
                    <span className={cn("min-w-0 flex-1 truncate text-xs text-ink", s.action === "drop" && "line-through")}>{s.original}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {(error ?? problem) && <p className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs whitespace-pre-wrap text-danger-ink">{error ?? problem}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="signal" disabled={!steps || !!problem || busy} onClick={() => void start()}>
            {busy && <Loader2Icon className="animate-spin" />} Start Rebase
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
