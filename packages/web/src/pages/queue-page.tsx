import type { PromptPreviewResponse, Repo, TaskView } from "@my-ai-slaves/shared";
import {
  AlertTriangleIcon,
  ActivityIcon,
  FileDiffIcon,
  HistoryIcon,
  ListOrderedIcon,
  RotateCcwIcon,
  SendIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ActivityTimeline } from "@/components/activity-timeline";
import { DiffPanel } from "@/components/diff-panel";
import { LiveOutput } from "@/components/live-output";
import { SortableList } from "@/components/sortable-list";
import { TaskStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, attempt } from "@/lib/api";
import { useApi, useDebounced, useTaskSubscription } from "@/lib/hooks";
import { getState, setTasks, useStore } from "@/lib/store";
import { cn, formatTime, storageGet, storageSet } from "@/lib/utils";

const CHAIN = "__chain__";
const REPO_KEY = "slaves.lastRepo";

export function QueuePage() {
  const tasks = useStore((s) => s.tasks);
  const tasksLoaded = useStore((s) => s.tasksLoaded);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const [lastSelected, setLastSelected] = useState<TaskView | null>(null);

  useEffect(() => {
    if (selected) setLastSelected(selected);
  }, [selected]);

  // Auto-select the running task if nothing is selected.
  useEffect(() => {
    if (selectedId) return;
    const running = tasks.find((t) => t.status === "running");
    if (running) setSelectedId(running.id);
  }, [tasks, selectedId]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[400px] shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <ListOrderedIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Queue</h2>
          <span className="text-xs text-muted-foreground">{tasks.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {!tasksLoaded ? (
            <p className="p-2 text-sm text-muted-foreground">Connecting…</p>
          ) : tasks.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              Nothing queued. Write a task below and it will run on the next free account.
            </p>
          ) : (
            <QueueList tasks={tasks} selectedId={selectedId} onSelect={setSelectedId} />
          )}
        </div>
        <Composer />
      </div>
      <div className="min-w-0 flex-1">
        {selected ? (
          <TaskDetail key={selected.id} task={selected} />
        ) : lastSelected && selectedId === lastSelected.id ? (
          <div className="p-6 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">{lastSelected.title}</span> has left the queue. Its full record
              is on the History page.
            </p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => setSelectedId(null)}>
              Close
            </Button>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            Select a task to see its live output, diff and history.
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
  onSelect,
}: {
  tasks: TaskView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
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
      renderItem={(task, handle) => (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(task.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSelect(task.id);
          }}
          className={cn(
            "flex cursor-pointer items-start gap-2 rounded-md border bg-card px-2 py-2 hover:bg-accent/50",
            selectedId === task.id && "border-primary/60 ring-1 ring-primary/30",
          )}
        >
          <div className="pt-0.5">{handle}</div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-medium" title={task.message}>
                {task.title || task.message}
              </span>
              <TaskStatusBadge status={task.status} />
            </div>
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <span>{task.repo}</span>
              {task.currentAccount && <span>@{task.currentAccount}</span>}
              <span className="ml-auto">{formatTime(task.createdAt)}</span>
            </div>
            {task.waitingNote && <div className="mt-1 text-[11px] text-warning">{task.waitingNote}</div>}
            {task.pendingReply && (
              <div className="mt-1 truncate text-[11px] text-muted-foreground" title={task.pendingReply}>
                Reply queued: {task.pendingReply}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            {(task.status === "pending" || task.status === "running") && (
              <Button
                size="icon-sm"
                variant="ghost"
                title={task.status === "running" ? "Stop" : "Cancel"}
                onClick={(e) => {
                  e.stopPropagation();
                  void attempt(api.cancelTask(task.id));
                }}
              >
                {task.status === "running" ? <SquareIcon /> : <XIcon />}
              </Button>
            )}
            {task.status === "interrupted" && (
              <Button
                size="icon-sm"
                variant="ghost"
                title="Retry from scratch"
                onClick={(e) => {
                  e.stopPropagation();
                  void attempt(api.retryTask(task.id), "Re-queued");
                }}
              >
                <RotateCcwIcon />
              </Button>
            )}
          </div>
        </div>
      )}
    />
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

function Composer() {
  const { data: repos } = useApi<Repo[]>(() => api.getRepos(), []);
  const accounts = useStore((s) => s.accounts);
  const [repo, setRepo] = useState<string | undefined>(() => storageGet(REPO_KEY) ?? undefined);
  const [account, setAccount] = useState<string>(CHAIN);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);

  // Fall back to the first repo when the remembered one is gone.
  useEffect(() => {
    if (!repos) return;
    if (!repo || !repos.some((r) => r.id === repo)) setRepo(repos[0]?.id);
  }, [repos, repo]);

  const currentRepo = repos?.find((r) => r.id === repo);
  const chainEmpty = currentRepo && currentRepo.accountChain.length === 0 && account === CHAIN;

  const submit = async () => {
    if (!repo || !message.trim() || busy) return;
    setBusy(true);
    const task = await attempt(
      api.createTask({ repo, message, accountOverride: account === CHAIN ? null : account }),
      "Task queued",
    );
    setBusy(false);
    if (task) setMessage("");
  };

  if (repos && repos.length === 0) {
    return (
      <div className="border-t p-3 text-sm text-muted-foreground">
        Register a repository first on the{" "}
        <a href="#/repos" className="text-primary hover:underline">
          Repos
        </a>{" "}
        page.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t bg-sidebar p-3">
      <div className="flex gap-2">
        <Select
          aria-label="Repository"
          value={repo}
          onValueChange={(v) => {
            setRepo(v);
            storageSet(REPO_KEY, v);
          }}
          placeholder="Repository"
          options={(repos ?? []).map((r) => ({ value: r.id, label: r.name }))}
        />
        <Select
          aria-label="Account"
          value={account}
          onValueChange={setAccount}
          options={[
            { value: CHAIN, label: "Use repo chain" },
            ...accounts.map((a) => ({ value: a.id, label: `${a.label} (${a.status})` })),
          ]}
        />
      </div>
      {chainEmpty && (
        <div className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs">
          <AlertTriangleIcon className="size-3.5 text-warning" />
          This repo has no account chain.{" "}
          <a href="#/repos" className="text-primary hover:underline">
            Set one on Repos
          </a>{" "}
          or pick an account.
        </div>
      )}
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Describe the task…  (⌘↵ to queue)"
        className="min-h-24 resize-y bg-background"
      />
      {preview && repo && <PromptPreview repo={repo} message={message} />}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={preview} onCheckedChange={setPreview} />
          Preview prompt
        </label>
        <Button className="ml-auto" disabled={!repo || !message.trim() || busy} onClick={() => void submit()}>
          <SendIcon /> Queue
        </Button>
      </div>
    </div>
  );
}

function PromptPreview({ repo, message }: { repo: string; message: string }) {
  const debounced = useDebounced(message, 300);
  const [result, setResult] = useState<PromptPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!debounced.trim()) {
      setResult(null);
      setError(null);
      return;
    }
    api
      .previewPrompt({ repo, message: debounced })
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
  }, [repo, debounced]);

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center gap-1.5 border-b px-2 py-1">
        <span className="text-[11px] font-medium text-muted-foreground">Exactly what will be sent</span>
        <span className="ml-auto flex gap-1">
          {result?.layers.map((l) => (
            <Badge key={l.name} variant={l.included ? "default" : "outline"} className={cn(!l.included && "line-through")}>
              {l.name}
            </Badge>
          ))}
        </span>
      </div>
      <pre className="max-h-48 overflow-auto p-2 font-mono text-[11px] whitespace-pre-wrap">
        {error ? <span className="text-destructive">{error}</span> : result ? result.prompt : "Type a message to preview."}
      </pre>
    </div>
  );
}

// ── Task detail ─────────────────────────────────────────────────────────────

function TaskDetail({ task }: { task: TaskView }) {
  useTaskSubscription(task.id);
  const hasWorktree = Boolean(task.worktree);
  const reviewable = hasWorktree && (task.status === "needs-review" || task.status === "interrupted");
  const [tab, setTab] = useState(task.status === "needs-review" ? "diff" : "live");

  useEffect(() => {
    if (task.status === "needs-review") setTab("diff");
    if (task.status === "running") setTab("live");
  }, [task.status]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={task.title}>
            {task.title}
          </h2>
          <TaskStatusBadge status={task.status} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
          <span>{task.id}</span>
          <span>repo: {task.repo}</span>
          {task.currentAccount && <span>account: {task.currentAccount}</span>}
          {task.accountOverride && <span>override: {task.accountOverride}</span>}
          {task.worktree && <span>branch: {task.worktree.branch}</span>}
        </div>
        {task.waitingNote && <div className="mt-1 text-xs text-warning">{task.waitingNote}</div>}
      </div>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col px-4 py-3">
        <TabsList className="self-start">
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
        <TabsContent value="live" className="mt-3 flex min-h-0 flex-col">
          <LiveOutput taskId={task.id} />
        </TabsContent>
        <TabsContent value="diff" className="mt-3 flex min-h-0 flex-col">
          {reviewable && <DiffPanel task={task} onDone={() => setTab("history")} />}
        </TabsContent>
        <TabsContent value="history" className="mt-3 min-h-0 overflow-auto">
          <TaskHistory taskId={task.id} version={task.updatedAt} />
        </TabsContent>
      </Tabs>
      <details className="mx-4 mb-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Task message</summary>
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
          {task.message}
        </pre>
      </details>
      {task.status === "needs-review" && <ReplyBox taskId={task.id} />}
    </div>
  );
}

export function TaskHistory({ taskId, version }: { taskId: string; version?: string }) {
  const { data, loading } = useApi(() => api.taskHistory(taskId), [taskId, version]);
  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return <ActivityTimeline entries={data ?? []} />;
}

function ReplyBox({ taskId }: { taskId: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!message.trim() || busy) return;
    setBusy(true);
    const ok = await attempt(api.replyTask(taskId, message), "Reply queued");
    setBusy(false);
    if (ok !== undefined) setMessage("");
  };
  return (
    <div className="flex gap-2 border-t bg-sidebar p-3">
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Reply to continue this session (e.g. answer its plan)…  ⌘↵"
        className="min-h-14 bg-background"
      />
      <Button className="self-end" disabled={!message.trim() || busy} onClick={() => void send()}>
        <SendIcon /> Reply
      </Button>
    </div>
  );
}
