import type { AskChat, HistoryItem, Task, UsageRecord, Visibility } from "@my-ai-slaves/shared";
import type { DataStores } from "../storage/data-stores";

/**
 * What Settings → Security hides. A hidden repo or subscription is left out of everything the app
 * shows (lists, pickers, tasks, chats, history, usage); only the Security pane lists them.
 * Hidden subscriptions are also skipped by every account chain, and a hidden repo's queued tasks wait.
 * Nothing is logged out or deleted.
 */
export interface Hidden {
  repos: ReadonlySet<string>;
  accounts: ReadonlySet<string>;
}

export async function readHidden(stores: DataStores): Promise<Hidden> {
  const [{ repos }, { accounts }] = await Promise.all([stores.repos.read(), stores.accounts.read()]);
  return {
    repos: new Set(repos.filter((r) => r.hidden).map((r) => r.id)),
    accounts: new Set(accounts.filter((a) => a.hidden).map((a) => a.id)),
  };
}

export async function readVisibility(stores: DataStores): Promise<Visibility> {
  const [{ repos }, { accounts }] = await Promise.all([stores.repos.read(), stores.accounts.read()]);
  return {
    repos: repos.map((r) => ({ id: r.id, name: r.name, host: r.host ?? null, hidden: r.hidden })),
    accounts: accounts.map((a) => ({ id: a.id, provider: a.provider, host: a.host ?? null, hidden: a.hidden })),
  };
}

/** The first hidden repo a task touches (its main repo or one of its other repos), if any. */
export function hiddenRepoOf(task: Pick<Task, "repo" | "extraRepos">, hidden: Hidden): string | null {
  if (hidden.repos.size === 0) return null;
  return [task.repo, ...task.extraRepos.map((x) => x.repo)].find((id) => hidden.repos.has(id)) ?? null;
}

/** A task as the app may show it: the name of a hidden subscription it used is blanked. */
export function shownTask<T extends Pick<Task, "currentAccount" | "accountOverride" | "session">>(task: T, hidden: Hidden): T {
  if (hidden.accounts.size === 0) return task;
  const gone = (id: string | null | undefined) => !!id && hidden.accounts.has(id);
  if (!gone(task.currentAccount) && !gone(task.accountOverride) && !gone(task.session?.account)) return task;
  return {
    ...task,
    currentAccount: gone(task.currentAccount) ? null : task.currentAccount,
    accountOverride: gone(task.accountOverride) ? null : task.accountOverride,
    session: task.session && gone(task.session.account) ? { ...task.session, account: "" } : task.session,
  };
}

/** A chat is hidden with its repo, and with the subscription it is pinned to or was answered by. */
export function chatHidden(chat: Pick<AskChat, "repo" | "accountOverride" | "currentAccount" | "session">, hidden: Hidden): boolean {
  if (chat.repo && hidden.repos.has(chat.repo)) return true;
  return [chat.accountOverride, chat.currentAccount, chat.session?.account].some((id) => !!id && hidden.accounts.has(id));
}

export function shownHistory(items: HistoryItem[], hidden: Hidden): HistoryItem[] {
  if (hidden.repos.size === 0 && hidden.accounts.size === 0) return items;
  return items
    .filter((item) => !hidden.repos.has(item.repo))
    .map((item) => (item.lastAccount && hidden.accounts.has(item.lastAccount) ? { ...item, lastAccount: null } : item));
}

export function shownUsage(records: UsageRecord[], hidden: Hidden): UsageRecord[] {
  if (hidden.repos.size === 0 && hidden.accounts.size === 0) return records;
  return records.filter((r) => !hidden.repos.has(r.repo) && !hidden.accounts.has(r.account));
}

/**
 * Reorder only the listed items: they take the places they already hold between them, in the new
 * order. Items not listed (hidden ones the page never saw) stay exactly where they are.
 */
export function reorderWithin<T>(items: T[], ids: string[], idOf: (item: T) => string, movable: (item: T) => boolean = () => true): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  const moves = (item: T) => movable(item) && rank.has(idOf(item));
  const sorted = items.filter(moves).sort((a, b) => (rank.get(idOf(a)) as number) - (rank.get(idOf(b)) as number));
  let i = 0;
  return items.map((item) => (moves(item) ? (sorted[i++] as T) : item));
}

/**
 * A repo's chain as the page edited it (hidden subscriptions never reach the page), merged back
 * with the hidden ones it had: each keeps its place.
 */
export function mergeChain(stored: string[], shown: string[], hiddenAccounts: ReadonlySet<string>): string[] {
  const rest = [...new Set(shown)];
  const merged: string[] = [];
  for (const id of stored) {
    if (hiddenAccounts.has(id)) merged.push(id);
    else if (rest.length > 0) merged.push(rest.shift() as string);
  }
  return [...new Set([...merged, ...rest])];
}
