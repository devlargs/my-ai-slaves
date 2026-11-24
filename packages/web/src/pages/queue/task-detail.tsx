import type { TaskView } from "@my-ai-slaves/shared";
import {
  ActivityIcon,
  CheckIcon,
  ClockIcon,
  ChevronDownIcon,
  FileDiffIcon,
  GitGraphIcon,
  HistoryIcon,
  MinusIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActivityTimeline } from "@/components/activity-timeline";
import { ConfirmButton } from "@/components/confirm-dialog";
import { AttachButton, AttachmentList, AttachmentTray, DropZone, useAttachments } from "@/components/attachments";
import { DiffPanel } from "@/components/diff-panel";
import { GitGraphDialog } from "@/components/git-graph";
import { LiveOutput } from "@/components/live-output";
import {
  BoundPromptChips,
  librarySection,
  PromptPicker,
  useBoundPrompts,
  usePromptLibrary,
} from "@/components/prompt-picker";
import { TaskStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, attempt } from "@/lib/api";
import { useApi, useRepoName, useTaskSubscription } from "@/lib/hooks";
import { clearPastes } from "@/lib/pasted-text";
import { cn, storageGet, storageRemove } from "@/lib/utils";
import { draftKey, replyDraft, readMessage } from "./drafts";
import { MessageInput } from "./message-input";

export function TaskDetail({ task }: { task: TaskView }) {
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
          <RepoGraphButton repos={[task.repo, ...task.extraRepos.map((x) => x.repo)]} />
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
    const message = readMessage(input, replyDraft(taskId));
    if (!canSend || (!message.trim() && files.ids.length === 0)) return;
    setBusy(true);
    const ok = await attempt(api.replyTask(taskId, message, files.ids, bound.ids));
    setBusy(false);
    if (ok !== undefined) {
      if (input.current) input.current.value = "";
      storageRemove(draftKey(replyDraft(taskId)));
      clearPastes(draftKey(replyDraft(taskId)));
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
 * Opens the commit graph (the Repos page's view) of the task's repo, any time, to see what changed.
 * A cross-repo task gets a small menu to pick which of its repos.
 */
function RepoGraphButton({ repos }: { repos: string[] }) {
  const repoName = useRepoName();
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  const button = (onClick?: () => void) => (
    <Button size="sm" variant="ghost" className="text-muted-foreground" title="Open the repo's commit graph" onClick={onClick}>
      <GitGraphIcon /> Git graph
      {repos.length > 1 && <ChevronDownIcon />}
    </Button>
  );
  return (
    <>
      {repos.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{button()}</DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {repos.map((id) => (
              <DropdownMenuItem key={id} onSelect={() => setOpenRepo(id)}>
                {repoName(id)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        button(() => setOpenRepo(repos[0] ?? null))
      )}
      <GitGraphDialog
        repoId={openRepo ?? repos[0] ?? ""}
        repoName={repoName(openRepo ?? repos[0] ?? "")}
        open={openRepo !== null}
        onOpenChange={(open) => !open && setOpenRepo(null)}
      />
    </>
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
