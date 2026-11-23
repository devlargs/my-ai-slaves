import type { GitRefAction, RepoGraph } from "@my-ai-slaves/shared";
import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { type MenuTarget, targetName, targetKeys, type GraphView } from "./view-state";

/** A dialog's text field. */
interface Field {
  key: string;
  label: string;
  placeholder?: string;
  initial?: string;
  multiline?: boolean;
  optional?: boolean;
  /** Suggestions (a datalist), e.g. the remote branches for Set Upstream. */
  options?: string[];
}
/** A confirmation or a short form before a menu action runs. */
export interface ActionSpec {
  title: string;
  description?: React.ReactNode;
  fields?: Field[];
  confirmLabel: string;
  destructive?: boolean;
  run: (values: Record<string, string>) => Promise<void>;
}

export function ActionDialog({ spec, onClose }: { spec: ActionSpec | null; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValues(Object.fromEntries((spec?.fields ?? []).map((f) => [f.key, f.initial ?? ""])));
    setError(null);
    setBusy(false);
  }, [spec]);
  const ready = (spec?.fields ?? []).every((f) => f.optional || values[f.key]?.trim());
  const submit = async () => {
    if (!spec || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await spec.run(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open={spec !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogTitle>{spec?.title}</DialogTitle>
        {spec?.description && (
          <DialogDescription asChild>
            <div>{spec.description}</div>
          </DialogDescription>
        )}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {spec?.fields?.map((f, i) => (
            <label key={f.key} className="flex flex-col gap-1 text-xs text-ink-2">
              {f.label}
              {f.multiline ? (
                <textarea
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  rows={4}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="scroll-quiet resize-y rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-signal"
                />
              ) : (
                <Input
                  autoFocus={i === 0}
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  list={f.options ? `field-${f.key}` : undefined}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="font-mono"
                />
              )}
              {f.options && (
                <datalist id={`field-${f.key}`}>
                  {f.options.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              )}
            </label>
          ))}
          {error && <p className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs whitespace-pre-wrap text-danger-ink">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={spec?.destructive ? "destructive" : "signal"} disabled={!ready || busy}>
              {busy && <Loader2Icon className="animate-spin" />}
              {spec?.confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The right-click menu, GitKraken's items in GitKraken's order. */
export function RefMenu({
  menu,
  graph,
  view,
  onClose,
  onRun,
  onAsk,
  onRebase,
  onBranchHere,
  onView,
  onCompare,
}: {
  menu: { x: number; y: number; target: MenuTarget } | null;
  graph: RepoGraph;
  view: GraphView;
  onClose: () => void;
  /** Runs it; from a dialog (`fromDialog`), errors are thrown back to show there. */
  onRun: (action: GitRefAction, fromDialog?: boolean) => Promise<void>;
  onAsk: (spec: ActionSpec) => void;
  onRebase: (onto: string) => void;
  onBranchHere: (commit: string) => void;
  onView: (view: GraphView) => void;
  onCompare: (commit: string) => void;
}) {
  if (!menu) return null;
  const t = menu.target;
  const name = targetName(t);
  const currentBranch = graph.local.find((b) => b.current) ?? null;
  const here = currentBranch?.name ?? "HEAD";
  const headCommit = currentBranch?.commit ?? graph.commits.find((c) => c.refs.includes("HEAD"))?.hash ?? null;
  const isCurrent = !!t.local && t.local === currentBranch?.name;
  const local = t.local ? graph.local.find((b) => b.name === t.local) : undefined;
  const short = t.commit.slice(0, 7);
  const keys = targetKeys(t);
  const hidden = keys.length > 0 && keys.every((k) => view.hidden.includes(k));
  const soloed = keys.length > 0 && keys.every((k) => view.solo.includes(k));
  const pinned = view.pinned !== null && keys.includes(view.pinned);
  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  const remoteRefs = graph.remote.map((r) => r.ref);
  const defaultRemote = graph.remote.some((r) => r.remote === "origin") ? "origin" : (graph.remote[0]?.remote ?? "origin");

  const resetSpec = (mode: "soft" | "mixed" | "hard"): ActionSpec => ({
    title: `Reset ${here} to ${short} (${mode})`,
    description:
      mode === "hard" ? (
        <>Moves {here} to this commit and <b>throws away</b> every uncommitted change. Undo brings the commits back, not the changes.</>
      ) : mode === "mixed" ? (
        <>Moves {here} to this commit. The changes of the commits after it stay in your files, unstaged.</>
      ) : (
        <>Moves {here} to this commit. The changes of the commits after it stay staged.</>
      ),
    confirmLabel: `Reset ${mode}`,
    destructive: mode === "hard",
    run: async () => onRun({ op: "reset", commit: t.commit, mode }, true),
  });

  const sections: React.ReactNode[][] = [];
  if (t.local) {
    sections.push([
      <DropdownMenuItem key="pull" disabled={!isCurrent && !local?.upstream} onSelect={() => void onRun({ op: "pull", branch: t.local! })}>
        Pull (fast-forward if possible)
      </DropdownMenuItem>,
      <DropdownMenuItem key="push" onSelect={() => void onRun({ op: "push", branch: t.local! })}>
        Push
      </DropdownMenuItem>,
      <DropdownMenuItem
        key="upstream"
        onSelect={() =>
          onAsk({
            title: `Set upstream for ${t.local}`,
            description: "Pick a remote branch to track. A branch that isn't on the remote yet is pushed there.",
            fields: [
              { key: "upstream", label: "Upstream", initial: local?.upstream ?? `${defaultRemote}/${t.local}`, options: remoteRefs },
            ],
            confirmLabel: "Set Upstream",
            run: async (v) => onRun({ op: "set-upstream", branch: t.local!, upstream: v.upstream! }, true),
          })
        }
      >
        Set Upstream
      </DropdownMenuItem>,
    ]);
  }
  if (name && !isCurrent) {
    sections.push([
      <DropdownMenuItem key="merge" onSelect={() => void onRun({ op: "merge", ref: name })}>
        Merge {name} into {here}
      </DropdownMenuItem>,
      <DropdownMenuItem key="rebase" onSelect={() => void onRun({ op: "rebase", ref: name })}>
        Rebase {here} onto {name}
      </DropdownMenuItem>,
      <DropdownMenuItem key="irebase" onSelect={() => onRebase(name)}>
        Interactive Rebase {here} onto {name}
      </DropdownMenuItem>,
    ]);
    sections.push([
      <DropdownMenuItem key="checkout" onSelect={() => void onRun({ op: "checkout", ref: name })}>
        Checkout {name}
      </DropdownMenuItem>,
    ]);
  }
  sections.push([
    <DropdownMenuItem key="branch" onSelect={() => onBranchHere(t.commit)}>
      Create branch here
    </DropdownMenuItem>,
    <DropdownMenuItem key="pick" disabled={t.commit === headCommit} onSelect={() => void onRun({ op: "cherry-pick", commit: t.commit })}>
      Cherry pick commit
    </DropdownMenuItem>,
    <DropdownMenuSub key="reset">
      <DropdownMenuSubTrigger disabled={t.commit === headCommit}>Reset {here} to this commit</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem onSelect={() => onAsk(resetSpec("soft"))}>Soft - keep all changes</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAsk(resetSpec("mixed"))}>Mixed - keep working copy but reset index</DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={() => onAsk(resetSpec("hard"))}>
          Hard - discard all changes
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>,
    <DropdownMenuItem key="revert" onSelect={() => void onRun({ op: "revert", commit: t.commit })}>
      Revert commit
    </DropdownMenuItem>,
  ]);
  if (name) {
    const remoteOnly = !t.local;
    sections.push([
      ...(t.local
        ? [
            <DropdownMenuItem
              key="rename"
              onSelect={() =>
                onAsk({
                  title: `Rename ${t.local}`,
                  fields: [{ key: "name", label: "New name", initial: t.local! }],
                  confirmLabel: "Rename",
                  run: async (v) => onRun({ op: "rename-branch", branch: t.local!, name: v.name! }, true),
                })
              }
            >
              Rename {t.local}
            </DropdownMenuItem>,
          ]
        : []),
      <DropdownMenuItem
        key="delete"
        destructive
        disabled={isCurrent}
        onSelect={() =>
          onAsk({
            title: `Delete ${name}`,
            description: remoteOnly ? (
              <>Deletes the branch on the remote (<span className="font-mono">git push --delete</span>). Everyone loses it.</>
            ) : (
              <>Deletes the local branch, even when it has commits that aren't merged anywhere. Its remote copy stays.</>
            ),
            confirmLabel: "Delete",
            destructive: true,
            run: async () => onRun({ op: "delete-branch", ref: name, remote: remoteOnly }, true),
          })
        }
      >
        Delete {name}
      </DropdownMenuItem>,
    ]);
  }
  sections.push([
    ...(name
      ? [
          <DropdownMenuItem key="copyname" onSelect={() => copy(name)}>
            Copy branch name
          </DropdownMenuItem>,
        ]
      : []),
    <DropdownMenuItem key="copysha" onSelect={() => copy(t.commit)}>
      Copy commit sha
    </DropdownMenuItem>,
  ]);
  if (keys.length > 0) {
    const without = (list: string[]) => list.filter((k) => !keys.includes(k));
    sections.push([
      <DropdownMenuItem
        key="hide"
        onSelect={() => onView({ ...view, hidden: hidden ? without(view.hidden) : [...without(view.hidden), ...keys], solo: without(view.solo) })}
      >
        {hidden ? "Show" : "Hide"}
      </DropdownMenuItem>,
      <DropdownMenuItem key="pin" onSelect={() => onView({ ...view, pinned: pinned ? null : keys[0]! })}>
        {pinned ? "Unpin from Left" : "Pin to Left"}
      </DropdownMenuItem>,
      <DropdownMenuItem
        key="solo"
        onSelect={() => onView({ ...view, solo: soloed ? without(view.solo) : [...without(view.solo), ...keys], hidden: without(view.hidden) })}
      >
        {soloed ? "Unsolo" : "Solo"}
      </DropdownMenuItem>,
    ]);
  }
  sections.push([
    <DropdownMenuItem key="compare" onSelect={() => onCompare(t.commit)}>
      Compare commit against working directory
    </DropdownMenuItem>,
  ]);
  sections.push([
    <DropdownMenuItem
      key="tag"
      onSelect={() =>
        onAsk({
          title: `Create tag at ${short}`,
          fields: [{ key: "name", label: "Tag name", placeholder: "v1.0.0" }],
          confirmLabel: "Create Tag",
          run: async (v) => onRun({ op: "tag", name: v.name!, commit: t.commit }, true),
        })
      }
    >
      Create tag here
    </DropdownMenuItem>,
    <DropdownMenuItem
      key="atag"
      onSelect={() =>
        onAsk({
          title: `Create annotated tag at ${short}`,
          fields: [
            { key: "name", label: "Tag name", placeholder: "v1.0.0" },
            { key: "message", label: "Message", multiline: true },
          ],
          confirmLabel: "Create Tag",
          run: async (v) => onRun({ op: "tag", name: v.name!, commit: t.commit, message: v.message }, true),
        })
      }
    >
      Create annotated tag here
    </DropdownMenuItem>,
  ]);

  return (
    // Not modal: a menu item can open a dialog straight away without the page staying blocked.
    <DropdownMenu key={`${menu.x},${menu.y}`} open modal={false} onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu.x, top: menu.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="max-w-[min(640px,90vw)]">
        {sections.map((items, i) => (
          <div key={i}>
            {i > 0 && <DropdownMenuSeparator />}
            {items}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
