import type { Knowledge, Repo } from "@my-ai-slaves/shared";
import { FolderOpenIcon, FolderGit2Icon, PlusIcon, SaveIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-dialog";
import { FolderBrowserDialog } from "@/components/folder-browser";
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

export function ReposPage() {
  const { data: repos, setData, reload } = useApi<Repo[]>(() => api.getRepos(), []);
  const [path, setPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);

  const register = async (p: string) => {
    if (!p.trim()) return;
    setBusy(true);
    const repo = await attempt(api.registerRepo({ path: p.trim() }), "Repository registered");
    setBusy(false);
    if (repo) {
      setPath("");
      void reload();
    }
  };

  const replace = (repo: Repo) => setData((list) => list?.map((r) => (r.id === repo.id ? repo : r)));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Repositories</h1>
        <p className="text-sm text-muted-foreground">
          Tasks run in a separate git worktree on an <code className="font-mono text-xs">ai/…</code> branch. Your main
          working tree is never touched.
        </p>
      </div>

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

      {repos?.length === 0 && <p className="text-sm text-muted-foreground">No repositories yet.</p>}
      {repos?.map((repo) => (
        <RepoCard key={repo.id} repo={repo} onChange={replace} onDeleted={() => void reload()} />
      ))}
    </div>
  );
}

function RepoCard({
  repo,
  onChange,
  onDeleted,
}: {
  repo: Repo;
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
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <FolderGit2Icon className="size-4 shrink-0 text-primary" />
          <CardTitle>{repo.name}</CardTitle>
          <span className="truncate font-mono text-[11px] text-muted-foreground" title={repo.path}>
            {repo.path}
          </span>
        </div>
        <ConfirmButton
          size="sm"
          variant="ghost"
          className="text-destructive"
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
      <CardContent className="grid gap-5 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`branch-${repo.id}`}>Base branch for new worktrees</Label>
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
        </div>
        <BasePromptEditor repoId={repo.id} />
      </CardContent>
    </Card>
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
        <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
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
              <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
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
          <a href="#/settings" className="text-primary hover:underline">
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
      </div>
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
