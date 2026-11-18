import type { Account, AccountStatus, ProviderId } from "@my-ai-slaves/shared";

/** Status as of `now`: a limit whose time has passed reads as available. */
export function effectiveStatus(account: Account, now: Date): AccountStatus {
  if (account.limitedUntil && new Date(account.limitedUntil) > now) return "limited";
  if (account.status === "limited") return "available";
  return account.status;
}

export type PickResult =
  | { kind: "account"; account: Account }
  | { kind: "wait"; until: string | null; reason: string };

export interface PickArgs {
  /** Ordered account ids to try (override first, then the repo's chain). */
  candidates: string[];
  accounts: Account[];
  now: Date;
  /** Only accounts of this provider (resuming a session). */
  provider?: ProviderId;
  exclude?: ReadonlySet<string>;
}

/** First usable account in order; otherwise when to look again and why. */
export function pickAccount({ candidates, accounts, now, provider, exclude }: PickArgs): PickResult {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  let earliest: string | null = null;
  const skipped: string[] = [];

  for (const id of new Set(candidates)) {
    const account = byId.get(id);
    if (!account) {
      skipped.push(`${id} (deleted)`);
      continue;
    }
    if (exclude?.has(id)) continue;
    if (provider && account.provider !== provider) {
      skipped.push(`${id} (different CLI than the session)`);
      continue;
    }
    const status = effectiveStatus(account, now);
    if (status === "logged-out") {
      skipped.push(`${id} (logged out)`);
      continue;
    }
    if (status === "limited") {
      skipped.push(`${id} (limited)`);
      if (account.limitedUntil && (!earliest || account.limitedUntil < earliest)) earliest = account.limitedUntil;
      continue;
    }
    return { kind: "account", account };
  }

  if (candidates.length === 0) {
    return { kind: "wait", until: null, reason: "No accounts in this repo's chain. Add some on the Repos page." };
  }
  return {
    kind: "wait",
    until: earliest,
    reason: `No account available: ${skipped.join(", ") || "none usable"}.`,
  };
}
