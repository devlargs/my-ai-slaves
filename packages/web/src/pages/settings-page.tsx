import type { AccountView, Committer, ProviderId, Settings, UpdateSettingsRequest } from "@my-ai-slaves/shared";
import {
  ArrowUpRightIcon,
  FileTextIcon,
  FolderInputIcon,
  FolderOpenIcon,
  LogInIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  ServerIcon,
  StarIcon,
  TimerResetIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-dialog";
import { InstallButton } from "@/components/desktop-update";
import { SortableList } from "@/components/sortable-list";
import { AccountStatusBadge, ProviderLabel } from "@/components/status";
import { LoginDialog } from "@/components/login-dialog";
import { PageHeader } from "@/components/page-header";
import { FullscreenButton, FullscreenEditor } from "@/components/fullscreen-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, attempt } from "@/lib/api";
import { desktop, desktopAction, useDesktop } from "@/lib/desktop";
import { useApi } from "@/lib/hooks";
import { getState, setAccounts, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function SettingsPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      <PageHeader
        title="Settings"
        description="Log in your Claude and Cursor accounts, and set what every task starts with."
      />
      <AccountsCard />
      <CommittersCard />
      <GeneralSettingsCard />
      <DesktopCard />
    </div>
  );
}

// ── Accounts ────────────────────────────────────────────────────────────────

const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const THIS_MAC = "__this_mac__";

async function refreshAccounts() {
  const accounts = await attempt(api.getAccounts());
  if (accounts) setAccounts(accounts);
}

function AccountsCard() {
  const accounts = useStore((s) => s.accounts);
  const [loginFor, setLoginFor] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude-code");
  const [runsOn, setRunsOn] = useState<string>(THIS_MAC);
  const [hosts, setHosts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const remoteHost = runsOn === THIS_MAC ? null : runsOn;
  // This Mac: one Cursor account (Keychain). A host: one account per CLI (it uses the server's login).
  const hasCursor = accounts.some((a) => (a.host ?? null) === remoteHost && a.provider === "cursor-agent");

  useEffect(() => {
    void api
      .getRemoteHosts()
      .then((list) => setHosts(list.map((h) => h.host)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (hasCursor && provider === "cursor-agent") setProvider("claude-code");
  }, [hasCursor, provider]);

  const labelValid = LABEL_RE.test(label);

  const create = async () => {
    if (!labelValid) return;
    setBusy(true);
    const account = await attempt(api.createAccount({ label, provider, host: remoteHost }), "Account added");
    setBusy(false);
    if (account) {
      setLabel("");
      await refreshAccounts();
      // Remote accounts use the server's existing login; local ones log in now.
      if (!account.host) setLoginFor(account.id);
    }
  };

  const reorder = async (ids: string[]) => {
    const previous = getState().accounts;
    const byId = new Map(previous.map((a) => [a.id, a]));
    setAccounts(ids.map((id) => byId.get(id)).filter((a): a is AccountView => Boolean(a)));
    if ((await attempt(api.orderAccounts(ids))) === undefined) setAccounts(previous);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscription accounts</CardTitle>
        <span className="text-xs text-muted-foreground">Order here pre-fills new repos&apos; account chains</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {accounts.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No accounts yet. Add one below and log in.</p>
        ) : (
          <SortableList
            items={accounts}
            getId={(a) => a.id}
            onReorder={(ids) => void reorder(ids)}
            renderItem={(account, handle) => (
              <AccountRow account={account} handle={handle} onLogin={() => setLoginFor(account.id)} />
            )}
          />
        )}

        <form
          className="flex flex-wrap items-end gap-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="account-label">New account label</Label>
            <Input
              id="account-label"
              value={label}
              onChange={(e) => setLabel(e.target.value.toLowerCase())}
              placeholder="work_1-claude"
              className="font-mono text-xs"
              aria-invalid={label !== "" && !labelValid}
            />
          </div>
          <div className="flex w-44 flex-col gap-1">
            <Label>Runs on</Label>
            <Select
              aria-label="Runs on"
              value={runsOn}
              onValueChange={(v) => {
                setRunsOn(v);
                if (v !== THIS_MAC && !label) setLabel(`${v.split(".")[0]?.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}-claude`);
              }}
              options={[
                { value: THIS_MAC, label: "This Mac" },
                ...hosts.map((h) => ({ value: h, label: `${h} (SSH)` })),
              ]}
            />
          </div>
          <div className="flex w-44 flex-col gap-1">
            <Label>Provider</Label>
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as ProviderId)}
              options={[
                { value: "claude-code", label: "Claude Code" },
                { value: "cursor-agent", label: "Cursor Agent", disabled: hasCursor },
              ]}
            />
          </div>
          <Button type="submit" disabled={!labelValid || busy}>
            <PlusIcon /> {remoteHost ? "Add" : "Add & log in"}
          </Button>
          <p className="w-full text-[11px] text-muted-foreground">
            {remoteHost ? (
              <>
                Runs tasks on <code className="font-mono">{remoteHost}</code> over SSH with whatever Claude / Cursor login is
                already on that server. Use it in the chains of repos on that host.
              </>
            ) : (
              <>
                Labels: lowercase letters, digits, <code>_</code> and <code>-</code>. Each Claude account gets its own
                config folder so logins don&apos;t collide. Only one Cursor account is supported on this Mac: the Cursor
                CLI keeps its login in the macOS Keychain, shared by every config folder.
              </>
            )}
          </p>
        </form>
      </CardContent>
      <LoginDialog
        accountId={loginFor}
        open={loginFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setLoginFor(null);
            void refreshAccounts();
          }
        }}
      />
    </Card>
  );
}

function AccountRow({
  account,
  handle,
  onLogin,
}: {
  account: AccountView;
  handle: ReactNode;
  onLogin: () => void;
}) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-2.5 py-2 transition-colors hover:border-rule-strong">
      {handle}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{account.label}</span>
          <ProviderLabel provider={account.provider} />
          {account.host && (
            <Badge variant="outline" className="gap-1 font-mono" title={`Runs on ${account.host} over SSH, with that server's login`}>
              <ServerIcon className="size-3" />
              {account.host}
            </Badge>
          )}
          <AccountStatusBadge account={account} />
        </div>
        {account.email && account.status !== "logged-out" && (
          <div className="truncate text-[11px] text-muted-foreground">
            {account.email}
            {account.plan ? ` · ${account.plan}` : ""}
          </div>
        )}
        {account.lastLimitReason && (
          <div className="truncate text-[11px] text-muted-foreground" title={account.lastLimitReason}>
            Last limit: {account.lastLimitReason}
          </div>
        )}
      </div>
      <Button size="sm" variant={account.status === "logged-out" || account.status === "unknown" ? "default" : "outline"} onClick={onLogin}>
        <LogInIcon /> {account.status === "logged-out" || account.status === "unknown" ? "Log in" : "Log in again"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          await attempt(api.checkAccount(account.id));
          await refreshAccounts();
          setChecking(false);
        }}
      >
        <RefreshCwIcon className={checking ? "animate-spin" : undefined} /> Check
      </Button>
      {account.status === "limited" && (
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await attempt(api.clearLimit(account.id), "Limit cleared");
            await refreshAccounts();
          }}
        >
          <TimerResetIcon /> Clear limit
        </Button>
      )}
      <ConfirmButton
        size="icon-sm"
        variant="ghost"
        className="text-muted-foreground hover:bg-danger-soft hover:text-danger-ink"
        aria-label={`Delete ${account.label}`}
        title={`Delete ${account.label}?`}
        description={
          <div className="flex flex-col gap-2">
            {account.host ? (
              <p>
                This removes it from the app and from every repo&apos;s chain. The login on{" "}
                <code className="font-mono text-xs">{account.host}</code> is left as it is.
              </p>
            ) : (
              <p>
                This logs the CLI out for this account, deletes its config folder{" "}
                <code className="font-mono text-xs">{account.configDir}</code>, and removes it from every repo&apos;s
                chain.
              </p>
            )}
            {!account.host && account.provider === "cursor-agent" && (
              <p className="font-medium text-danger-ink">
                Cursor keeps one login per Mac, so this also logs out the Cursor CLI (<code>agent</code>) everywhere on
                this machine.
              </p>
            )}
          </div>
        }
        confirmLabel="Delete account"
        onConfirm={async () => {
          await attempt(api.deleteAccount(account.id), "Account deleted");
          await refreshAccounts();
        }}
      >
        <Trash2Icon />
      </ConfirmButton>
    </div>
  );
}

// ── Committers ──────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Saves only the committer fields, on top of the latest settings (the General card keeps its own draft). */
async function saveCommitters(patch: Pick<Settings, "committers" | "defaultCommitterId">, success: string) {
  const latest = await attempt(api.getSettings());
  if (!latest) return undefined;
  const { updatedAt: _ignored, ...rest } = latest;
  return attempt(api.putSettings({ ...rest, ...patch }), success);
}

function CommittersCard() {
  const { data, setData } = useApi<Settings>(() => api.getSettings(), [], "settings");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  if (!data) {
    return (
      <Card>
        <CardContent className="text-[13px] text-muted-foreground">Loading committers…</CardContent>
      </Card>
    );
  }
  const { committers, defaultCommitterId } = data;
  const valid = name.trim() !== "" && EMAIL_RE.test(email.trim());

  const save = async (next: Pick<Settings, "committers" | "defaultCommitterId">, success: string) => {
    setBusy(true);
    const result = await saveCommitters(next, success);
    setBusy(false);
    if (result) setData(result);
    return result;
  };

  const add = async () => {
    if (!valid) return;
    const committer: Committer = { id: crypto.randomUUID(), name: name.trim(), email: email.trim() };
    // The first one becomes the default, so it applies right away.
    const result = await save(
      { committers: [...committers, committer], defaultCommitterId: defaultCommitterId ?? committer.id },
      "Committer added",
    );
    if (result) {
      setName("");
      setEmail("");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Committers</CardTitle>
        <span className="text-xs text-muted-foreground">Each repo picks one; repos that don&apos;t use the default</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {committers.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            None yet, so tasks commit with your git config. Add one below.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {committers.map((c) => (
              <CommitterRow
                key={c.id}
                committer={c}
                isDefault={c.id === defaultCommitterId}
                busy={busy}
                onMakeDefault={() => void save({ committers, defaultCommitterId: c.id }, "Default committer set")}
                onEdit={(edited) =>
                  save({ committers: committers.map((x) => (x.id === c.id ? edited : x)), defaultCommitterId }, "Committer saved")
                }
                onDelete={() =>
                  save(
                    {
                      committers: committers.filter((x) => x.id !== c.id),
                      defaultCommitterId: defaultCommitterId === c.id ? null : defaultCommitterId,
                    },
                    "Committer deleted",
                  )
                }
              />
            ))}
          </div>
        )}

        <form
          className="flex flex-wrap items-end gap-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="committer-name">Full name</Label>
            <Input id="committer-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" autoComplete="name" maxLength={200} />
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="committer-email">Email</Label>
            <Input
              id="committer-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              autoComplete="email"
              className="font-mono text-xs"
              maxLength={200}
              aria-invalid={email.trim() !== "" && !EMAIL_RE.test(email.trim())}
            />
          </div>
          <Button type="submit" disabled={!valid || busy}>
            <PlusIcon /> Add
          </Button>
          <p className="w-full text-[11px] text-muted-foreground">
            Author and committer of every commit on a repo&apos;s tasks. With no default, repos that don&apos;t pick one use
            your git config.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

function CommitterRow({
  committer,
  isDefault,
  busy,
  onMakeDefault,
  onEdit,
  onDelete,
}: {
  committer: Committer;
  isDefault: boolean;
  busy: boolean;
  onMakeDefault: () => void;
  onEdit: (edited: Committer) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(committer.name);
  const [email, setEmail] = useState(committer.email);
  const valid = name.trim() !== "" && EMAIL_RE.test(email.trim());
  const dirty = name.trim() !== committer.name || email.trim() !== committer.email;

  if (editing) {
    return (
      <form
        className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-surface px-2.5 py-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          if (!dirty || (await onEdit({ ...committer, name: name.trim(), email: email.trim() }))) setEditing(false);
        }}
      >
        <Input aria-label="Full name" value={name} onChange={(e) => setName(e.target.value)} className="min-w-40 flex-1" maxLength={200} />
        <Input
          aria-label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-40 flex-1 font-mono text-xs"
          maxLength={200}
          aria-invalid={!EMAIL_RE.test(email.trim())}
        />
        <Button type="submit" size="sm" disabled={!valid || busy}>
          <SaveIcon /> Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setName(committer.name);
            setEmail(committer.email);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </form>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-2.5 py-2 transition-colors hover:border-rule-strong">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{committer.name}</span>
          {isDefault && <Badge variant="outline">default</Badge>}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">{committer.email}</div>
      </div>
      {!isDefault && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onMakeDefault}>
          <StarIcon /> Make default
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
        <PencilIcon /> Edit
      </Button>
      <ConfirmButton
        size="icon-sm"
        variant="ghost"
        className="text-muted-foreground hover:bg-danger-soft hover:text-danger-ink"
        aria-label={`Delete ${committer.name}`}
        title={`Delete ${committer.name}?`}
        description={
          <p>
            Repos that commit as {committer.name} switch to the default committer
            {isDefault ? " (none after this, so your git config)" : ""}.
          </p>
        }
        confirmLabel="Delete committer"
        onConfirm={async () => {
          await onDelete();
        }}
      >
        <Trash2Icon />
      </ConfirmButton>
    </div>
  );
}

// ── General settings ────────────────────────────────────────────────────────

function GeneralSettingsCard() {
  const { data, setData } = useApi<Settings>(() => api.getSettings(), [], "settings");
  const [draft, setDraft] = useState<UpdateSettingsRequest | null>(null);
  const [patterns, setPatterns] = useState("");
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!data) return;
    const { updatedAt: _ignored, ...rest } = data;
    setDraft(rest);
    setPatterns(rest.providers["cursor-agent"].limitPatterns.join("\n"));
  }, [data]);

  if (!draft || !data) {
    return (
      <Card>
        <CardContent className="text-[13px] text-muted-foreground">Loading settings…</CardContent>
      </Card>
    );
  }

  const claude = draft.providers["claude-code"];
  const cursor = draft.providers["cursor-agent"];
  const patternList = patterns
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  // Committers are saved by their own card, so they don't count here.
  const { updatedAt: _u, committers: _c, defaultCommitterId: _d, ...saved } = data;
  const { committers: _dc, defaultCommitterId: _dd, ...draftRest } = draft;
  const dirty =
    JSON.stringify(saved) !==
    JSON.stringify({ ...draftRest, providers: { ...draft.providers, "cursor-agent": { ...cursor, limitPatterns: patternList } } });

  const set = (patch: Partial<UpdateSettingsRequest>) => setDraft({ ...draft, ...patch });
  const setClaude = (patch: Partial<typeof claude>) =>
    set({ providers: { ...draft.providers, "claude-code": { ...claude, ...patch } } });
  const setCursor = (patch: Partial<typeof cursor>) =>
    set({ providers: { ...draft.providers, "cursor-agent": { ...cursor, ...patch } } });

  const save = async () => {
    setBusy(true);
    // Keep whatever the Committers card saved since this card loaded.
    const latest = await attempt(api.getSettings());
    if (!latest) {
      setBusy(false);
      return;
    }
    const result = await attempt(
      api.putSettings({
        ...draft,
        committers: latest.committers,
        defaultCommitterId: latest.defaultCommitterId,
        providers: { ...draft.providers, "cursor-agent": { ...cursor, limitPatterns: patternList } },
      }),
      "Settings saved",
    );
    setBusy(false);
    if (result) setData(result);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>General</CardTitle>
          {dirty && <Badge variant="warning">unsaved</Badge>}
        </div>
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
          <SaveIcon /> Save
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor="global-base">Global base prompt</Label>
            <span className="ml-auto">
              <FullscreenButton onClick={() => setFullscreen(true)} />
            </span>
          </div>
          <FullscreenEditor
            open={fullscreen}
            onOpenChange={setFullscreen}
            title="Global base prompt"
            note="Stored in .data/settings.json"
            value={draft.basePrompt}
            onChange={(basePrompt) => set({ basePrompt })}
            placeholder="Blank. Anything you write here is sent first, before the repo base prompt and your task message."
            dirty={dirty}
            saving={busy}
            onSave={() => void save()}
          />
          <Textarea
            id="global-base"
            value={draft.basePrompt}
            onChange={(e) => set({ basePrompt: e.target.value })}
            placeholder="Blank. Anything you write here is sent first, before the repo base prompt and your task message."
            className="min-h-32 font-mono text-xs"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="max-parallel">Max tasks running at once (across repos)</Label>
            <Input
              id="max-parallel"
              type="number"
              min={1}
              max={16}
              value={draft.maxParallelTasks}
              onChange={(e) => set({ maxParallelTasks: Number(e.target.value) || 1 })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cooldown">Limit cooldown when no reset time is reported (minutes)</Label>
            <Input
              id="cooldown"
              type="number"
              min={1}
              value={draft.limitCooldownMinutes}
              onChange={(e) => set({ limitCooldownMinutes: Number(e.target.value) || 1 })}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="flex flex-col gap-2.5 rounded-lg border border-rule p-3.5">
            <legend className="px-1 text-xs font-semibold">Claude Code</legend>
            <Label>Binary</Label>
            <Input value={claude.binary} onChange={(e) => setClaude({ binary: e.target.value })} className="font-mono text-xs" />
            <Label>Model (blank = CLI default)</Label>
            <Input
              value={claude.model ?? ""}
              onChange={(e) => setClaude({ model: e.target.value.trim() ? e.target.value : null })}
              placeholder="CLI default"
              className="font-mono text-xs"
            />
            <Label>Permission mode</Label>
            <Select
              value={claude.permissionMode}
              onValueChange={(v) => setClaude({ permissionMode: v as typeof claude.permissionMode })}
              options={["auto", "acceptEdits", "manual", "dontAsk", "plan", "bypassPermissions"].map((m) => ({
                value: m,
                label: m,
              }))}
            />
          </fieldset>
          <fieldset className="flex flex-col gap-2.5 rounded-lg border border-rule p-3.5">
            <legend className="px-1 text-xs font-semibold">Cursor Agent</legend>
            <Label>Binary</Label>
            <Input value={cursor.binary} onChange={(e) => setCursor({ binary: e.target.value })} className="font-mono text-xs" />
            <Label>Model (blank = CLI default)</Label>
            <Input
              value={cursor.model ?? ""}
              onChange={(e) => setCursor({ model: e.target.value.trim() ? e.target.value : null })}
              placeholder="CLI default"
              className="font-mono text-xs"
            />
            <Label>Permission mode</Label>
            <Select
              value={cursor.permissionMode}
              onValueChange={(v) => setCursor({ permissionMode: v as typeof cursor.permissionMode })}
              options={[
                { value: "auto-review", label: "auto-review" },
                { value: "allowlist", label: "allowlist" },
                { value: "force", label: "force (run everything)" },
              ]}
            />
            <Label>Usage-limit patterns (one regex per line, blank = built-in list)</Label>
            <Textarea
              value={patterns}
              onChange={(e) => setPatterns(e.target.value)}
              placeholder="usage limit"
              className="min-h-20 font-mono text-xs"
            />
          </fieldset>
        </div>
        <p className="text-[11px] text-muted-foreground">Saved to .data/settings.json · last saved {data.updatedAt}</p>
      </CardContent>
    </Card>
  );
}

// ── Desktop app (only in the desktop app) ───────────────────────────────────

function DesktopCard() {
  const { info, update } = useDesktop();
  if (!desktop || !info) return null;
  const status = update?.status ?? "idle";
  const checking = status === "checking";

  const updateLine = (() => {
    switch (status) {
      case "checking":
        return "Checking for updates…";
      case "latest":
        return "This is the latest version.";
      case "available":
        return `Version ${update?.newVersion} is available.`;
      case "manual":
        return `Version ${update?.newVersion} is available, but has no checksum to verify it, so it can't install from the app.`;
      case "downloading":
        return `Downloading ${update?.newVersion}… ${update?.percent ?? 0}%`;
      case "installing":
        return "Installing; the app restarts in a moment.";
      case "error":
        return update?.error ?? "The last check failed.";
      default:
        return "Checks on launch and every 6 hours.";
    }
  })();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Desktop app</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] font-medium">
              My AI Slaves <span className="num">v{info.version}</span>
            </span>
            <span className={cn("text-xs", status === "error" ? "text-danger-ink" : "text-muted-foreground")}>{updateLine}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status === "available" && <InstallButton newVersion={update?.newVersion ?? null} />}
            {status === "manual" && (
              <Button size="sm" variant="outline" onClick={() => void desktopAction(() => desktop!.openReleasePage())}>
                <ArrowUpRightIcon /> Release page
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={checking || status === "downloading" || status === "installing"}
              onClick={() => void desktopAction(() => desktop!.checkForUpdates())}
            >
              <RefreshCwIcon className={cn(checking && "animate-spin")} /> Check for updates
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Data folder</Label>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 font-mono text-xs" title={info.dataDir}>
              {info.dataDir}
            </code>
            <Button size="sm" variant="outline" onClick={() => void desktopAction(() => desktop!.openDataFolder())}>
              <FolderOpenIcon /> Open
            </Button>
            <Button size="sm" variant="outline" onClick={() => void desktopAction(() => desktop!.changeDataFolder())}>
              <FolderInputIcon /> Change…
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Settings, accounts, repos, the queue and activity, as plain JSON files. Changing the folder restarts the app on
            the new one and leaves this one as it is.
          </p>
        </div>

        <div>
          <Button size="sm" variant="ghost" onClick={() => void desktopAction(() => desktop!.openLogFile())}>
            <FileTextIcon /> Open server log
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
