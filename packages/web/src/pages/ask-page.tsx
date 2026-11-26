import type { AskChatView, RepoView } from "@my-ai-slaves/shared";
import { MessageCircleQuestionIcon, PlusIcon, SendIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-dialog";
import { LiveOutput, type UserLabels } from "@/components/live-output";
import { BackBar, PanelHeader } from "@/components/page-header";
import { ResizeHandle, useResizableWidth } from "@/components/resize-handle";
import { LiveDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { api, attempt } from "@/lib/api";
import { useApi, useRepoName, useTaskSubscription } from "@/lib/hooks";
import { clearPastes } from "@/lib/pasted-text";
import { setChats, useStore } from "@/lib/store";
import { cn, storageGet, storageRemove, storageSet } from "@/lib/utils";
import { draftKey, readMessage } from "./queue/drafts";
import { MessageInput } from "./queue/message-input";

const NO_REPO = "__none__";
const ANY_ACCOUNT = "__any__";
const NEW_CHAT_DRAFT = "ask.new";
const chatDraft = (id: string) => `ask.${id}`;
const SELECTED_KEY = "slaves.askChat";
const LABELS: UserLabels = { first: "You", reply: "You" };

/**
 * Ask mode: chats for questions, no repo needed. A question runs at once, read-only (the agent can
 * look, not change), and receives only what you type. Attach a repo to ask about its code.
 */
export function AskPage() {
  const chats = useStore((s) => s.chats);
  const loaded = useStore((s) => s.chatsLoaded);
  // null = a new chat.
  const [selectedId, setSelectedId] = useState<string | null>(() => storageGet(SELECTED_KEY) || null);
  const selected = chats.find((c) => c.id === selectedId) ?? null;
  // Narrow windows show one pane at a time: the chat (or a new one) first, the list behind "Chats".
  const [listOpen, setListOpen] = useState(false);
  const open = (id: string | null) => {
    setSelectedId(id);
    setListOpen(false);
  };

  useEffect(() => {
    void attempt(api.getChats()).then((list) => list && setChats(list));
  }, []);
  useEffect(() => {
    if (selectedId) storageSet(SELECTED_KEY, selectedId);
    else storageRemove(SELECTED_KEY);
  }, [selectedId]);
  // A chat deleted (here or in another window): back to a new chat.
  useEffect(() => {
    if (loaded && selectedId && !chats.some((c) => c.id === selectedId)) setSelectedId(null);
  }, [loaded, chats, selectedId]);

  const listWidth = useResizableWidth({ key: "slaves.askWidth", initial: 320, min: 240, max: 640, reserve: 640 });

  return (
    <div className="flex h-full min-h-0">
      <div
        className={cn("relative flex shrink-0 flex-col border-rule max-lg:w-full! lg:border-r", !listOpen && "max-lg:hidden")}
        style={{ width: listWidth.width }}
      >
        <ResizeHandle {...listWidth} label="Resize the chats panel" className="max-lg:hidden" />
        <PanelHeader>
          <h2 className="title-display text-[15px]">Ask</h2>
          <span className="num rounded-full bg-paper-2 px-1.5 text-[11px] font-medium text-muted-foreground">{chats.length}</span>
          <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => open(null)}>
            <PlusIcon /> New chat
          </Button>
        </PanelHeader>
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto px-3 py-3">
          {!loaded ? (
            <p className="px-1 text-[13px] text-muted-foreground">Loading…</p>
          ) : chats.length === 0 ? (
            <p className="px-1 pt-1 text-[13px] leading-relaxed text-muted-foreground">
              No chats yet. Start a new chat and ask anything; no repo needed.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {chats.map((chat) => (
                <li key={chat.id}>
                  <ChatRow chat={chat} active={chat.id === selectedId} onSelect={() => open(chat.id)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col", listOpen && "max-lg:hidden")}>
        <BackBar label={`Chats${chats.length > 0 ? ` (${chats.length})` : ""}`} onBack={() => setListOpen(true)} />
        <div className="min-h-0 flex-1">
          {selected ? <ChatView key={selected.id} chat={selected} /> : <NewChat onCreated={setSelectedId} />}
        </div>
      </div>
    </div>
  );
}

function ChatRow({ chat, active, onSelect }: { chat: AskChatView; active: boolean; onSelect: () => void }) {
  const repoName = useRepoName();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors duration-150",
        active ? "border-rule bg-surface" : "border-transparent hover:bg-paper-2",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {chat.status === "running" && <LiveDot className="shrink-0 text-signal" />}
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{chat.title}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{when(chat.updatedAt)}</span>
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {chat.repo && <span className="text-ink-2">{repoName(chat.repo)} · </span>}
        {chat.status === "running" ? "Answering…" : chat.preview}
      </span>
    </button>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The account options: any free one, or one picked first. */
function useAccountOptions() {
  const accounts = useStore((s) => s.accounts);
  return [
    { value: ANY_ACCOUNT, label: "Any free account" },
    ...accounts.map((a) => ({ value: a.id, label: `${a.label} · ${a.status}${a.host ? ` · ${a.host}` : ""}` })),
  ];
}

function NewChat({ onCreated }: { onCreated: (id: string) => void }) {
  const { data: repos } = useApi<RepoView[]>(() => api.getRepos(), [], "repos");
  const [repo, setRepo] = useState(NO_REPO);
  const [account, setAccount] = useState(ANY_ACCOUNT);
  const accountOptions = useAccountOptions();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <MessageCircleQuestionIcon className="size-6 text-muted-foreground" />
        <h2 className="title-display text-lg">Ask anything</h2>
        <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
          Questions, not tasks. It answers right away on a free account, can look things up but not change anything, and
          gets only what you type. Attach a repo to ask about its code.
        </p>
      </div>
      <AskBox
        draft={NEW_CHAT_DRAFT}
        placeholder="Ask a question…"
        send={async (message) => {
          const chat = await attempt(
            api.createChat({
              message,
              repo: repo === NO_REPO ? null : repo,
              accountOverride: account === ANY_ACCOUNT ? null : account,
            }),
          );
          if (chat) onCreated(chat.id);
          return Boolean(chat);
        }}
        toolbar={
          <>
            <Select
              aria-label="Repo"
              value={repo}
              onValueChange={setRepo}
              className="h-7 w-auto min-w-0 max-w-56 border-transparent bg-transparent text-xs hover:bg-paper-2"
              options={[
                { value: NO_REPO, label: "No repo" },
                ...(repos ?? []).map((r) => ({ value: r.id, label: r.host ? `${r.name} · ${r.host}` : r.name })),
              ]}
            />
            <Select
              aria-label="Account"
              value={account}
              onValueChange={setAccount}
              className="h-7 w-auto min-w-0 max-w-64 border-transparent bg-transparent text-xs hover:bg-paper-2"
              options={accountOptions}
            />
          </>
        }
      />
    </div>
  );
}

function ChatView({ chat }: { chat: AskChatView }) {
  const repoName = useRepoName();
  useTaskSubscription(chat.id);
  const running = chat.status === "running";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-rule px-4 lg:px-6 py-3">
        <div className="flex items-center gap-3">
          <h2 className="title-display min-w-0 flex-1 truncate text-lg leading-snug" title={chat.title}>
            {chat.title}
          </h2>
          {running && (
            <Button size="sm" variant="outline" onClick={() => void attempt(api.stopChat(chat.id))}>
              <SquareIcon /> Stop
            </Button>
          )}
          <ConfirmButton
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground hover:bg-danger-soft hover:text-danger-ink"
            aria-label={`Delete ${chat.title}`}
            title={`Delete “${chat.title}”?`}
            description={<p>{running ? "Stops the answer, then deletes" : "Deletes"} the chat and its messages.</p>}
            confirmLabel="Delete"
            onConfirm={() => attempt(api.deleteChat(chat.id))}
          >
            <Trash2Icon />
          </ConfirmButton>
        </div>
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <Meta label="repo" value={chat.repo ? repoName(chat.repo) : "none"} />
          {chat.currentAccount && <Meta label="account" value={chat.currentAccount} />}
          <Meta label="mode" value="read-only" />
        </dl>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-4 lg:px-6 py-4">
        <LiveOutput taskId={chat.id} labels={LABELS} emptyText="No messages yet." />
      </div>
      <AskBox
        key={chat.id}
        draft={chatDraft(chat.id)}
        disabled={running}
        placeholder={running ? "Answering… you can type your next question meanwhile." : "Ask a follow-up…"}
        send={async (message) => (await attempt(api.askChat(chat.id, message))) !== undefined}
      />
    </div>
  );
}

function AskBox({
  draft,
  placeholder,
  send,
  toolbar,
  disabled = false,
}: {
  draft: string;
  placeholder: string;
  send: (message: string) => Promise<boolean>;
  toolbar?: React.ReactNode;
  disabled?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [hasText, setHasText] = useState(() => Boolean(storageGet(draftKey(draft))?.trim()));
  const [busy, setBusy] = useState(false);
  const canSend = hasText && !busy && !disabled;
  const submit = async () => {
    const message = readMessage(input, draft);
    if (!canSend || !message.trim()) return;
    setBusy(true);
    const ok = await send(message);
    setBusy(false);
    if (!ok) return;
    if (input.current) input.current.value = "";
    storageRemove(draftKey(draft));
    clearPastes(draftKey(draft));
    setHasText(false);
  };
  return (
    <div className="border-t border-rule bg-paper px-4 lg:px-6 py-3">
      <div className="rounded-lg border border-rule-strong bg-surface transition-[border-color,box-shadow] duration-150 focus-within:border-signal/60 focus-within:ring-3 focus-within:ring-signal/10">
        <MessageInput
          inputRef={input}
          draft={draft}
          aria-label="Question"
          onHasText={setHasText}
          onPaste={() => {}}
          onSubmit={() => void submit()}
          placeholder={placeholder}
          className="max-h-56 min-h-16"
        />
        <div className="flex flex-wrap items-center gap-1 border-t border-rule px-1.5 py-1.5">
          {toolbar}
          <span className="min-w-0 flex-1 basis-32 truncate px-1 text-[11px] text-muted-foreground">Read-only · only your message is sent</span>
          <Button size="sm" variant="signal" className="ml-auto shrink-0" disabled={!canSend} onClick={() => void submit()}>
            <SendIcon /> Ask
          </Button>
        </div>
      </div>
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
