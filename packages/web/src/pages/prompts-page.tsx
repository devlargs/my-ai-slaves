import type { SavedPromptView } from "@my-ai-slaves/shared";
import { ChevronRightIcon, LibraryBigIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-dialog";
import { FullscreenButton, FullscreenEditor } from "@/components/fullscreen-editor";
import { PageHeader } from "@/components/page-header";
import { SortableList } from "@/components/sortable-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { api, attempt } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** The saved prompt library: reusable prompts you bind to a task message or reply. */
export function PromptsPage() {
  const { data: prompts, setData, reload } = useApi<SavedPromptView[]>(() => api.getPrompts(), []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const reorder = async (ids: string[]) => {
    const previous = prompts ?? [];
    const byId = new Map(previous.map((p) => [p.id, p]));
    setData(ids.map((id) => byId.get(id)).filter((p): p is SavedPromptView => Boolean(p)));
    if ((await attempt(api.orderPrompts(ids))) === undefined) setData(previous);
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      <PageHeader
        title="Prompts"
        description="Saved prompts you can bind to any task or reply with the Prompts button in the composer. They're sent as written, after the base prompts and before your message, in the order below."
      />

      <NewPromptCard
        onCreated={(p) => {
          setExpanded((prev) => new Set(prev).add(p.id));
          void reload();
        }}
      />

      {prompts?.length === 0 && (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-rule-strong p-5">
          <LibraryBigIcon className="size-5 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">
            No saved prompts yet. Add your first one above, for example &ldquo;Analyze a Jira ticket&rdquo; or &ldquo;Plan
            first and wait for my OK&rdquo;.
          </p>
        </div>
      )}

      {prompts && prompts.length > 0 && (
        <SortableList
          items={prompts}
          getId={(p) => p.id}
          onReorder={(ids) => void reorder(ids)}
          className="gap-3"
          renderItem={(p, handle) => (
            <PromptCard
              prompt={p}
              handle={handle}
              expanded={expanded.has(p.id)}
              onToggle={() => toggle(p.id)}
              onSaved={(saved) => setData((list) => list?.map((x) => (x.id === saved.id ? saved : x)))}
              onDeleted={() => void reload()}
            />
          )}
        />
      )}
    </div>
  );
}

function NewPromptCard({ onCreated }: { onCreated: (p: SavedPromptView) => void }) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const canAdd = name.trim() !== "" && !busy;

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    const created = await attempt(api.createPrompt({ name: name.trim(), body }), "Prompt saved");
    setBusy(false);
    if (created) {
      setName("");
      setBody("");
      onCreated(created);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>New prompt</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-prompt-name">Name</Label>
            <Input
              id="new-prompt-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Analyze Jira ticket"
              maxLength={120}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="new-prompt-body">Prompt</Label>
              <span className="ml-auto">
                <FullscreenButton onClick={() => setFullscreen(true)} />
              </span>
            </div>
            <Textarea
              id="new-prompt-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Exactly what should be sent when you bind this prompt."
              className="min-h-28 font-mono text-xs"
            />
          </div>
          <FullscreenEditor
            open={fullscreen}
            onOpenChange={setFullscreen}
            title={name.trim() ? `New prompt: ${name.trim()}` : "New prompt"}
            value={body}
            onChange={setBody}
            placeholder="Exactly what should be sent when you bind this prompt."
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={!canAdd}>
              <PlusIcon /> Add prompt
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PromptCard({
  prompt,
  handle,
  expanded,
  onToggle,
  onSaved,
  onDeleted,
}: {
  prompt: SavedPromptView;
  handle: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  onSaved: (p: SavedPromptView) => void;
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
    const saved = await attempt(api.updatePrompt(prompt.id, { name: name.trim(), body }), "Prompt saved");
    setBusy(false);
    if (saved) onSaved(saved);
  };

  return (
    <Card>
      <CardHeader className={cn(!expanded && "border-b-0")}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {handle}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="-my-1 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
          >
            <ChevronRightIcon
              className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150", expanded && "rotate-90")}
            />
            <CardTitle className="shrink-0">{prompt.name}</CardTitle>
            {dirty && <Badge variant="warning">unsaved</Badge>}
            {!expanded && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {prompt.body.trim().split("\n")[0] || "(empty)"}
              </span>
            )}
          </button>
        </div>
        <ConfirmButton
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:bg-danger-soft hover:text-danger-ink"
          aria-label={`Delete ${prompt.name}`}
          title={`Delete “${prompt.name}”?`}
          description="It disappears from the library. Tasks already queued with it won't send it; their history says so."
          confirmLabel="Delete prompt"
          onConfirm={async () => {
            if (await attempt(api.deletePrompt(prompt.id), "Prompt deleted")) onDeleted();
          }}
        >
          <Trash2Icon />
        </ConfirmButton>
      </CardHeader>
      <CardContent hidden={!expanded} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`prompt-name-${prompt.id}`}>Name</Label>
          <Input id={`prompt-name-${prompt.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor={`prompt-body-${prompt.id}`}>Prompt</Label>
            <span className="ml-auto">
              <FullscreenButton onClick={() => setFullscreen(true)} />
            </span>
          </div>
          <Textarea
            id={`prompt-body-${prompt.id}`}
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
        </div>
        <FullscreenEditor
          open={fullscreen}
          onOpenChange={setFullscreen}
          title={`Prompt: ${prompt.name}`}
          note={`Stored in .data/prompts.json as "${prompt.id}"`}
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
      </CardContent>
    </Card>
  );
}
