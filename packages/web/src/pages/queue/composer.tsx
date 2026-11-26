import { CLAUDE_MODEL_ALIASES, type PromptPreviewResponse, type RepoView, TASK_EFFORTS, type TaskEffort, type TaskView } from "@my-ai-slaves/shared";
import { AlertTriangleIcon, CheckIcon, FilePenLineIcon, SaveIcon, SendIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AttachButton, AttachmentTray, DropZone, useAttachments } from "@/components/attachments";
import {
  BoundPromptChips,
  librarySection,
  PromptPicker,
  repoSection,
  useBoundPrompts,
  usePromptLibrary,
  useRepoPromptSets,
} from "@/components/prompt-picker";
import { RepoPicker, type RepoSelection } from "@/components/repo-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, attempt } from "@/lib/api";
import { useApi, useDebounced } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import { clearPastes } from "@/lib/pasted-text";
import { cn, storageGet, storageRemove, storageSet } from "@/lib/utils";
import {
  CHAIN,
  DEFAULT_PICK,
  EFFORT_KEY,
  MODEL_KEY,
  REPO_KEY,
  EXTRA_REPOS_KEY,
  draftKey,
  COMPOSER_DRAFT,
  fullText,
  readMessage,
  storedExtras,
} from "./drafts";
import { MessageInput } from "./message-input";

const EFFORT_LABELS: Record<TaskEffort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const storedEffort = () => {
  const saved = storageGet(EFFORT_KEY);
  return TASK_EFFORTS.some((e) => e === saved) ? (saved as TaskEffort) : DEFAULT_PICK;
};

export function Composer({
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
  // Claude Code's --model / --effort for this task; the pick is remembered for the next one.
  const [model, setModel] = useState<string>(() => storageGet(MODEL_KEY) || DEFAULT_PICK);
  const [effort, setEffort] = useState<string>(storedEffort);
  const pickModel = (value: string) => {
    setModel(value);
    if (value === DEFAULT_PICK) storageRemove(MODEL_KEY);
    else storageSet(MODEL_KEY, value);
  };
  const pickEffort = (value: string) => {
    setEffort(value);
    if (value === DEFAULT_PICK) storageRemove(EFFORT_KEY);
    else storageSet(EFFORT_KEY, value);
  };
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
  // Model and effort are Claude Code flags: nothing to pick when the task is sent to a Cursor account.
  const cursorOnly = accounts.find((a) => a.id === account)?.provider === "cursor-agent";
  const modelOptions = [
    { value: DEFAULT_PICK, label: "Default model" },
    ...CLAUDE_MODEL_ALIASES.map((m) => ({ value: m as string, label: capitalize(m) })),
    // A model the list doesn't have (a draft queued through the API with a full model name).
    ...(model !== DEFAULT_PICK && !CLAUDE_MODEL_ALIASES.some((m) => m === model) ? [{ value: model, label: model }] : []),
  ];
  const chainEmpty = currentRepo && currentRepo.accountChain.length === 0 && account === CHAIN;
  // A pasted image (or any attached file) on its own is a valid task.
  const hasContent = hasText || files.files.length > 0;
  const canSend = Boolean(repo && hasContent) && !busy && !files.uploading && !files.failed;

  const setMessage = (text: string) => {
    if (input.current) input.current.value = text;
    clearPastes(draftKey(COMPOSER_DRAFT));
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
    setModel(t.model ?? DEFAULT_PICK);
    setEffort(t.effort ?? DEFAULT_PICK);
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
    const message = readMessage(input, COMPOSER_DRAFT);
    if (!repo || !canSend || (!message.trim() && files.ids.length === 0)) return;
    setBusy(true);
    const task = await attempt(
      api.createTask({
        repo,
        message,
        accountOverride: account === CHAIN ? null : account,
        model: cursorOnly || model === DEFAULT_PICK ? null : model,
        effort: cursorOnly || effort === DEFAULT_PICK ? null : (effort as TaskEffort),
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
          <div className="flex flex-wrap gap-1.5 border-b border-rule px-2 py-1.5">
            <RepoPicker repos={repos ?? []} value={{ main: repo, extras }} onChange={selectRepos} />
            <Select
              aria-label="Account"
              value={account}
              onValueChange={setAccount}
              className="h-7 w-auto max-w-full min-w-0 flex-auto border-transparent bg-transparent text-xs hover:bg-paper-2"
              options={[
                { value: CHAIN, label: "Repo's account chain" },
                ...accounts.map((a) => ({ value: a.id, label: `${a.label} · ${a.status}` })),
              ]}
            />
            {/* One group, so model and effort stay together when the row wraps. */}
            <span
              className="flex max-w-full min-w-0 gap-1.5"
              title={
                cursorOnly
                  ? "Model and effort are Claude Code options. Cursor uses the model from Settings."
                  : "Model and effort for this task's Claude Code runs. Cursor accounts use the model from Settings."
              }
            >
              <Select
                aria-label="Model"
                value={cursorOnly ? DEFAULT_PICK : model}
                onValueChange={pickModel}
                disabled={cursorOnly}
                className="h-7 w-auto min-w-0 border-transparent bg-transparent text-xs whitespace-nowrap hover:bg-paper-2"
                options={modelOptions}
              />
              <Select
                aria-label="Effort"
                value={cursorOnly ? DEFAULT_PICK : effort}
                onValueChange={pickEffort}
                disabled={cursorOnly}
                className="h-7 w-auto min-w-0 border-transparent bg-transparent text-xs whitespace-nowrap hover:bg-paper-2"
                options={[
                  { value: DEFAULT_PICK, label: "Default effort" },
                  ...TASK_EFFORTS.map((e) => ({ value: e as string, label: EFFORT_LABELS[e] })),
                ]}
              />
            </span>
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
            onText={preview ? (text) => setPreviewText(fullText(text, COMPOSER_DRAFT)) : undefined}
            onPaste={files.onPaste}
            onSubmit={() => void submit()}
            placeholder="Describe the task. Paste or drop screenshots and files."
            className="max-h-72 min-h-24 max-lg:max-h-40 max-lg:min-h-16"
          />
          {files.files.length > 0 && (
            <div className="px-2.5 pb-2">
              <AttachmentTray attachments={files} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 border-t border-rule px-1.5 py-1.5">
            <AttachButton attachments={files} />
            <PromptPicker
              sections={sections}
              footer="Sent in order: global base prompt, the ticked repo prompts, the ticked saved prompts, then your message."
            />
            <label className="ml-1 flex cursor-pointer items-center gap-2 text-xs whitespace-nowrap text-muted-foreground select-none">
              <Switch
                checked={preview}
                onCheckedChange={(on) => {
                  setPreview(on);
                  if (on) setPreviewText(readMessage(input, COMPOSER_DRAFT));
                }}
              />
              Preview prompt
            </label>
                        <span className="ml-auto hidden text-[11px] whitespace-nowrap text-muted-foreground sm:inline">
              <kbd className="font-mono">↵</kbd> to queue · <kbd className="font-mono">⇧↵</kbd> new line
            </span>
            {/* One group, so the two actions stay together when the row wraps (a narrow window or panel). */}
            <span className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={!canSend}
              title={editingDraft ? "Save the changes to this draft" : "Keep it in the queue as a draft: it never runs until you open it and queue it"}
              onClick={() => void submit(true)}
            >
              <SaveIcon /> {editingDraft ? "Save draft" : "Mark as draft"}
            </Button>
            <Button size="sm" variant="signal" disabled={!canSend} onClick={() => void submit()}>
              <SendIcon /> {files.uploading ? "Uploading…" : "Queue"}
            </Button>
            </span>
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: arrays are compared by content, not identity
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
