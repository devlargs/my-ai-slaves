import type { TaskView } from "@my-ai-slaves/shared";
import { CheckCheckIcon, ClockIcon, CornerDownRightIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useMemo } from "react";
import { SortableList } from "@/components/sortable-list";
import { TaskStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { api, attempt } from "@/lib/api";
import { useRepoName } from "@/lib/hooks";
import { getState, setTasks } from "@/lib/store";
import { cn, formatTime } from "@/lib/utils";
import { promptCount } from "./drafts";
import { DiscardTaskButton } from "./task-detail";

export function QueueList({
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
