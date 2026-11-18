import type { Knowledge, Repo } from "@my-ai-slaves/shared";
import { ChevronRightIcon, FolderOpenIcon, FolderGit2Icon, PlusIcon, SaveIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmButton } from "@/components/confirm-dialog";
import { FolderBrowserDialog } from "@/components/folder-browser";
import { PageHeader } from "@/components/page-header";
import { FullscreenButton, FullscreenEditor } from "@/components/fullscreen-editor";
import { SortableList } from "@/components/sortable-list";
import { AccountStatusBadge, ProviderLabel } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, attempt } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import { cn, storageGet, storageSet } from "@/lib/utils";

export function ReposPage() {
  const { data: repos, setData, reload } = useApi<Repo[]>(() => api.getRepos(), []);
  const [path, setPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded());

  const sorted = useMemo(
    () => [...(repos ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })),
    [repos],
  );

  const updateExpanded = (change: (set: Set<string>) => void) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      change(next);
      storageSet(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  const toggle = (id: string) => updateExpanded((set) => (set.has(id) ? set.delete(id) : set.add(id)));

  const register = async (p: string) => {
    if (!p.trim()) return;
    setBusy(true);
    const repo = await attempt(api.registerRepo({ path: p.trim() }), "Repository registered");
    setBusy(false);
    if (repo) {
      setPath("");
      updateExpanded((set) => set.add(repo.id)); // open the one you just added
      void reload();
    }
  };

  const replace = (repo: Repo) => setData((list) => list?.map((r) => (r.id === repo.id ? repo : r)));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      <PageHeader
        title="Repositories"
        description={
          <>
            Each task checks out its own <code className="font-mono text-xs text-ink-2">ai/…</code> branch, created from the
            repo&apos;s base branch, right in your checkout. When it finishes, its work is committed there and your
            previous branch is checked out again.
          </>
        }
      />

      <Card>
        <CardContent className="flex flex-col gap-2">
          <Label htmlFor="repo-path">Register a repository (absolute path)</Label>
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
              placeholder="/Users/you/code/my-repo"
              className="font-mono text-xs"
            />
            <Button type="button" variant="outline" onClick={() => setBrowsing(true)}>
              <FolderOpenIcon /> Browse
            </Button>
            <Button type="submit" disabled={busy || !path.trim()}>
              <PlusIcon /> Register
            </Button>
          </form>
        </CardContent>
      </Card>

      <FolderBrowserDialog open={browsing} onOpenChange={setBrowsing} onPick={(p) => void register(p)} />

      {repos?.length === 0 && <p className="text-[13px] text-muted-foreground">No repositories yet.</p>}
      {sorted.length > 1 && (
        <div className="-mb-2 flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => updateExpanded((set) => sorted.forEach((r) => set.add(r.id)))}>
            Expand all
          </Button>
          <Button size="sm" variant="ghost" onClick={() => updateExpanded((set) => set.clear())}>
            Collapse all
          </Button>
        </div>
      )}
      {sorted.map((repo) => (
        <RepoCard
          key={repo.id}
          repo={repo}
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

const EXPANDED_KEY = "slaves.expandedRepos";

function loadExpanded(): Set<string> {
  try {
    const ids = JSON.parse(storageGet(EXPANDED_KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function RepoCard({
  repo,
  expanded,
  onToggle,
  onChange,
  onDeleted,
}: {
  repo: Repo;
  expanded: boolean;
  onToggle: () => void;
  onChange: (repo: Repo) => void;
  onDeleted: () => void;
}) {
  const [branch, setBranch] = useState(repo.defaultBranch);
  useEffect(() => setBranch(repo.defaultBranch), [repo.defaultBranch]);

  const patch = async (body: Parameters<typeof api.updateRepo>[1], success?: string) => {
    const updated = await attempt(api.updateRepo(repo.id, body), success);
    if (updated) onChange(updated);
    return updated;
  };

  return (
    <Card>
      <CardHeader className={cn(!expanded && "border-b-0")}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`repo-body-${repo.id}`}
          className="-my-1 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left"
        >
          <ChevronRightIcon
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          />
          <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
          <CardTitle className="shrink-0">{repo.name}</CardTitle>
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
        <ConfirmButton
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:bg-danger-soft hover:text-danger-ink"
          title={`Remove ${repo.name}?`}
          description="Unregisters the repository and deletes its base prompt from .data/knowledge. Your repository on disk is not touched."
          confirmLabel="Remove"
          onConfirm={async () => {
            if (await attempt(api.deleteRepo(repo.id), "Repository removed")) onDeleted();
          }}
        >
          <Trash2Icon /> Remove
        </ConfirmButton>
      </CardHeader>
      {/* Hidden, not unmounted: an unsaved base prompt survives collapsing. */}
      <CardContent id={`repo-body-${repo.id}`} hidden={!expanded} className="grid gap-5 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`branch-${repo.id}`}>Base branch (new task branches start here)</Label>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (branch.trim() && branch !== repo.defaultBranch) void patch({ defaultBranch: branch.trim() }, "Saved");
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
          <ChainEditor repo={repo} onSave={(chain) => patch({ accountChain: chain })} />
          <CommitterEditor repo={repo} onSave={(body) => patch(body, "Committer saved")} />
        </div>
        <BasePromptEditor repoId={repo.id} />
      </CardContent>
    </Card>
  );
}

/** Author + committer for every commit on this repo's tasks. Blank = your git config. */
function CommitterEditor({
  repo,
  onSave,
}: {
  repo: Repo;
  onSave: (body: { committerName: string; committerEmail: string }) => Promise<unknown>;
}) {
  const [name, setName] = useState(repo.committerName ?? "");
  const [email, setEmail] = useState(repo.committerEmail ?? "");
  useEffect(() => {
    setName(repo.committerName ?? "");
    setEmail(repo.committerEmail ?? "");
  }, [repo.committerName, repo.committerEmail]);
  const dirty = name.trim() !== (repo.committerName ?? "") || email.trim() !== (repo.committerEmail ?? "");

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) void onSave({ committerName: name.trim(), committerEmail: email.trim() });
      }}
    >
      <Label htmlFor={`committer-name-${repo.id}`}>Commit as</Label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input
          id={`committer-name-${repo.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          autoComplete="name"
        />
        <Input
          type="email"
          aria-label="Committer email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@example.com"
          autoComplete="email"
          className="font-mono text-xs"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          Author and committer of every commit on this repo&apos;s tasks. Blank uses your git config.
        </span>
        <Button type="submit" size="sm" variant="outline" disabled={!dirty}>
          Save
        </Button>
      </div>
    </form>
  );
}

function ChainEditor({ repo, onSave }: { repo: Repo; onSave: (chain: string[]) => Promise<unknown> }) {
  const accounts = useStore((s) => s.accounts);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const [chain, setChain] = useState(repo.accountChain);
  useEffect(() => setChain(repo.accountChain), [repo.accountChain]);
  const available = accounts.filter((a) => !chain.includes(a.id));

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
      {accounts.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Add accounts on the{" "}
          <a href="#/settings" className="text-signal-ink hover:underline">
            Settings
          </a>{" "}
          page first.
        </p>
      )}
    </div>
  );
}

function BasePromptEditor({ repoId }: { repoId: string }) {
  const { data, setData } = useApi<Knowledge>(() => api.getKnowledge(repoId), [repoId]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (data) setDraft(data.basePrompt);
  }, [data]);
  const dirty = data !== undefined && draft !== data.basePrompt;

  const save = async () => {
    setBusy(true);
    const saved = await attempt(api.putKnowledge(repoId, draft), "Base prompt saved");
    setBusy(false);
    if (saved) setData(saved);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={`kb-${repoId}`}>Repo base prompt</Label>
        {dirty && <Badge variant="warning">unsaved</Badge>}
        <span className="ml-auto">
          <FullscreenButton onClick={() => setFullscreen(true)} />
        </span>
      </div>
      <FullscreenEditor
        open={fullscreen}
        onOpenChange={setFullscreen}
        title={`Repo base prompt: ${repoId}`}
        note={`Stored in .data/knowledge/${repoId}.json`}
        value={draft}
        onChange={setDraft}
        placeholder="Blank. Anything you write here is sent before every task message for this repo."
        dirty={dirty}
        saving={busy}
        onSave={() => void save()}
      />
      <Textarea
        id={`kb-${repoId}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (dirty) void save();
          }
        }}
        disabled={data === undefined}
        placeholder="Blank. Anything you write here is sent before every task message for this repo."
        className="min-h-40 flex-1 font-mono text-xs"
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Stored in .data/knowledge/{repoId}.json</span>
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
          <SaveIcon /> Save
        </Button>
      </div>
    </div>
  );
}
