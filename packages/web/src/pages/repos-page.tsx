import type { RemoteHost, Repo, RepoView, Settings } from "@my-ai-slaves/shared";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  LaptopIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ConfirmButton } from "@/components/confirm-dialog";
import { FolderBrowserDialog } from "@/components/folder-browser";
import { PageHeader } from "@/components/page-header";
import { RepoPromptsEditor } from "@/components/repo-prompts";
import { SortableList } from "@/components/sortable-list";
import { AccountStatusBadge, ProviderLabel } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { api, attempt } from "@/lib/api";
import { setRepoNames, useApi } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import { cn, storageGet, storageRemove, storageSet } from "@/lib/utils";

// Expanded repos used to be remembered; drop the stale key.
storageRemove("slaves.expandedRepos");

export function ReposPage() {
  const { data: repos, setData, reload } = useApi<RepoView[]>(() => api.getRepos(), [], "repos");
  // Every repo starts collapsed each time the page opens.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const sorted = useMemo(
    () => [...(repos ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })),
    [repos],
  );

  const updateExpanded = (change: (set: Set<string>) => void) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      change(next);
      return next;
    });
  const toggle = (id: string) => updateExpanded((set) => (set.has(id) ? set.delete(id) : set.add(id)));

  // Reachability is re-checked on the server every minute; refresh what we show as well.
  // biome-ignore lint/correctness/useExhaustiveDependencies: interval
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return; // nothing to refresh while the window isn't shown
      void api.getRepos().then(setData).catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  // Tasks and History show these names too.
  useEffect(() => {
    if (repos) setRepoNames(repos);
  }, [repos]);

  // Filter by label (e.g. personal vs company); remembered across visits.
  const [filter, setFilter] = useState<string | null>(() => storageGet(FILTER_KEY));
  const pickFilter = (next: string | null) => {
    setFilter(next);
    storageSet(FILTER_KEY, next ?? "");
  };
  const allLabels = useMemo(() => collectLabels(repos ?? []), [repos]);
  const activeFilter =
    filter === NO_LABEL
      ? NO_LABEL
      : (allLabels.find((l) => l.label.toLowerCase() === filter?.toLowerCase())?.label ?? null);
  const unlabelled = sorted.filter((r) => r.labels.length === 0).length;
  const shown = sorted.filter((r) =>
    activeFilter === null
      ? true
      : activeFilter === NO_LABEL
        ? r.labels.length === 0
        : r.labels.some((l) => l.toLowerCase() === activeFilter.toLowerCase()),
  );

  const replace = (repo: Repo) => setData((list) => list?.map((r) => (r.id === repo.id ? { ...r, ...repo } : r)));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      <PageHeader
        title="Repositories"
        description={
          <>
            Tasks run in each repo exactly as it&apos;s checked out. The app never creates, switches or commits
            branches: the repo&apos;s prompts tell the agent how to handle changes.
          </>
        }
      />

      <RegisterRepoCard
        onRegistered={(repo) => {
          updateExpanded((set) => set.add(repo.id)); // open the one you just added
          void reload();
        }}
      />

      {repos?.length === 0 && <p className="text-[13px] text-muted-foreground">No repositories yet.</p>}
      {(allLabels.length > 0 || sorted.length > 1) && (
        <div className="-mb-2 flex flex-wrap items-center gap-1">
          {allLabels.length > 0 && (
            <div className="mr-auto flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Filter by label">
              <FilterChip active={activeFilter === null} onClick={() => pickFilter(null)} count={sorted.length}>
                All
              </FilterChip>
              {allLabels.map(({ label, count }) => (
                <FilterChip key={label} active={activeFilter === label} onClick={() => pickFilter(label)} count={count}>
                  <TagIcon className="size-3" />
                  {label}
                </FilterChip>
              ))}
              {unlabelled > 0 && (
                <FilterChip active={activeFilter === NO_LABEL} onClick={() => pickFilter(NO_LABEL)} count={unlabelled}>
                  No label
                </FilterChip>
              )}
            </div>
          )}
          {shown.length > 1 && (
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => updateExpanded((set) => shown.forEach((r) => set.add(r.id)))}>
                Expand all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => updateExpanded((set) => set.clear())}>
                Collapse all
              </Button>
            </span>
          )}
        </div>
      )}
      {shown.map((repo) => (
        <RepoCard
          key={repo.id}
          repo={repo}
          allLabels={allLabels.map((l) => l.label)}
          expanded={expanded.has(repo.id)}
          onToggle={() => toggle(repo.id)}
          onChange={replace}
          onDeleted={() => {
            updateExpanded((set) => set.delete(repo.id));
            void reload();
          }}
        />
      ))}
    </div>
  );
}

/** Register a repo on this Mac, or on an SSH host the way VS Code's Remote Explorer does. */
function RegisterRepoCard({ onRegistered }: { onRegistered: (repo: RepoView) => void }) {
  const [where, setWhere] = useState<"local" | "remote">("local");
  const [hosts, setHosts] = useState<RemoteHost[] | null>(null);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [path, setPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (where !== "remote" || hosts) return;
    void attempt(api.getRemoteHosts()).then((list) => {
      setHosts(list ?? []);
      if (list?.[0] && !host) setHost(list[0].host);
    });
  }, [where, hosts, host]);

  const current = hosts?.find((h) => h.host === host);
  const register = async (p: string) => {
    if (!p.trim() || (where === "remote" && !host)) return;
    setBusy(true);
    const repo = await attempt(
      api.registerRepo({ path: p.trim(), host: where === "remote" ? host : null }),
    );
    setBusy(false);
    if (repo) {
      setPath("");
      onRegistered(repo);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="repo-path">Register a repository</Label>
          <div className="flex rounded-full border border-rule bg-paper-2 p-0.5" role="radiogroup" aria-label="Where the repo is">
            {(
              [
                ["local", "This Mac", LaptopIcon],
                ["remote", "Remote (SSH)", ServerIcon],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={where === value}
                onClick={() => setWhere(value)}
                className={cn(
                  "flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors",
                  where === value ? "bg-surface text-ink shadow-[0_1px_2px_oklch(0%_0_0/0.08)]" : "text-muted-foreground hover:text-ink",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {where === "remote" && (
          <div className="flex flex-col gap-1.5">
            {hosts && hosts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No SSH hosts found. Add one to <code className="font-mono">~/.ssh/config</code> (the same list VS Code&apos;s
                Remote Explorer shows), then come back.
              </p>
            ) : (
              <Select
                aria-label="SSH host"
                value={host}
                onValueChange={setHost}
                placeholder={hosts ? "Choose a host" : "Loading SSH hosts…"}
                disabled={!hosts}
                options={(hosts ?? []).map((h) => ({
                  value: h.host,
                  label: h.hostname && h.hostname !== h.host ? `${h.host} (${h.hostname})` : h.host,
                }))}
              />
            )}
            {current && current.recentFolders.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-[11px] text-muted-foreground">Opened in VS Code:</span>
                {current.recentFolders.map((f) => (
                  <button
                    key={f}
                    type="button"
                    disabled={busy}
                    onClick={() => void register(f)}
                    title={`Register ${current.host}:${f}`}
                    className="flex h-6 cursor-pointer items-center gap-1 rounded-full border border-rule bg-surface px-2.5 font-mono text-[11px] text-ink-2 transition-colors hover:border-rule-strong hover:text-ink disabled:opacity-50"
                  >
                    <FolderGit2Icon className="size-3 text-muted-foreground" />
                    {f.split("/").pop()}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void register(path);
          }}
        >
          <Input
            id="repo-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={where === "remote" ? "/home/you/projects/my-repo" : "/Users/you/code/my-repo"}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            disabled={where === "remote" && !host}
            onClick={() => setBrowsing(true)}
          >
            <FolderOpenIcon /> Browse
          </Button>
          <Button type="submit" disabled={busy || !path.trim() || (where === "remote" && !host)}>
            {busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />} Register
          </Button>
        </form>
        {where === "remote" && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Tasks for a remote repo run on that server over SSH, with git and the Claude / Cursor CLI installed and
            logged in there. Add a matching account under Settings → Accounts (&ldquo;Runs on&rdquo; the host).
          </p>
        )}
      </CardContent>
      <FolderBrowserDialog
        open={browsing}
        onOpenChange={setBrowsing}
        host={where === "remote" ? (host ?? null) : null}
        onPick={(p) => void register(p)}
      />
    </Card>
  );
}

const FILTER_KEY = "slaves.repoLabelFilter";
/** Filter value for repos without any label (labels can't contain control characters, so no clash). */
const NO_LABEL = "\u0000none";
const SUGGESTED_LABELS = ["Personal", "Company"];

/** Every label in use (first spelling wins, case-insensitive), with how many repos have it. */
function collectLabels(repos: Repo[]): { label: string; count: number }[] {
  const byKey = new Map<string, { label: string; count: number }>();
  for (const repo of repos) {
    for (const label of repo.labels) {
      const entry = byKey.get(label.toLowerCase());
      if (entry) entry.count++;
      else byKey.set(label.toLowerCase(), { label, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }));
}

function FilterChip({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]",
        active ? "border-ink bg-ink text-paper" : "border-rule bg-surface text-ink-2 hover:border-rule-strong hover:text-ink",
      )}
    >
      {children}
      <span className={cn("num text-[10px]", active ? "text-paper/70" : "text-muted-foreground")}>{count}</span>
    </button>
  );
}

/** Add / remove a repo's labels. Saves on every change; suggests labels other repos already use. */
function LabelsEditor({
  repo,
  allLabels,
  onSave,
}: {
  repo: Repo;
  allLabels: string[];
  onSave: (labels: string[]) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const has = (label: string) => repo.labels.some((l) => l.toLowerCase() === label.toLowerCase());
  const suggestions = (allLabels.length ? allLabels : SUGGESTED_LABELS).filter((l) => !has(l));
  const add = async (raw: string) => {
    const label = raw.trim().replace(/\s+/g, " ");
    if (!label || has(label)) return setDraft("");
    // Reuse the spelling other repos already have, so "company" and "Company" stay one label.
    const existing = allLabels.find((l) => l.toLowerCase() === label.toLowerCase());
    if (await onSave([...repo.labels, existing ?? label])) setDraft("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`labels-${repo.id}`}>Labels</Label>
      {repo.labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {repo.labels.map((label) => (
            <Badge key={label} variant="default" className="gap-1 pr-1">
              <TagIcon className="size-3 text-muted-foreground" />
              {label}
              <button
                type="button"
                aria-label={`Remove label ${label}`}
                onClick={() => void onSave(repo.labels.filter((l) => l !== label))}
                className="flex size-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-paper hover:text-ink"
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add(draft);
        }}
      >
        <Input
          id={`labels-${repo.id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a label, e.g. Personal or Company"
          maxLength={40}
        />
        <Button type="submit" variant="outline" disabled={!draft.trim()}>
          <PlusIcon /> Add
        </Button>
      </form>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Quick add:</span>
          {suggestions.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => void add(label)}
              className="flex h-5 cursor-pointer items-center gap-1 rounded-full border border-dashed border-rule-strong px-2 text-[11px] text-ink-2 transition-colors hover:border-ink hover:text-ink"
            >
              <PlusIcon className="size-3" />
              {label}
            </button>
          ))}
        </div>
      )}
      <span className="text-[11px] text-muted-foreground">
        Only for keeping track here (filter the list above); never sent to the agent.
      </span>
    </div>
  );
}

function RepoCard({
  repo,
  allLabels,
  expanded,
  onToggle,
  onChange,
  onDeleted,
}: {
  repo: RepoView;
  allLabels: string[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (repo: Repo | RepoView) => void;
  onDeleted: () => void;
}) {
  const unreachable = repo.availability.state === "unreachable";
  const [checking, setChecking] = useState(false);
  const checkAgain = async () => {
    setChecking(true);
    const fresh = await attempt(api.checkRepo(repo.id));
    setChecking(false);
    if (fresh) onChange(fresh);
  };
  const [name, setName] = useState(repo.name);
  useEffect(() => setName(repo.name), [repo.name]);
  const folderName = repo.path.split(/[\\/]/).filter(Boolean).pop() ?? repo.id;
  const [branch, setBranch] = useState(repo.defaultBranch);
  useEffect(() => setBranch(repo.defaultBranch), [repo.defaultBranch]);

  const patch = async (body: Parameters<typeof api.updateRepo>[1]) => {
    const updated = await attempt(api.updateRepo(repo.id, body));
    if (updated) onChange(updated);
    return updated;
  };

  return (
    <Card className={cn(unreachable && "bg-paper-2/60")} aria-disabled={unreachable || undefined}>
      <CardHeader className={cn(!expanded && "border-b-0")}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`repo-body-${repo.id}`}
          className={cn(
            "-my-1 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left",
            unreachable && "opacity-55",
          )}
        >
          <ChevronRightIcon
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          />
          <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
          <CardTitle className="shrink-0">{repo.name}</CardTitle>
          {repo.labels.map((label) => (
            <Badge key={label} variant="default" className="shrink-0 gap-1">
              <TagIcon className="size-3 text-muted-foreground" />
              {label}
            </Badge>
          ))}
          {repo.host && (
            <Badge variant="outline" className="shrink-0 gap-1 font-mono" title={`On ${repo.host} (SSH)`}>
              <ServerIcon className="size-3" />
              {repo.host}
            </Badge>
          )}
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={repo.path}>
            {repo.path}
          </span>
          {!expanded && (
            <span className="ml-auto hidden shrink-0 items-center gap-1.5 sm:flex">
              <Badge variant="outline" className="font-mono">
                {repo.defaultBranch}
              </Badge>
              <span
                className={cn("text-[11px]", repo.accountChain.length ? "text-muted-foreground" : "text-danger-ink")}
                title={repo.accountChain.join(" → ")}
              >
                {repo.accountChain.length ? repo.accountChain.join(" → ") : "No accounts"}
              </span>
            </span>
          )}
        </button>
        {unreachable && (
          <>
            <Tooltip
              content={
                <>
                  <span className="font-medium">Unable to load the repo at this time.</span>
                  {repo.availability.message && <span className="mt-0.5 block text-paper/75">{repo.availability.message}</span>}
                  <span className="mt-0.5 block text-paper/75">Tasks for it wait and start once it&apos;s back.</span>
                </>
              }
            >
              <span
                tabIndex={0}
                role="img"
                aria-label="Unable to load the repo at this time"
                className="flex size-7 shrink-0 cursor-help items-center justify-center rounded-full text-warning-ink focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
              >
                <AlertTriangleIcon className="size-4" />
              </span>
            </Tooltip>
            <Button size="sm" variant="ghost" disabled={checking} onClick={() => void checkAgain()}>
              {checking ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Check again
            </Button>
          </>
        )}
        {repo.availability.state === "checking" && (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Checking the repo" />
        )}
        <ConfirmButton
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:bg-danger-soft hover:text-danger-ink"
          title={`Remove ${repo.name}?`}
          description="Unregisters the repository and deletes its prompts from .data/knowledge. Your repository on disk is not touched."
          confirmLabel="Remove"
          onConfirm={async () => {
            if (await attempt(api.deleteRepo(repo.id))) onDeleted();
          }}
        >
          <Trash2Icon /> Remove
        </ConfirmButton>
      </CardHeader>
      {/* Hidden, not unmounted: an unsaved repo prompt survives collapsing. */}
      <CardContent id={`repo-body-${repo.id}`} hidden={!expanded}>
        {unreachable && (
          <p className="mb-4 flex items-start gap-1.5 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning-ink">
            <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
            Unable to load the repo at this time. Its settings are locked until it&apos;s reachable again.
          </p>
        )}
        <fieldset disabled={unreachable} className={cn("grid min-w-0 gap-5 md:grid-cols-2", unreachable && "opacity-55")}>
        <div className="flex flex-col gap-4">
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() !== repo.name) void patch({ name: name.trim() });
            }}
          >
            <Label htmlFor={`name-${repo.id}`}>Name</Label>
            <div className="flex gap-2">
              <Input
                id={`name-${repo.id}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={folderName}
                maxLength={100}
              />
              <Button type="submit" variant="outline" disabled={name.trim() === repo.name}>
                Save
              </Button>
            </div>
            <span className="text-[11px] text-muted-foreground">
              Only how it shows in this app; the folder on disk keeps its name. Blank goes back to “{folderName}”.
            </span>
          </form>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`branch-${repo.id}`}>Base branch (a task&apos;s diff compares to it when the agent moves to another branch)</Label>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (branch.trim() && branch !== repo.defaultBranch) void patch({ defaultBranch: branch.trim() });
              }}
            >
              <Input
                id={`branch-${repo.id}`}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="font-mono text-xs"
              />
              <Button type="submit" variant="outline" disabled={!branch.trim() || branch === repo.defaultBranch}>
                Save
              </Button>
            </form>
          </div>
          <LabelsEditor repo={repo} allLabels={allLabels} onSave={(labels) => patch({ labels })} />
          <ChainEditor repo={repo} onSave={(chain) => patch({ accountChain: chain })} />
          <CommitterEditor repo={repo} onSave={patch} />
        </div>
        <RepoPromptsEditor repoId={repo.id} />
        </fieldset>
      </CardContent>
    </Card>
  );
}

const DEFAULT_COMMITTER = "__default__";

/** Author + committer for every commit on this repo's tasks: one of the committers saved in Settings. */
function CommitterEditor({
  repo,
  onSave,
}: {
  repo: Repo;
  onSave: (body: { committerId: string | null }) => Promise<unknown>;
}) {
  const { data: settings } = useApi<Settings>(() => api.getSettings(), [], "settings");
  const committers = settings?.committers ?? [];
  const fallback = committers.find((c) => c.id === settings?.defaultCommitterId);
  // A deleted committer falls back to the default, same as the server does.
  const picked = committers.some((c) => c.id === repo.committerId) ? (repo.committerId as string) : DEFAULT_COMMITTER;

  return (
    <div className="flex flex-col gap-1.5">
      <Label>Commit as</Label>
      <Select
        aria-label="Commit as"
        value={picked}
        disabled={!settings}
        onValueChange={(v) => void onSave({ committerId: v === DEFAULT_COMMITTER ? null : v })}
        options={[
          {
            value: DEFAULT_COMMITTER,
            label: fallback ? `Default: ${fallback.name} <${fallback.email}>` : "Default: your git config",
          },
          ...committers.map((c) => ({ value: c.id, label: `${c.name} <${c.email}>` })),
        ]}
      />
      <span className="text-[11px] text-muted-foreground">
        Author and committer of every commit on this repo&apos;s tasks. Add or change committers and the default in{" "}
        <a href="#/settings" className="text-signal-ink hover:underline">
          Settings
        </a>
        .
      </span>
    </div>
  );
}

function ChainEditor({ repo, onSave }: { repo: Repo; onSave: (chain: string[]) => Promise<unknown> }) {
  const accounts = useStore((s) => s.accounts);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const [chain, setChain] = useState(repo.accountChain);
  useEffect(() => setChain(repo.accountChain), [repo.accountChain]);
  // Only accounts on the repo's own machine can run its tasks.
  const available = accounts.filter((a) => !chain.includes(a.id) && (a.host ?? null) === (repo.host ?? null));

  const save = async (next: string[]) => {
    const previous = chain;
    setChain(next);
    if (!(await onSave(next))) setChain(previous);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label>Account chain (first available runs the task)</Label>
      {chain.length === 0 ? (
        <p className="rounded-lg border border-dashed border-rule-strong p-2.5 text-xs text-muted-foreground">
          No accounts yet. Tasks for this repo can&apos;t run until you add one.
        </p>
      ) : (
        <SortableList
          items={chain}
          getId={(id) => id}
          onReorder={(ids) => void save(ids)}
          renderItem={(id, handle) => {
            const account = byId.get(id);
            const position = chain.indexOf(id) + 1;
            return (
              <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-2.5 py-2 transition-colors hover:border-rule-strong">
                {handle}
                <span className="w-4 text-center font-mono text-[11px] text-muted-foreground">{position}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{id}</span>
                {account ? (
                  <>
                    <ProviderLabel provider={account.provider} />
                    <AccountStatusBadge account={account} />
                  </>
                ) : (
                  <Badge variant="destructive">missing</Badge>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Remove from chain"
                  onClick={() => void save(chain.filter((c) => c !== id))}
                >
                  <XIcon />
                </Button>
              </div>
            );
          }}
        />
      )}
      {available.length > 0 && (
        <Select
          aria-label="Add account to chain"
          value={undefined}
          placeholder="+ Add account to chain"
          onValueChange={(v) => void save([...chain, v])}
          options={available.map((a) => ({ value: a.id, label: a.label }))}
        />
      )}
      {repo.host ? (
        <RemoteAccountActions repo={repo} chain={chain} onAdded={(id) => void save([...chain, id])} />
      ) : (
        accounts.every((a) => a.host) && (
          <p className="text-xs text-muted-foreground">
            Add accounts on the{" "}
            <a href="#/settings" className="text-signal-ink hover:underline">
              Settings
            </a>{" "}
            page first.
          </p>
        )
      )}
    </div>
  );
}

/**
 * A remote repo can only use accounts that run on its host. Offer to create them right here:
 * they use the login that's already on the server, so there's nothing else to set up.
 */
function RemoteAccountActions({
  repo,
  chain,
  onAdded,
}: {
  repo: Repo;
  chain: string[];
  onAdded: (accountId: string) => void;
}) {
  const accounts = useStore((s) => s.accounts);
  const host = repo.host as string;
  const onHost = accounts.filter((a) => a.host === host);
  const missing = (["claude-code", "cursor-agent"] as const).filter((p) => !onHost.some((a) => a.provider === p));
  const [busy, setBusy] = useState<string | null>(null);

  const add = async (provider: "claude-code" | "cursor-agent") => {
    const base = `${host.split(".")[0]?.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "remote"}-${provider === "claude-code" ? "claude" : "cursor"}`;
    let label = base;
    for (let n = 2; accounts.some((a) => a.id === label); n++) label = `${base}-${n}`;
    setBusy(provider);
    const account = await attempt(api.createAccount({ label, provider, host }));
    setBusy(null);
    if (account) onAdded(account.id);
  };

  if (missing.length === 0 && onHost.every((a) => chain.includes(a.id))) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-rule-strong p-2.5">
      {onHost.length === 0 && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Tasks for this repo run on <code className="font-mono text-ink-2">{host}</code>, so they need an account that
          runs there. Your accounts on this Mac can&apos;t be used. It uses the Claude / Cursor login that&apos;s already
          on the server.
        </p>
      )}
      {missing.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {missing.map((provider) => (
            <Button key={provider} size="sm" variant="outline" disabled={busy !== null} onClick={() => void add(provider)}>
              {busy === provider ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
              {provider === "claude-code" ? "Claude Code" : "Cursor"} on {host}
            </Button>
          ))}
        </div>
      )}
      {missing.includes("cursor-agent") && (
        <p className="text-[11px] text-muted-foreground">
          Cursor on a server needs a recent <code className="font-mono">cursor-agent</code> (run{" "}
          <code className="font-mono">cursor-agent update</code> there).
        </p>
      )}
    </div>
  );
}
