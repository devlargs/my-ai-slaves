import { mkdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  type Account,
  AccountLabel,
  type AccountView,
  formatLocalIso,
  type ProviderId,
} from "@my-ai-slaves/shared";
import { PROJECT_ROOT } from "../paths";
import type { AdapterRegistry } from "../providers";
import { runToCompletion } from "../providers/spawn";
import { assertHost } from "../remote/machine";
import type { AccountContext } from "../providers/types";
import type { DataStores } from "../storage/data-stores";
import { effectiveStatus } from "./account-router";
import { badRequest, type Broadcaster, conflict, notFound } from "./common";

export class AccountService {
  /** Last status-check result per account (email/plan stay in memory, never written to accounts.json). */
  private readonly authInfo = new Map<string, { email: string | null; plan: string | null }>();

  constructor(
    private readonly stores: DataStores,
    private readonly adapters: AdapterRegistry,
    private readonly broadcaster: Broadcaster,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Local accounts: their isolated CLI config folder. Remote accounts (server's own login): null. */
  configDirOf(account: Account): string | null {
    return account.host || !account.configDir ? null : resolve(PROJECT_ROOT, account.configDir);
  }

  context(account: Account): AccountContext {
    return { account, configDir: this.configDirOf(account) };
  }

  toView(account: Account): AccountView {
    const now = this.now();
    const status = effectiveStatus(account, now);
    const seconds =
      status === "limited" && account.limitedUntil
        ? Math.max(0, Math.round((new Date(account.limitedUntil).getTime() - now.getTime()) / 1000))
        : null;
    const info = this.authInfo.get(account.id);
    return { ...account, status, secondsUntilAvailable: seconds, email: info?.email ?? null, plan: info?.plan ?? null };
  }

  async listRaw(): Promise<Account[]> {
    return (await this.stores.accounts.read()).accounts;
  }

  async list(): Promise<AccountView[]> {
    return (await this.listRaw()).map((a) => this.toView(a));
  }

  async get(id: string): Promise<Account> {
    const account = (await this.listRaw()).find((a) => a.id === id);
    if (!account) throw notFound(`No account "${id}".`);
    return account;
  }

  async publish(): Promise<void> {
    this.broadcaster.accountsUpdated(await this.list());
  }

  /**
   * Local accounts get their own CLI config folder. A remote account (host set) runs on that SSH
   * host with the server's own login, so there is one per CLI per host and no folder here.
   */
  async create(label: string, provider: ProviderId, host: string | null = null): Promise<AccountView> {
    const parsed = AccountLabel.safeParse(label);
    if (!parsed.success) throw badRequest(`Invalid label: ${parsed.error.issues[0]?.message}`);
    if (host) {
      try {
        assertHost(host);
      } catch (e) {
        throw badRequest((e as Error).message);
      }
    }
    const accounts = await this.listRaw();
    if (accounts.some((a) => a.id === label)) throw conflict(`An account named "${label}" already exists.`);
    const cli = provider === "claude-code" ? "Claude Code" : "Cursor";
    if (host && accounts.some((a) => a.host === host && a.provider === provider)) {
      throw conflict(`${host} already has a ${cli} account. It uses the server's own login, so one is enough.`);
    }
    if (!host && provider === "cursor-agent" && accounts.some((a) => !a.host && a.provider === "cursor-agent")) {
      throw conflict(
        "Only one Cursor account is supported on this Mac: the Cursor CLI keeps its login in the macOS Keychain under a fixed name, so a second account would share the same login.",
      );
    }

    let configDir = "";
    if (!host) {
      const configDirAbs = join(this.stores.paths.cliConfigDir, label);
      await mkdir(configDirAbs, { recursive: true });
      // Relative to the project when .data is inside it (the normal case), absolute otherwise.
      configDir = relative(PROJECT_ROOT, configDirAbs).startsWith("..") ? configDirAbs : relative(PROJECT_ROOT, configDirAbs);
    }
    const stamp = formatLocalIso(this.now());
    const account: Account = {
      id: label,
      label,
      provider,
      host,
      configDir,
      // On a server, use its own commands (found via ~/.local/bin); servers often only have the
      // older `cursor-agent` name. Settings' binary is a path on this Mac, so it isn't used there.
      binary: host ? (provider === "cursor-agent" ? "cursor-agent" : "claude") : null,
      status: "unknown",
      limitedUntil: null,
      lastLimitReason: null,
      mcpConfigPath: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.stores.accounts.update((file) => {
      file.accounts.push(account);
    });
    await this.publish();
    void this.checkAuth(account.id).catch(() => undefined); // shows "logged out" right away instead of "unknown"
    return this.toView(account);
  }

  async reorder(ids: string[]): Promise<void> {
    await this.stores.accounts.update((file) => {
      const rank = new Map(ids.map((id, i) => [id, i]));
      file.accounts.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    });
    await this.publish();
  }

  /** Log the CLI out for that config dir, delete the dir, and drop the account everywhere. */
  async remove(id: string): Promise<void> {
    const account = await this.get(id);
    const settings = await this.stores.settings.read();
    const adapter = this.adapters[account.provider];
    const configDir = this.configDirOf(account);
    // Remote accounts use the server's own login: removing one from the app never logs the server out.
    if (configDir) {
      await runToCompletion(adapter.logoutCommand(this.context(account), settings), 20000);
      await rm(configDir, { recursive: true, force: true });
    }

    this.authInfo.delete(id);
    await this.stores.accounts.update((file) => {
      file.accounts = file.accounts.filter((a) => a.id !== id);
    });
    await this.stores.repos.update((file) => {
      for (const repo of file.repos) repo.accountChain = repo.accountChain.filter((a) => a !== id);
    });
    await this.stores.queue.update((file) => {
      for (const task of file.tasks) if (task.accountOverride === id) task.accountOverride = null;
    });
    await this.publish();
  }

  private async patch(id: string, change: (a: Account) => void): Promise<AccountView> {
    let updated: Account | undefined;
    await this.stores.accounts.update((file) => {
      updated = file.accounts.find((a) => a.id === id);
      if (!updated) throw notFound(`No account "${id}".`);
      change(updated);
      updated.updatedAt = formatLocalIso(this.now());
    });
    await this.publish();
    return this.toView(updated as Account);
  }

  async checkAuth(id: string): Promise<AccountView> {
    const account = await this.get(id);
    const settings = await this.stores.settings.read();
    const info = await this.adapters[account.provider].checkAuth(this.context(account), settings);
    const state = info.state;
    if (state === "logged-in") this.authInfo.set(id, { email: info.email, plan: info.plan });
    else if (state === "logged-out") this.authInfo.delete(id);
    return this.patch(id, (a) => {
      if (state === "logged-out") a.status = "logged-out";
      else if (state === "logged-in") a.status = effectiveStatus(a, this.now()) === "limited" ? "limited" : "available";
      else if (a.status !== "limited") a.status = "unknown";
    });
  }

  /** Refresh every account's login status (on startup). Never throws. */
  async checkAll(): Promise<void> {
    await Promise.all((await this.listRaw()).map((a) => this.checkAuth(a.id).catch(() => undefined)));
  }

  async markLimited(id: string, resetsAt: string | null, reason: string): Promise<AccountView> {
    const settings = await this.stores.settings.read();
    const fallback = new Date(this.now().getTime() + settings.limitCooldownMinutes * 60_000);
    const until = resetsAt && new Date(resetsAt) > this.now() ? resetsAt : formatLocalIso(fallback);
    return this.patch(id, (a) => {
      a.status = "limited";
      a.limitedUntil = until;
      a.lastLimitReason = reason;
    });
  }

  async markLoggedOut(id: string): Promise<AccountView> {
    return this.patch(id, (a) => {
      a.status = "logged-out";
    });
  }

  async clearLimit(id: string): Promise<AccountView> {
    return this.patch(id, (a) => {
      a.status = "available";
      a.limitedUntil = null;
    });
  }

  /** Persist expired limits as available so accounts.json reads truthfully. */
  async expireLimits(): Promise<void> {
    const now = this.now();
    const expired = (await this.listRaw()).filter(
      (a) => a.status === "limited" && (!a.limitedUntil || new Date(a.limitedUntil) <= now),
    );
    if (expired.length === 0) return;
    await this.stores.accounts.update((file) => {
      for (const a of file.accounts) {
        if (expired.some((e) => e.id === a.id)) {
          a.status = "available";
          a.limitedUntil = null;
          a.updatedAt = formatLocalIso(now);
        }
      }
    });
    await this.publish();
  }
}
