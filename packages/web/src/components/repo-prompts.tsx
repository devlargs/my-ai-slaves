import type { RepoPrompt } from "@my-ai-slaves/shared";
import { ChevronRightIcon, FolderGit2Icon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-dialog";
import { FullscreenButton, FullscreenEditor } from "@/components/fullscreen-editor";
import { SortableList } from "@/components/sortable-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, attempt } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/**
 * A repo's prompts. When you queue a task you tick which ones it sends; "default" ones come
 * pre-ticked. Sent as written, in this order, after the global base prompt.
 */
export function RepoPromptsEditor({ repoId }: { repoId: string }) {
  const { data: prompts, setData, reload } = useApi<RepoPrompt[]>(() => api.getRepoPrompts(repoId), [repoId], `repo-prompts:${repoId}`);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const replace = (saved: RepoPrompt) => setData((list) => list?.map((p) => (p.id === saved.id ? saved : p)));

  const reorder = async (ids: string[]) => {
    const previous = prompts ?? [];
    const byId = new Map(previous.map((p) => [p.id, p]));
    setData(ids.map((id) => byId.get(id)).filter((p): p is RepoPrompt => Boolean(p)));
    if ((await attempt(api.orderRepoPrompts(repoId, ids))) === undefined) setData(previous);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Label>Repo prompts</Label>
        {prompts && prompts.length > 0 && <span className="num text-[11px] text-muted-foreground">{prompts.length}</span>}
        {!adding && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAdding(true)}>
            <PlusIcon /> Add prompt
          </Button>
        )}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        Tick which ones to send when you queue a task. <span className="font-medium text-ink-2">Default</span> ones come
        pre-ticked. Sent in this order, after the global base prompt.
      </p>

      {adding && (
        <NewRepoPrompt
          repoId={repoId}
          first={prompts?.length === 0}
          onCancel={() => setAdding(false)}
          onCreated={(p) => {
            setAdding(false);
            void reload();
            setExpanded((prev) => new Set(prev).add(p.id));
          }}
        />
      )}

      {prompts?.length === 0 && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border border-dashed border-rule-strong p-4 text-left transition-colors hover:border-ink/30 hover:bg-paper-2/60"
        >
          <FolderGit2Icon className="size-4 text-muted-foreground" />
          <span className="text-[13px] text-muted-foreground">
            No prompts yet. Add one per kind of work, e.g. &ldquo;Frontend conventions&rdquo; or &ldquo;API rules&rdquo;.
          </span>
        </button>
      )}

      {prompts && prompts.length > 0 && (
        <SortableList
          items={prompts}
          getId={(p) => p.id}
          onReorder={(ids) => void reorder(ids)}
          className="gap-1.5"
          renderItem={(p, handle) => (
            <RepoPromptRow
              repoId={repoId}
              prompt={p}
              handle={handle}
              expanded={expanded.has(p.id)}
              onToggle={() => toggle(p.id)}
              onSaved={replace}
              onDeleted={() => void reload()}
            />
          )}
        />
      )}

      <span className="text-[11px] text-muted-foreground">Stored in .data/knowledge/{repoId}.json</span>
    </div>
  );
}

function NewRepoPrompt({
  repoId,
  first,
  onCancel,
  onCreated,
}: {
  repoId: string;
  first: boolean;
  onCancel: () => void;
  onCreated: (p: RepoPrompt) => void;
}) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  // The first prompt is usually the repo's general rules: send it unless you untick it.
  const [isDefault, setIsDefault] = useState(first);
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const canAdd = name.trim() !== "" && !busy;

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    const created = await attempt(
      api.createRepoPrompt(repoId, { name: name.trim(), body, default: isDefault }),
    );
    setBusy(false);
    if (created) onCreated(created);
  };

  return (
    <form
      className="flex flex-col gap-2.5 rounded-lg border border-rule-strong bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <Input
        aria-label="Prompt name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name, e.g. Frontend conventions"
        maxLength={120}
        autoFocus
      />
      <div className="relative">
        <Textarea
          aria-label="Prompt text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Exactly what should be sent when this prompt is ticked."
          className="min-h-28 font-mono text-xs"
        />
        <span className="absolute top-1.5 right-1.5">
          <FullscreenButton onClick={() => setFullscreen(true)} />
        </span>
      </div>
      <FullscreenEditor
        open={fullscreen}
        onOpenChange={setFullscreen}
        title={name.trim() ? `New repo prompt: ${name.trim()}` : "New repo prompt"}
        value={body}
        onChange={setBody}
        placeholder="Exactly what should be sent when this prompt is ticked."
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-2 select-none">
          <Switch checked={isDefault} onCheckedChange={setIsDefault} />
          Default (pre-ticked on new tasks)
        </label>
        <span className="ml-auto flex gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canAdd}>
            <PlusIcon /> Add
          </Button>
        </span>
      </div>
    </form>
  );
}

function RepoPromptRow({
  repoId,
  prompt,
  handle,
  expanded,
  onToggle,
  onSaved,
  onDeleted,
}: {
  repoId: string;
  prompt: RepoPrompt;
  handle: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  onSaved: (p: RepoPrompt) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(prompt.name);
  const [body, setBody] = useState(prompt.body);
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    setName(prompt.name);
    setBody(prompt.body);
  }, [prompt.name, prompt.body]);
  const dirty = name.trim() !== prompt.name || body !== prompt.body;

  const save = async () => {
    if (!dirty || !name.trim() || busy) return;
    setBusy(true);
    const saved = await attempt(api.updateRepoPrompt(repoId, prompt.id, { name: name.trim(), body }));
    setBusy(false);
    if (saved) onSaved(saved);
  };

  const setDefault = async (value: boolean) => {
    onSaved({ ...prompt, default: value });
    const saved = await attempt(api.updateRepoPrompt(repoId, prompt.id, { default: value }));
    onSaved(saved ?? prompt);
  };

  return (
    <div className="rounded-lg border border-rule bg-surface">
      <div className="flex min-w-0 items-center gap-1 py-1 pr-1.5 pl-1">
        {handle}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md py-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
        >
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", expanded && "rotate-90")}
          />
          <span className="shrink-0 text-[13px] font-medium text-ink">{prompt.name}</span>
          {dirty && <Badge variant="warning">unsaved</Badge>}
          {!expanded && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {prompt.body.trim().split("\n")[0] || "(empty)"}
            </span>
          )}
        </button>
        <label
          className="flex shrink-0 cursor-pointer items-center gap-1.5 px-1 text-[11px] text-muted-foreground select-none"
          title="Default prompts come pre-ticked when you queue a task on this repo"
        >
          <Switch checked={prompt.default} onCheckedChange={(v) => void setDefault(v)} aria-label={`${prompt.name}: default`} />
          Default
        </label>
        <ConfirmButton
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:bg-danger-soft hover:text-danger-ink"
          aria-label={`Delete ${prompt.name}`}
          title={`Delete “${prompt.name}”?`}
          description="It disappears from this repo's prompts. Tasks already queued with it won't send it; their history says so."
          confirmLabel="Delete prompt"
          onConfirm={async () => {
            if (await attempt(api.deleteRepoPrompt(repoId, prompt.id))) onDeleted();
          }}
        >
          <Trash2Icon />
        </ConfirmButton>
      </div>
      <div hidden={!expanded} className="flex flex-col gap-2.5 border-t border-rule p-3">
        <Input aria-label="Prompt name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        <div className="relative">
          <Textarea
            aria-label={`${prompt.name} text`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
            className="min-h-36 font-mono text-xs"
          />
          <span className="absolute top-1.5 right-1.5">
            <FullscreenButton onClick={() => setFullscreen(true)} />
          </span>
        </div>
        <FullscreenEditor
          open={fullscreen}
          onOpenChange={setFullscreen}
          title={`Repo prompt: ${prompt.name}`}
          note={`Stored in .data/knowledge/${repoId}.json as "${prompt.id}"`}
          value={body}
          onChange={setBody}
          dirty={dirty}
          saving={busy}
          onSave={() => void save()}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">id: {prompt.id}</span>
          <Button size="sm" disabled={!dirty || !name.trim() || busy} onClick={() => void save()}>
            <SaveIcon /> Save
          </Button>
        </div>
      </div>
    </div>
  );
}
