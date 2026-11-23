import type { TaskView } from "@my-ai-slaves/shared";
import { InboxIcon, MousePointerClickIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PanelHeader } from "@/components/page-header";
import { ResizeHandle, useResizableWidth } from "@/components/resize-handle";
import { useStore } from "@/lib/store";
import { Composer } from "./queue/composer";
import { QueueList } from "./queue/queue-list";
import { TaskDetail } from "./queue/task-detail";

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
