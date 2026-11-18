import type { AccountView, ProviderId, Settings, UpdateSettingsRequest } from "@my-ai-slaves/shared";
import { LogInIcon, PlusIcon, RefreshCwIcon, SaveIcon, TimerResetIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-dialog";
import { SortableList } from "@/components/sortable-list";
import { AccountStatusBadge, ProviderLabel } from "@/components/status";
import { LoginDialog } from "@/components/login-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, attempt } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { getState, setAccounts, useStore } from "@/lib/store";

export function SettingsPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold">Settings</h1>
      <AccountsCard />
      <GeneralSettingsCard />
    </div>
  );
}

// ── Accounts ────────────────────────────────────────────────────────────────

const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

async function refreshAccounts() {
  const accounts = await attempt(api.getAccounts());
  if (accounts) setAccounts(accounts);
}

function AccountsCard() {
  const accounts = useStore((s) => s.accounts);
  const [loginFor, setLoginFor] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude-code");
  const [busy, setBusy] = useState(false);
  const hasCursor = accounts.some((a) => a.provider === "cursor-agent");

  useEffect(() => {
    if (hasCursor && provider === "cursor-agent") setProvider("claude-code");
  }, [hasCursor, provider]);

  const labelValid = LABEL_RE.test(label);

  const create = async () => {
    if (!labelValid) return;
    setBusy(true);
    const account = await attempt(api.createAccount({ label, provider }), "Account added");
    setBusy(false);
    if (account) {
      setLabel("");
      await refreshAccounts();
      setLoginFor(account.id);
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
          <p className="text-sm text-muted-foreground">No accounts yet. Add one below and log in.</p>
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
            <PlusIcon /> Add & log in
          </Button>
          <p className="w-full text-[11px] text-muted-foreground">
            Labels: lowercase letters, digits, <code>_</code> and <code>-</code>. Each Claude account gets its own config
            folder so logins don&apos;t collide. Only one Cursor account is supported: the Cursor CLI keeps its login in
            the macOS Keychain, shared by every config folder.
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
    <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
      {handle}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{account.label}</span>
          <ProviderLabel provider={account.provider} />
          <AccountStatusBadge account={account} />
        </div>
        {account.lastLimitReason && (
          <div className="truncate text-[11px] text-muted-foreground" title={account.lastLimitReason}>
            Last limit: {account.lastLimitReason}
          </div>
        )}
      </div>
      <Button size="sm" variant="outline" onClick={onLogin}>
        <LogInIcon /> Log in
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
        className="text-destructive"
        aria-label={`Delete ${account.label}`}
        title={`Delete ${account.label}?`}
        description={
          <div className="flex flex-col gap-2">
            <p>
              This logs the CLI out for this account, deletes its config folder{" "}
              <code className="font-mono text-xs">{account.configDir}</code>, and removes it from every repo&apos;s
              chain.
            </p>
            {account.provider === "cursor-agent" && (
              <p className="font-medium text-destructive">
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

// ── General settings ────────────────────────────────────────────────────────

function GeneralSettingsCard() {
  const { data, setData } = useApi<Settings>(() => api.getSettings(), []);
  const [draft, setDraft] = useState<UpdateSettingsRequest | null>(null);
  const [patterns, setPatterns] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    const { updatedAt: _ignored, ...rest } = data;
    setDraft(rest);
    setPatterns(rest.providers["cursor-agent"].limitPatterns.join("\n"));
  }, [data]);

  if (!draft || !data) {
    return (
      <Card>
        <CardContent className="text-sm text-muted-foreground">Loading settings…</CardContent>
      </Card>
    );
  }

  const claude = draft.providers["claude-code"];
  const cursor = draft.providers["cursor-agent"];
  const patternList = patterns
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  const { updatedAt: _u, ...saved } = data;
  const dirty =
    JSON.stringify(saved) !==
    JSON.stringify({ ...draft, providers: { ...draft.providers, "cursor-agent": { ...cursor, limitPatterns: patternList } } });

  const set = (patch: Partial<UpdateSettingsRequest>) => setDraft({ ...draft, ...patch });
  const setClaude = (patch: Partial<typeof claude>) =>
    set({ providers: { ...draft.providers, "claude-code": { ...claude, ...patch } } });
  const setCursor = (patch: Partial<typeof cursor>) =>
    set({ providers: { ...draft.providers, "cursor-agent": { ...cursor, ...patch } } });

  const save = async () => {
    setBusy(true);
    const result = await attempt(
      api.putSettings({
        ...draft,
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
          <Label htmlFor="global-base">Global base prompt</Label>
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
          <fieldset className="flex flex-col gap-2 rounded-md border p-3">
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
          <fieldset className="flex flex-col gap-2 rounded-md border p-3">
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
