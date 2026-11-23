import type { PromptPreviewResponse, RepoView, TaskView } from "@my-ai-slaves/shared";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCheckIcon,
  CheckIcon,
  ClockIcon,
  CornerDownRightIcon,
  FileDiffIcon,
  FilePenLineIcon,
  HistoryIcon,
  InboxIcon,
  MinusIcon,
  MousePointerClickIcon,
  RotateCcwIcon,
  SaveIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityTimeline } from "@/components/activity-timeline";
import { ConfirmButton } from "@/components/confirm-dialog";
import {
  AttachButton,
  AttachmentList,
  AttachmentTray,
  DropZone,
  useAttachments,
} from "@/components/attachments";
import { DiffPanel } from "@/components/diff-panel";
import { LiveOutput } from "@/components/live-output";
import {
  BoundPromptChips,
  librarySection,
  PromptPicker,
  repoSection,
  useBoundPrompts,
  usePromptLibrary,
  useRepoPromptSets,
} from "@/components/prompt-picker";
import { PanelHeader } from "@/components/page-header";
import { RepoPicker, type RepoSelection } from "@/components/repo-picker";
import { ResizeHandle, useResizableWidth } from "@/components/resize-handle";
import { SortableList } from "@/components/sortable-list";
import { TaskStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, attempt } from "@/lib/api";
import { useApi, useDebounced, useRepoName, useTaskSubscription } from "@/lib/hooks";
import { getState, setTasks, useStore } from "@/lib/store";
import { cn, formatTime, storageGet, storageRemove, storageSet } from "@/lib/utils";

const CHAIN = "__chain__";
const REPO_KEY = "slaves.lastRepo";
const EXTRA_REPOS_KEY = "slaves.lastExtraRepos";
/** Unsent text of a message box, kept so it survives switching pages (and restarts). */
const draftKey = (box: string) => `slaves.draft.${box}`;
const COMPOSER_DRAFT = "composer";
const replyDraft = (taskId: string) => `reply.${taskId}`;

const promptCount = (task: TaskView) =>
  task.promptIds.length + (task.repoPromptIds?.length ?? 0) + task.extraRepos.reduce((n, x) => n + x.promptIds.length, 0);

function storedExtras(): string[] {
  try {
    const list: unknown = JSON.parse(storageGet(EXTRA_REPOS_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function QueuePage() {
  const tasks = useStore((s) => s.tasks);
  const tasksLoaded = useStore((s) => s.tasksLoaded);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const previousTasks = useRef<TaskView[]>(tasks);
  // The draft loaded into the composer (queueing or saving it replaces it).
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const editingDraft = tasks.find((t) => t.id === editingDraftId && t.status === "draft") ?? null;

  // When the open task leaves the queue (marked finished, discarded, deleted), open the task that was next in
  // line (or the one before it if it was last). With nothing left, fall back to the empty placeholder.
  useEffect(() => {
    const before = previousTasks.current;
    previousTasks.current = tasks;
    if (!selectedId || tasks.some((t) => t.id === selectedId)) return;
    const index = before.findIndex((t) => t.id === selectedId);
    if (index === -1) return;
    // Drafts open in the composer, not here.
    const remaining = new Set(tasks.filter((t) => t.status !== "draft").map((t) => t.id));
    const next =
      before.slice(index + 1).find((t) => remaining.has(t.id)) ??
      before
        .slice(0, index)
        .reverse()
        .find((t) => remaining.has(t.id));
    setSelectedId(next?.id ?? null);
  }, [tasks, selectedId]);

  // Auto-select the running task if nothing is selected.
  useEffect(() => {
    if (selectedId) return;
    const running = tasks.find((t) => t.status === "running");
    if (running) setSelectedId(running.id);
  }, [tasks, selectedId]);

  const listWidth = useResizableWidth({ key: "slaves.queueWidth", initial: 420, min: 300, max: 900, reserve: 640 });

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex shrink-0 flex-col border-r border-rule" style={{ width: listWidth.width }}>
        <ResizeHandle {...listWidth} label="Resize the queue panel" />
        <PanelHeader>
          <h2 className="title-display text-[15px]">Queue</h2>
          <span className="num rounded-full bg-paper-2 px-1.5 text-[11px] font-medium text-muted-foreground">
            {tasks.length}
          </span>
        </PanelHeader>
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto px-3 py-3">
          {!tasksLoaded ? (
            <p className="px-1 text-[13px] text-muted-foreground">Connecting…</p>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-start gap-2 px-1 pt-2">
              <InboxIcon className="size-5 text-muted-foreground" />
              <p className="text-[13px] text-ink-2">Nothing queued.</p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Write a task below. It runs on the first free account in the repo&apos;s chain.
              </p>
            </div>
          ) : (
            <QueueList
              tasks={tasks}
              selectedId={selectedId}
              editingDraftId={editingDraft?.id ?? null}
              onSelect={setSelectedId}
              onOpenDraft={setEditingDraftId}
            />
          )}
        </div>
        <Composer editingDraft={editingDraft} onEditingDraftChange={setEditingDraftId} />
      </div>
      <div className="min-w-0 flex-1">
        {selected ? (
          <TaskDetail key={selected.id} task={selected} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <MousePointerClickIcon className="size-5 text-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">Select a task to see its live output, diff and history.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Queue list ──────────────────────────────────────────────────────────────

function QueueList({
  tasks,
  selectedId,
  editingDraftId,
  onSelect,
  onOpenDraft,
}: {
  tasks: TaskView[];
  selectedId: string | null;
  editingDraftId: string | null;
  onSelect: (id: string) => void;
  /** A draft opens in the composer instead of the detail pane. */
  onOpenDraft: (id: string) => void;
}) {
  const repoName = useRepoName();
  const pendingIds = useMemo(() => new Set(tasks.filter((t) => t.status === "pending").map((t) => t.id)), [tasks]);

  const reorder = async (ids: string[]) => {
    const byId = new Map(getState().tasks.map((t) => [t.id, t]));
    const previous = getState().tasks;
    setTasks(ids.map((id) => byId.get(id)).filter((t): t is TaskView => Boolean(t)));
    const ok = await attempt(api.orderTasks(ids));
    if (ok === undefined) setTasks(previous);
  };

  return (
    <SortableList
      items={tasks}
      getId={(t) => t.id}
      sortableIds={pendingIds}
      onReorder={reorder}
      renderItem={(task, handle) => {
        const draft = task.status === "draft";
        const open = () => (draft ? onOpenDraft(task.id) : onSelect(task.id));
        const current = draft ? editingDraftId === task.id : selectedId === task.id;
        return (
        <div
          role="button"
          tabIndex={0}
          onClick={open}
          onKeyDown={(e) => {
            if (e.key === "Enter") open();
          }}
          title={draft ? "Draft: never runs. Click to load it into the composer." : undefined}
          aria-current={current ? "true" : undefined}
          className={cn(
            "group flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2.5 transition-[border-color,box-shadow] duration-150",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)",
            draft ? "border-dashed bg-paper" : "bg-surface",
            current
              ? "border-signal/55 ring-3 ring-signal/10"
              : draft
                ? "border-rule-strong hover:border-ink-2/40"
                : "border-rule hover:border-rule-strong",
          )}
        >
          <div className="pt-0.5">{handle}</div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={task.message}>
                {task.title || task.message}
              </span>
              <TaskStatusBadge status={task.status} className="shrink-0" />
            </div>
            <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <span className="truncate" title={[task.repo, ...task.extraRepos.map((x) => x.repo)].map(repoName).join(" + ")}>
                {repoName(task.repo)}
                {task.extraRepos.length > 0 && ` +${task.extraRepos.length}`}
              </span>
              {task.currentAccount && (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate">{task.currentAccount}</span>
                </>
              )}
              {promptCount(task) > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span className="shrink-0" title={[...(task.repoPromptIds ?? []), ...task.promptIds].join(", ")}>
                    {promptCount(task)} prompt
                    {promptCount(task) === 1 ? "" : "s"}
                  </span>
                </>
              )}
              {task.attachments.length > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">
                    {task.attachments.length} file{task.attachments.length === 1 ? "" : "s"}
                  </span>
                </>
              )}
              <span className="num ml-auto shrink-0">{formatTime(task.createdAt)}</span>
            </div>
            {task.waitingNote && (
              <div className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-warning-ink">
                <ClockIcon className="mt-px size-3 shrink-0" /> {task.waitingNote}
              </div>
            )}
            {task.pendingReply && (
              <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground" title={task.pendingReply}>
                <CornerDownRightIcon className="size-3 shrink-0" />
                <span className="truncate">Reply queued: {task.pendingReply}</span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            {task.status === "running" && (
              <Button
                size="icon-sm"
                variant="ghost"
                title="Stop (what it changed so far stays in the repo; you can retry or discard)"
                aria-label="Stop"
                onClick={(e) => {
                  e.stopPropagation();
                  void attempt(api.cancelTask(task.id));
                }}
              >
                <span aria-hidden className="block size-2.5 rounded-xs bg-white" />
              </Button>
            )}
            {task.status === "pending" && task.pendingReply !== null && (
              <Button
                size="icon-sm"
                variant="ghost"
                title="Cancel the queued reply (keeps the earlier work)"
                aria-label="Cancel queued reply"
                onClick={(e) => {
                  e.stopPropagation();
                  void attempt(api.cancelTask(task.id));
                }}
              >
                <XIcon />
              </Button>
            )}
            {task.status === "interrupted" && (
              <Button
                size="icon-sm"
                variant="ghost"
                title="Run it again in a new session (the repo is left as it is)"
                aria-label="Retry"
                onClick={(e) => {
                  e.stopPropagation();
                  void attempt(api.retryTask(task.id));
                }}
              >
                <RotateCcwIcon />
              </Button>
            )}
            {(task.status === "needs-review" || task.status === "interrupted") && (
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground hover:bg-success-soft hover:text-success-ink"
                title="Mark as finished: off the queue, into History as done. Nothing in the repo is touched."
                aria-label={`Mark ${task.title} as finished`}
                onClick={(e) => {
                  e.stopPropagation();
                  void attempt(api.finishTask(task.id));
                }}
              >
                <CheckCheckIcon />
              </Button>
            )}
            <DiscardTaskButton task={task} />
          </div>
        </div>
        );
      }}
    />
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

function Composer({
  editingDraft,
  onEditingDraftChange,
}: {
  editingDraft: TaskView | null;
  onEditingDraftChange: (id: string | null) => void;
}) {
  const { data: repos } = useApi<RepoView[]>(() => api.getRepos(), [], "repos");
  const accounts = useStore((s) => s.accounts);
  const [repo, setRepo] = useState<string | undefined>(() => storageGet(REPO_KEY) ?? undefined);
  // Cross-repo work: other repos (same machine) opened alongside the main one.
  const [extras, setExtras] = useState<string[]>(storedExtras);
  // Set by the picker's Clear button: no repo ticked until one is picked again (no fallback to the first).
  const [cleared, setCleared] = useState(false);
  const selectRepos = ({ main, extras: next }: RepoSelection) => {
    setRepo(main);
    setExtras(next);
    setCleared(!main);
    if (main) storageSet(REPO_KEY, main);
    storageSet(EXTRA_REPOS_KEY, JSON.stringify(next));
  };
  const [account, setAccount] = useState<string>(CHAIN);
  const input = useRef<HTMLTextAreaElement>(null);
  const [hasText, setHasText] = useState(() => Boolean(storageGet(draftKey(COMPOSER_DRAFT))?.trim()));
  const [previewText, setPreviewText] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const files = useAttachments();
  const library = usePromptLibrary();
  const bound = useBoundPrompts();
  // Each ticked repo's prompts (main first); a repo's defaults come pre-ticked when it's added.
  const taskRepos = repo ? [repo, ...extras] : [];
  const repoSets = useRepoPromptSets(taskRepos);
  const sections = [...taskRepos.map((r) => repoSection(r, repoSets.source(r), repoSets.bound(r))), librarySection(library, bound)];
  const extraRepoPromptIds = Object.fromEntries(
    extras.flatMap((r) => {
      const ids = repoSets.tickedFor(r);
      return ids ? [[r, ids]] : [];
    }),
  );

  // Fall back to the first repo when the remembered one is gone; drop other repos that can't go with it.
  useEffect(() => {
    if (!repos || cleared) return;
    const main = repos.find((r) => r.id === repo) ?? repos[0];
    if (main?.id !== repo) setRepo(main?.id);
    const valid = extras.filter((id) => {
      const r = repos.find((x) => x.id === id);
      return r && r.id !== main?.id && (r.host ?? null) === (main?.host ?? null);
    });
    if (valid.length !== extras.length) setExtras(valid);
  }, [repos, repo, extras, cleared]);

  const currentRepo = repos?.find((r) => r.id === repo);
  const downRepo = repos?.find((r) => (r.id === repo || extras.includes(r.id)) && r.availability.state === "unreachable");
  const chainEmpty = currentRepo && currentRepo.accountChain.length === 0 && account === CHAIN;
  // A pasted image (or any attached file) on its own is a valid task.
  const hasContent = hasText || files.files.length > 0;
  const canSend = Boolean(repo && hasContent) && !busy && !files.uploading && !files.failed;

  const setMessage = (text: string) => {
    if (input.current) input.current.value = text;
    if (text) storageSet(draftKey(COMPOSER_DRAFT), text);
    else storageRemove(draftKey(COMPOSER_DRAFT));
    setHasText(text.trim().length > 0);
    setPreviewText(text);
  };

  // A draft clicked in the queue: put its message, repos, account, prompts and files back in the composer.
  const loadedDraft = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per draft opened
  useEffect(() => {
    if (!editingDraft || loadedDraft.current === editingDraft.id) {
      if (!editingDraft) loadedDraft.current = null;
      return;
    }
    loadedDraft.current = editingDraft.id;
    const t = editingDraft;
    selectRepos({ main: t.repo, extras: t.extraRepos.map((x) => x.repo) });
    setAccount(t.accountOverride && accounts.some((a) => a.id === t.accountOverride) ? t.accountOverride : CHAIN);
    setMessage(t.message);
    files.reset(t.attachments);
    bound.setIds(t.promptIds);
    repoSets.preset({
      ...(t.repoPromptIds ? { [t.repo]: t.repoPromptIds } : {}),
      ...Object.fromEntries(t.extraRepos.map((x) => [x.repo, x.promptIds])),
    });
    input.current?.focus();
  }, [editingDraft?.id]);

  const submit = async (asDraft = false) => {
    const message = input.current?.value ?? "";
    if (!repo || !canSend || (!message.trim() && files.ids.length === 0)) return;
    setBusy(true);
    const task = await attempt(
      api.createTask({
        repo,
        message,
        accountOverride: account === CHAIN ? null : account,
        attachmentIds: files.ids,
        promptIds: bound.ids,
        repoPromptIds: repoSets.tickedFor(repo),
        extraRepos: extras,
        extraRepoPromptIds,
        draft: asDraft,
        replacesDraft: editingDraft?.id,
      }),
    );
    setBusy(false);
    if (task) {
      onEditingDraftChange(null);
      setMessage("");
      files.clear();
      bound.setIds([]);
      repoSets.resetToDefaults();
    }
  };

  if (repos && repos.length === 0) {
    return (
      <div className="m-3 rounded-lg border border-dashed border-rule-strong p-4 text-[13px] text-muted-foreground">
        Register a repository first on the{" "}
        <a href="#/repos" className="font-medium text-signal-ink underline-offset-4 hover:underline">
          Repos
        </a>{" "}
        page.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-rule bg-paper p-3">
      <DropZone attachments={files}>
        <div className="rounded-lg border border-rule-strong bg-surface transition-[border-color,box-shadow] duration-150 focus-within:border-signal/60 focus-within:ring-3 focus-within:ring-signal/10">
          <div className="flex gap-1.5 border-b border-rule px-2 py-1.5">
            <RepoPicker repos={repos ?? []} value={{ main: repo, extras }} onChange={selectRepos} />
            <Select
              aria-label="Account"
              value={account}
              onValueChange={setAccount}
              className="h-7 w-auto min-w-0 flex-1 border-transparent bg-transparent text-xs hover:bg-paper-2"
              options={[
                { value: CHAIN, label: "Repo's account chain" },
                ...accounts.map((a) => ({ value: a.id, label: `${a.label} · ${a.status}` })),
              ]}
            />
          </div>
          {editingDraft && (
            <div className="flex items-center gap-1.5 border-b border-rule px-2.5 py-1 text-[11px] text-muted-foreground">
              <FilePenLineIcon className="size-3 shrink-0" />
              <span className="min-w-0 truncate">
                Editing draft <span className="text-ink-2">{editingDraft.title}</span>
              </span>
              <button
                type="button"
                className="ml-auto shrink-0 cursor-pointer rounded-sm p-0.5 hover:bg-paper-2 hover:text-ink"
                title="Stop editing the draft (keeps it in the queue and the text here)"
                aria-label="Stop editing the draft"
                onClick={() => onEditingDraftChange(null)}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          )}
          {bound.ids.length + repoSets.count > 0 && (
            <div className="px-2.5 pt-2">
              <BoundPromptChips sections={sections} />
            </div>
          )}
          <MessageInput
            inputRef={input}
            draft={COMPOSER_DRAFT}
            aria-label="Task message"
            onHasText={setHasText}
            onText={preview ? setPreviewText : undefined}
            onPaste={files.onPaste}
            onSubmit={() => void submit()}
            placeholder="Describe the task. Paste or drop screenshots and files."
            className="max-h-72 min-h-24"
          />
          {files.files.length > 0 && (
            <div className="px-2.5 pb-2">
              <AttachmentTray attachments={files} />
            </div>
          )}
          <div className="flex items-center gap-1 border-t border-rule px-1.5 py-1.5">
            <AttachButton attachments={files} />
            <PromptPicker
              sections={sections}
              footer="Sent in order: global base prompt, the ticked repo prompts, the ticked saved prompts, then your message."
            />
            <label className="ml-1 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none">
              <Switch
                checked={preview}
                onCheckedChange={(on) => {
                  setPreview(on);
                  if (on) setPreviewText(input.current?.value ?? "");
                }}
              />
              Preview prompt
            </label>
            <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">
              <kbd className="font-mono">⇧↵</kbd> to queue
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-1.5"
              disabled={!canSend}
              title={editingDraft ? "Save the changes to this draft" : "Keep it in the queue as a draft: it never runs until you open it and queue it"}
              onClick={() => void submit(true)}
            >
              <SaveIcon /> {editingDraft ? "Save draft" : "Mark as draft"}
            </Button>
            <Button size="sm" variant="signal" disabled={!canSend} onClick={() => void submit()}>
              <SendIcon /> {files.uploading ? "Uploading…" : "Queue"}
            </Button>
          </div>
        </div>
      </DropZone>
      {downRepo && (
        <div className="flex items-start gap-1.5 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning-ink">
          <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
          <span>
            Unable to load {downRepo.name} at this time
            {downRepo.availability.message ? ` (${downRepo.availability.message})` : ""}. You can still queue: the task
            waits and starts once the repo is reachable.
          </span>
        </div>
      )}
      {chainEmpty && (
        <div className="flex items-start gap-1.5 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning-ink">
          <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
          <span>
            This repo has no account chain.{" "}
            <a href="#/repos" className="font-medium underline underline-offset-2">
              Set one on Repos
            </a>{" "}
            or pick an account.
          </span>
        </div>
      )}
      {preview && repo && (
        <PromptPreview
          repo={repo}
          message={previewText}
          attachmentIds={files.ids}
          promptIds={bound.ids}
          repoPromptIds={repoSets.tickedFor(repo)}
          extraRepos={extras}
          extraRepoPromptIds={extraRepoPromptIds}
        />
      )}
    </div>
  );
}

function PromptPreview({
  repo,
  message,
  attachmentIds,
  promptIds,
  repoPromptIds,
  extraRepos,
  extraRepoPromptIds,
}: {
  repo: string;
  message: string;
  attachmentIds: string[];
  promptIds: string[];
  repoPromptIds: string[] | undefined;
  extraRepos: string[];
  extraRepoPromptIds: Record<string, string[]>;
}) {
  const debounced = useDebounced(message, 300);
  const [result, setResult] = useState<PromptPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!debounced.trim() && attachmentIds.length === 0) {
      setResult(null);
      setError(null);
      return;
    }
    api
      .previewPrompt({ repo, message: debounced, attachmentIds, promptIds, repoPromptIds, extraRepos, extraRepoPromptIds })
      .then((r) => {
        if (!cancelled) {
          setResult(r);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [repo, debounced, attachmentIds.join(","), promptIds.join(","), repoPromptIds?.join(","), extraRepos.join(","), JSON.stringify(extraRepoPromptIds)]);

  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-surface">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-2.5 py-1.5">
        <span className="label-mono">Exactly what will be sent</span>
        <span className="ml-auto flex flex-wrap gap-1">
          {result?.layers
            .filter((l) => !["attachments", "prompts", "repo", "repos"].includes(l.name) || l.included)
            .map((l) => (
              <Badge
                key={l.name}
                variant={l.included ? "default" : "outline"}
                className={cn(!l.included && "line-through decoration-muted-foreground/60")}
                title={l.included ? "Included" : "Blank, skipped"}
              >
                {l.included && <CheckIcon className="size-3" />}
                {l.name}
              </Badge>
            ))}
        </span>
      </div>
      <pre className="scroll-quiet max-h-56 overflow-auto bg-paper-2/50 px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
        {error ? <span className="text-danger-ink">{error}</span> : result ? result.prompt : "Type a message to preview."}
      </pre>
    </div>
  );
}

// ── Task detail ─────────────────────────────────────────────────────────────

function TaskDetail({ task }: { task: TaskView }) {
  const repoName = useRepoName();
  useTaskSubscription(task.id);
  const reviewable = Boolean(task.checkout || task.branch) && (task.status === "needs-review" || task.status === "interrupted");
  const [tab, setTab] = useState(task.status === "needs-review" ? "diff" : "live");

  useEffect(() => {
    if (task.status === "needs-review") setTab("diff");
    if (task.status === "running") setTab("live");
  }, [task.status]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-rule px-6 pt-4 pb-0">
        <div className="flex items-start gap-3">
          <h2 className="title-display min-w-0 flex-1 truncate text-lg leading-snug" title={task.title}>
            {task.title}
          </h2>
          <TaskStatusBadge status={task.status} className="mt-1 shrink-0" />
          {(task.status === "pending" || task.status === "running") && <DiscardTaskButton task={task} withLabel />}
        </div>
        <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <Meta label="repo" value={repoName(task.repo)} />
          {task.extraRepos.length > 0 && <Meta label="also" value={task.extraRepos.map((x) => repoName(x.repo)).join(", ")} />}
          {task.currentAccount && <Meta label="account" value={task.currentAccount} />}
          {task.accountOverride && <Meta label="override" value={task.accountOverride} />}
          {task.checkout && <Meta label="started on" value={`${task.checkout.ref}@${task.checkout.commit.slice(0, 7)}`} />}
          {!task.checkout && task.branch && <Meta label="old branch" value={task.branch.name} />}
          <Meta label="id" value={task.id} />
        </dl>
        {task.waitingNote && (
          <div className="mt-2 flex items-start gap-1.5 text-xs text-warning-ink">
            <ClockIcon className="mt-px size-3.5 shrink-0" /> {task.waitingNote}
          </div>
        )}
        <PromptReceived taskId={task.id} version={task.updatedAt} />
        <Tabs value={tab} onValueChange={setTab} className="mt-3">
          <TabsList className="border-b-0">
            <TabsTrigger value="live">
              <ActivityIcon /> Live
            </TabsTrigger>
            <TabsTrigger value="diff" disabled={!reviewable}>
              <FileDiffIcon /> Diff
            </TabsTrigger>
            <TabsTrigger value="history">
              <HistoryIcon /> History
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <TabsList className="hidden">
          <TabsTrigger value="live">
            <ActivityIcon /> Live
          </TabsTrigger>
          <TabsTrigger value="diff" disabled={!reviewable}>
            <FileDiffIcon /> Diff
          </TabsTrigger>
          <TabsTrigger value="history">
            <HistoryIcon /> History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="live" className="flex min-h-0 flex-col">
          <LiveOutput taskId={task.id} />
        </TabsContent>
        <TabsContent value="diff" className="flex min-h-0 flex-col">
          {reviewable && <DiffPanel task={task} onDone={() => setTab("history")} />}
        </TabsContent>
        <TabsContent value="history" className="scroll-quiet min-h-0 overflow-auto">
          <TaskHistory taskId={task.id} version={task.updatedAt} />
        </TabsContent>
      </Tabs>
      <details className="group mx-6 mb-3 rounded-lg border border-rule bg-surface text-xs open:pb-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
          <span className="label-mono">Task message</span>
          {task.attachments.length > 0 && (
            <span className="text-[11px]">
              · {task.attachments.length} file{task.attachments.length === 1 ? "" : "s"}
            </span>
          )}
          <span className="ml-auto text-[11px] group-open:hidden">Show</span>
          <span className="ml-auto hidden text-[11px] group-open:inline">Hide</span>
        </summary>
        <pre className="scroll-quiet mx-3 max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {task.message}
        </pre>
        <AttachmentList files={task.attachments} className="mx-3 mt-2" />
      </details>
      {(task.status === "needs-review" || (task.status === "interrupted" && task.session)) && <ReplyBox taskId={task.id} />}
    </div>
  );
}

export function TaskHistory({ taskId, version }: { taskId: string; version?: string }) {
  const { data, loading } = useApi(() => api.taskHistory(taskId), [taskId, version], `task-history:${taskId}`);
  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return <ActivityTimeline entries={data ?? []} />;
}

function ReplyBox({ taskId }: { taskId: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [hasText, setHasText] = useState(() => Boolean(storageGet(draftKey(replyDraft(taskId)))?.trim()));
  const [busy, setBusy] = useState(false);
  const files = useAttachments();
  const library = usePromptLibrary();
  const bound = useBoundPrompts();
  const canSend = (hasText || files.files.length > 0) && !busy && !files.uploading && !files.failed;
  const send = async () => {
    const message = input.current?.value ?? "";
    if (!canSend || (!message.trim() && files.ids.length === 0)) return;
    setBusy(true);
    const ok = await attempt(api.replyTask(taskId, message, files.ids, bound.ids));
    setBusy(false);
    if (ok !== undefined) {
      if (input.current) input.current.value = "";
      storageRemove(draftKey(replyDraft(taskId)));
      setHasText(false);
      files.clear();
      bound.setIds([]);
    }
  };
  return (
    <div className="border-t border-rule bg-paper px-6 py-3">
      <DropZone attachments={files}>
        <div className="rounded-lg border border-rule-strong bg-surface transition-[border-color,box-shadow] duration-150 focus-within:border-signal/60 focus-within:ring-3 focus-within:ring-signal/10">
          {bound.ids.length > 0 && (
            <div className="px-2.5 pt-2">
              <BoundPromptChips sections={[librarySection(library, bound)]} />
            </div>
          )}
          <MessageInput
            inputRef={input}
            draft={replyDraft(taskId)}
            aria-label="Reply"
            onHasText={setHasText}
            onPaste={files.onPaste}
            onSubmit={() => void send()}
            placeholder="Reply to continue this session, e.g. answer its plan or ask for changes."
            className="max-h-56 min-h-16"
          />
          {files.files.length > 0 && (
            <div className="px-2.5 pb-2">
              <AttachmentTray attachments={files} />
            </div>
          )}
          <div className="flex items-center gap-1 border-t border-rule px-1.5 py-1.5">
            <AttachButton attachments={files} />
            <PromptPicker
              sections={[librarySection(library, bound)]}
              footer="Sent before your reply. The session already has the base and repo prompts from its first run."
            />
            <span className="min-w-0 truncate text-[11px] text-muted-foreground" title="The session already has the base and repo prompts from its first run.">
              Continues the same session. Base and repo prompts aren&apos;t re-sent.
            </span>
            <Button size="sm" variant="signal" className="ml-auto" disabled={!canSend} onClick={() => void send()}>
              <SendIcon /> {files.uploading ? "Uploading…" : "Reply"}
            </Button>
          </div>
        </div>
      </DropZone>
    </div>
  );
}

/**
 * The message box. Uncontrolled on purpose: a keystroke re-renders nothing (the composer around it,
 * with its pickers and prompt lists, re-renders only when the box goes empty ↔ non-empty), so typing
 * stays instant even while a task streams. Read the text from `inputRef` when sending.
 * The text is saved as a draft under `draft` on every change and restored on mount, so it survives
 * leaving the page; the sender removes the draft once the message is sent.
 */
function MessageInput({
  inputRef,
  draft,
  onHasText,
  onText,
  onSubmit,
  onPaste,
  className,
  ...props
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onHasText: (hasText: boolean) => void;
  /** Called with the full text on every change (only pass it when something shows the text live). */
  onText?: (text: string) => void;
  onSubmit: () => void;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  className?: string;
  "aria-label": string;
  placeholder: string;
}) {
  const [initial] = useState(() => storageGet(draftKey(draft)) ?? "");
  return (
    <textarea
      ref={inputRef}
      {...props}
      defaultValue={initial}
      onInput={(e) => {
        const text = e.currentTarget.value;
        if (text) storageSet(draftKey(draft), text);
        else storageRemove(draftKey(draft));
        onHasText(text.trim().length > 0);
        onText?.(text);
      }}
      onPaste={onPaste}
      onKeyDown={(e) => {
        // Shift+Enter sends (⌘/Ctrl+Enter too); plain Enter adds a new line. Skip while an IME is composing.
        if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        }
      }}
      className={cn(
        "block w-full resize-y bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-muted-foreground/80 focus:outline-none",
        className,
      )}
    />
  );
}

/** Remove a task in any state, after confirming what is lost. Running tasks are stopped first. */
export function DiscardTaskButton({ task, withLabel = false }: { task: TaskView; withLabel?: boolean }) {
  const what = "removes it from the queue. Nothing in the repo is touched: its changes stay where the agent left them";
  return (
    // Stops clicks and keys (also from the dialog, which React bubbles through) from selecting the card.
    <span
      className="contents"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <ConfirmButton
        size={withLabel ? "sm" : "icon-sm"}
        variant="ghost"
        className="text-muted-foreground hover:bg-danger-soft hover:text-danger-ink"
        aria-label={`Discard ${task.title}`}
        title={`Discard “${task.title}”?`}
        description={
          task.status === "draft" ? (
            <p>Deletes the draft. It never ran, so nothing is kept in History.</p>
          ) : (
            <p>
              {task.status === "running" ? "Stops the run, then " : "This "}
              {what}. The task&apos;s record stays in History.
            </p>
          )
        }
        confirmLabel={task.status === "running" ? "Stop and discard" : "Discard"}
        onConfirm={() => attempt(api.discardTask(task.id))}
      >
        <Trash2Icon />
        {withLabel && "Discard"}
      </ConfirmButton>
    </span>
  );
}

/**
 * What the CLI actually received: read from the run's "started" activity entry, which records the
 * exact text piped to the CLI. Shows the run that carried the base prompts (the session's first run).
 */
function PromptReceived({ taskId, version }: { taskId: string; version: string }) {
  const { data } = useApi(() => api.taskHistory(taskId), [taskId, version], `task-history:${taskId}`);
  const [open, setOpen] = useState(false);
  const starts = (data ?? []).filter((e) => e.event === "started");
  const fresh = [...starts].reverse().find((e) => e.data?.kind !== "reply");
  if (!data) return null;
  if (!fresh) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Not run yet. Turn on &ldquo;Preview prompt&rdquo; in the composer to see exactly what it will receive.
      </p>
    );
  }
  const layers = (fresh.data?.layers as { name: string; included: boolean }[] | undefined) ?? [];
  const has = (name: string) => layers.find((l) => l.name === name)?.included ?? false;
  const prompt = String(fresh.data?.prompt ?? "");
  const replies = starts.filter((e) => e.data?.kind === "reply").length;
  const layer = (name: string, label: string) => (
    <span className={cn("inline-flex items-center gap-1", has(name) ? "text-success-ink" : "text-muted-foreground")}>
      {has(name) ? <CheckIcon className="size-3" /> : <MinusIcon className="size-3" />}
      {label}
      {!has(name) && name !== "attachments" && <span className="text-muted-foreground"> (blank)</span>}
    </span>
  );
  return (
    <div className="mt-2.5 rounded-md border border-rule bg-surface text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5">
        <span className="text-ink-2">
          {fresh.account ?? "The CLI"} received{replies > 0 ? " (first run)" : ""}:
        </span>
        {layer("global", "global base prompt")}
        {fresh.data?.repoPrompts === undefined ? (
          layer("repo", "repo base prompt")
        ) : has("repo") ? (
          <span className="inline-flex items-center gap-1 text-success-ink">
            <CheckIcon className="size-3" />
            repo:{" "}
            {(fresh.data.repoPrompts as { repo?: string; name: string }[])
              .map((p) => (p.repo && p.repo !== fresh.repo ? `${p.repo}: ${p.name}` : p.name))
              .join(", ")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <MinusIcon className="size-3" />
            repo prompts (none ticked)
          </span>
        )}
        {has("prompts") && (
          <span className="inline-flex items-center gap-1 text-success-ink">
            <CheckIcon className="size-3" />
            saved: {((fresh.data?.boundPrompts as { name: string }[] | undefined) ?? []).map((p) => p.name).join(", ")}
          </span>
        )}
        {layer("message", "your message")}
        {has("repos") && layer("repos", "other repos' paths")}
        {has("attachments") && layer("attachments", "attached files")}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto cursor-pointer text-muted-foreground underline-offset-2 hover:text-ink hover:underline"
        >
          {open ? "Hide" : "View exact text"}
        </button>
      </div>
      {open && (
        <pre className="scroll-quiet max-h-64 overflow-auto border-t border-rule bg-paper-2/50 px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {prompt}
        </pre>
      )}
      {replies > 0 && (
        <p className="border-t border-rule px-2.5 py-1.5 text-muted-foreground">
          {replies} repl{replies === 1 ? "y" : "ies"} since then continued the same session, which already has these.
        </p>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-1">
      <dt className="text-muted-foreground/70">{label}</dt>
      <dd className="truncate text-ink-2">{value}</dd>
    </div>
  );
}

