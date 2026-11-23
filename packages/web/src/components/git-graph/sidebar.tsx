import type { GitRefAction, LocalBranch, RemoteBranch, RepoGraph, StashEntry } from "@my-ai-slaves/shared";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  EyeOffIcon,
  FolderIcon,
  GitBranchIcon,
  InboxIcon,
  LaptopIcon,
  PinIcon,
  SearchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { type ActionSpec } from "./menu";
import { type TreeNode, buildTree, stashLabel, type MenuTarget, type GraphView } from "./view-state";

function SectionHeader({
  open,
  onToggle,
  icon,
  label,
  count,
}: {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-ink-2 label-mono hover:text-ink"
    >
      {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
      {icon}
      <span className="flex-1">{label}</span>
      <span className="num text-signal-ink">{count}</span>
    </button>
  );
}

function BranchRow({
  depth,
  name,
  commit,
  current,
  loaded,
  selected,
  extra,
  hidden,
  pinned,
  onPick,
  onMenu,
}: {
  depth: number;
  name: string;
  commit: string;
  current?: boolean;
  loaded: boolean;
  selected: boolean;
  extra?: React.ReactNode;
  /** Hidden from the graph (Hide, or another branch is soloed). */
  hidden?: boolean;
  pinned?: boolean;
  onPick: (hash: string) => void;
  onMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(commit)}
      onContextMenu={onMenu}
      title={loaded ? name : `${name}: older than the loaded commits (load older commits to see it)`}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-ink-2 hover:bg-paper-2 hover:text-ink",
        current && "bg-success-soft text-success-ink hover:bg-success-soft hover:text-success-ink",
        selected && !current && "bg-signal-soft text-signal-ink hover:bg-signal-soft",
        !loaded && "opacity-60",
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {current ? <CheckIcon className="size-3.5 shrink-0" /> : <GitBranchIcon className="size-3.5 shrink-0 opacity-70" />}
      <span className={cn("min-w-0 flex-1 truncate font-mono", hidden && "opacity-50")}>{name}</span>
      {pinned && <PinIcon className="size-3 shrink-0 opacity-70" aria-label="Pinned to left" />}
      {hidden && <EyeOffIcon className="size-3 shrink-0 opacity-70" aria-label="Hidden from the graph" />}
      {extra}
    </button>
  );
}

export function FolderRow({ depth, name, open, onToggle }: { depth: number; name: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-ink-2 hover:bg-paper-2 hover:text-ink"
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {open ? <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" /> : <ChevronRightIcon className="size-3.5 shrink-0 opacity-70" />}
      <FolderIcon className="size-3.5 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
    </button>
  );
}

function BranchTree<T extends { commit: string }>({
  nodes,
  depth,
  prefix,
  closed,
  toggle,
  render,
}: {
  nodes: TreeNode<T>[];
  depth: number;
  prefix: string;
  closed: Set<string>;
  toggle: (key: string) => void;
  render: (item: T, name: string, depth: number) => React.ReactNode;
}) {
  return nodes.map((node) => {
    if (node.item) return <div key={`i:${node.path}`}>{render(node.item, node.name, depth)}</div>;
    const key = `${prefix}${node.path}`;
    const open = !closed.has(key);
    return (
      <div key={`f:${node.path}`}>
        <FolderRow depth={depth} name={node.name} open={open} onToggle={() => toggle(key)} />
        {open && <BranchTree nodes={node.children} depth={depth + 1} prefix={prefix} closed={closed} toggle={toggle} render={render} />}
      </div>
    );
  });
}

export function BranchSidebar({
  graph,
  loaded,
  selected,
  view,
  onPick,
  onMenu,
  onPickStash,
  onStashMenu,
  onShowAll,
  onShowStashes,
}: {
  graph: RepoGraph;
  loaded: Set<string>;
  selected: string | null;
  view: GraphView;
  onPick: (hash: string) => void;
  onMenu: (e: React.MouseEvent, target: MenuTarget) => void;
  onPickStash: (stash: StashEntry) => void;
  onStashMenu: (e: React.MouseEvent, stash: StashEntry) => void;
  onShowAll: () => void;
  onShowStashes: () => void;
}) {
  const isHidden = (key: string) => (view.solo.length > 0 ? !view.solo.includes(key) : view.hidden.includes(key));
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const q = filter.trim().toLowerCase();
  const local = useMemo(() => graph.local.filter((b) => !q || b.name.toLowerCase().includes(q)), [graph.local, q]);
  const remote = useMemo(() => graph.remote.filter((b) => !q || b.ref.toLowerCase().includes(q)), [graph.remote, q]);
  const localTree = useMemo(() => buildTree(local, (b) => b.name), [local]);
  const remotes = useMemo(() => {
    const by = new Map<string, RemoteBranch[]>();
    for (const b of remote) by.set(b.remote, [...(by.get(b.remote) ?? []), b]);
    return [...by].map(([name, list]) => ({ name, tree: buildTree(list, (b) => b.name) }));
  }, [remote]);
  const hiddenStashes = useMemo(() => graph.stashes.filter((s) => view.hiddenStashes.includes(s.hash)).length, [graph.stashes, view.hiddenStashes]);
  const stashes = useMemo(
    () => graph.stashes.filter((s) => !view.hiddenStashes.includes(s.hash) && (!q || s.message.toLowerCase().includes(q))),
    [graph.stashes, view.hiddenStashes, q],
  );
  const localOpen = !closed.has("section:local");
  const remoteOpen = !closed.has("section:remote");
  const stashesOpen = !closed.has("section:stashes");

  const renderLocal = (b: LocalBranch, name: string, depth: number) => (
    <BranchRow
      depth={depth}
      name={name}
      commit={b.commit}
      current={b.current}
      loaded={loaded.has(b.commit)}
      selected={selected === b.commit}
      hidden={isHidden(b.name)}
      pinned={view.pinned === b.name}
      onPick={onPick}
      onMenu={(e) => onMenu(e, { commit: b.commit, local: b.name, remotes: [] })}
      extra={
        (b.ahead > 0 || b.behind > 0 || b.gone) && (
          <span
            className="num shrink-0 text-[11px] font-medium"
            title={b.gone ? `${b.upstream} is gone from the remote` : `${b.ahead} ahead, ${b.behind} behind ${b.upstream}`}
          >
            {b.gone ? "gone" : [b.ahead > 0 && `${b.ahead}↑`, b.behind > 0 && `${b.behind}↓`].filter(Boolean).join(" ")}
          </span>
        )
      }
    />
  );
  const renderRemote = (b: RemoteBranch, name: string, depth: number) => (
    <BranchRow
      depth={depth}
      name={name}
      commit={b.commit}
      loaded={loaded.has(b.commit)}
      selected={selected === b.commit}
      hidden={isHidden(b.ref)}
      pinned={view.pinned === b.ref}
      onPick={onPick}
      onMenu={(e) => onMenu(e, { commit: b.commit, local: null, remotes: [b.ref] })}
    />
  );

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-hidden rounded-lg border border-rule bg-surface">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-rule p-2">
        <span className="flex items-center text-xs text-ink-2">
          Viewing <span className="num ml-1 font-medium text-signal-ink">{local.length + remote.length}</span>
          {(view.hidden.length > 0 || view.solo.length > 0) && (
            <button type="button" onClick={onShowAll} className="ml-auto cursor-pointer text-signal-ink hover:underline">
              {view.solo.length > 0 ? "Unsolo all" : "Show all"}
            </button>
          )}
        </span>
        <div className="relative">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter branches and stashes"
            className="h-7 pr-7 text-xs"
          />
          <SearchIcon className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-1">
        <SectionHeader
          open={localOpen}
          onToggle={() => toggle("section:local")}
          icon={<LaptopIcon className="size-3.5" />}
          label="Local"
          count={local.length}
        />
        {localOpen &&
          (local.length === 0 ? (
            <p className="px-3 py-1 text-xs text-muted-foreground">{q ? "No match." : "No local branches."}</p>
          ) : (
            <BranchTree nodes={localTree} depth={1} prefix="local:" closed={closed} toggle={toggle} render={renderLocal} />
          ))}
        <div className="my-1 border-t border-rule" />
        <SectionHeader
          open={remoteOpen}
          onToggle={() => toggle("section:remote")}
          icon={<CloudIcon className="size-3.5" />}
          label="Remote"
          count={remote.length}
        />
        {remoteOpen &&
          (remotes.length === 0 ? (
            <p className="px-3 py-1 text-xs text-muted-foreground">{q ? "No match." : "No remotes."}</p>
          ) : (
            remotes.map((r) => {
              const key = `remote:${r.name}`;
              const open = !closed.has(key);
              return (
                <div key={r.name}>
                  <FolderRow depth={1} name={r.name} open={open} onToggle={() => toggle(key)} />
                  {open && <BranchTree nodes={r.tree} depth={2} prefix={`${key}/`} closed={closed} toggle={toggle} render={renderRemote} />}
                </div>
              );
            })
          ))}
        <div className="my-1 border-t border-rule" />
        <SectionHeader
          open={stashesOpen}
          onToggle={() => toggle("section:stashes")}
          icon={<InboxIcon className="size-3.5" />}
          label="Stashes"
          count={stashes.length}
        />
        {stashesOpen && hiddenStashes > 0 && (
          <p className="flex items-center gap-1.5 py-1 pr-2 text-xs text-muted-foreground" style={{ paddingLeft: 8 + 14 }}>
            <EyeOffIcon className="size-3 shrink-0 opacity-70" />
            <span className="num">{hiddenStashes} hidden</span>
            <button type="button" onClick={onShowStashes} className="ml-auto cursor-pointer text-signal-ink hover:underline">
              Show
            </button>
          </p>
        )}
        {stashesOpen &&
          (stashes.length === 0 ? (
            hiddenStashes > 0 && !q ? null : (
              <p className="px-3 py-1 text-xs text-muted-foreground">{q ? "No match." : "No stashes."}</p>
            )
          ) : (
            stashes.map((st) => (
              <button
                key={st.hash}
                type="button"
                onClick={() => onPickStash(st)}
                onContextMenu={(e) => onStashMenu(e, st)}
                title={`stash@{${st.index}}: ${st.message}`}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-ink-2 hover:bg-paper-2 hover:text-ink",
                  selected === st.hash && "bg-signal-soft text-signal-ink hover:bg-signal-soft",
                )}
                style={{ paddingLeft: 8 + 14 }}
              >
                <InboxIcon className="size-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{stashLabel(st)}</span>
              </button>
            ))
          ))}
      </div>
    </aside>
  );
}

/** Right-click on a stash: GitKraken's items (Share as Cloud Patch left out). */
export function StashMenu({
  menu,
  onClose,
  onRun,
  onAsk,
  onHide,
}: {
  menu: { x: number; y: number; stash: StashEntry } | null;
  onClose: () => void;
  onRun: (action: GitRefAction, fromDialog?: boolean) => Promise<void>;
  onAsk: (spec: ActionSpec) => void;
  /** Hide the stash from the sidebar (view only; nothing changes in the repo). */
  onHide: (stash: StashEntry) => void;
}) {
  if (!menu) return null;
  const st = menu.stash;
  const ref = { index: st.index, stash: st.hash };
  const name = `stash@{${st.index}}`;
  return (
    <DropdownMenu key={`${menu.x},${menu.y}`} open modal={false} onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu.x, top: menu.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="max-w-[min(640px,90vw)]">
        <DropdownMenuItem onSelect={() => void onRun({ op: "stash-apply", ...ref })}>Apply Stash</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void onRun({ op: "stash-apply", ...ref, pop: true })}>Pop Stash</DropdownMenuItem>
        <DropdownMenuItem
          destructive
          onSelect={() =>
            onAsk({
              title: `Delete ${name}`,
              description: (
                <>
                  Drops <span className="font-mono">{stashLabel(st)}</span>. Its changes are gone from the stash list.
                </>
              ),
              confirmLabel: "Delete Stash",
              destructive: true,
              run: async () => onRun({ op: "stash-drop", ...ref }, true),
            })
          }
        >
          Delete Stash
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            onAsk({
              title: `Edit message of ${name}`,
              description: "The stash moves to the top of the list.",
              fields: [{ key: "message", label: "Message", initial: stashLabel(st) }],
              confirmLabel: "Save",
              run: async (v) => onRun({ op: "stash-rename", ...ref, message: v.message! }, true),
            })
          }
        >
          Edit stash message
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(st.hash)}>Copy stash sha</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onHide(st)}>Hide</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
