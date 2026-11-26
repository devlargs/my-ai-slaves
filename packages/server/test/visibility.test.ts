import type { HistoryItem, UsageRecord } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { chatHidden, type Hidden, hiddenRepoOf, mergeChain, reorderWithin, shownHistory, shownTask, shownUsage } from "../src/services/visibility";

const hidden: Hidden = { repos: new Set(["personal"]), accounts: new Set(["me-claude"]) };
const none: Hidden = { repos: new Set(), accounts: new Set() };

describe("visibility", () => {
  it("a task is hidden when its main repo or any of its other repos is", () => {
    expect(hiddenRepoOf({ repo: "company", extraRepos: [] }, hidden)).toBeNull();
    expect(hiddenRepoOf({ repo: "personal", extraRepos: [] }, hidden)).toBe("personal");
    expect(hiddenRepoOf({ repo: "company", extraRepos: [{ repo: "personal", promptIds: [] }] }, hidden)).toBe("personal");
    expect(hiddenRepoOf({ repo: "personal", extraRepos: [] }, none)).toBeNull();
  });

  it("blanks a hidden subscription's name on a shown task", () => {
    const task = { currentAccount: "me-claude", accountOverride: "work-claude", session: { provider: "claude-code" as const, account: "me-claude", sessionId: "s" } };
    expect(shownTask(task, hidden)).toEqual({ currentAccount: null, accountOverride: "work-claude", session: { provider: "claude-code", account: "", sessionId: "s" } });
    expect(shownTask(task, none)).toBe(task);
  });

  it("hides a chat with its repo or its subscription", () => {
    const chat = { repo: null, accountOverride: null, currentAccount: null, session: null };
    expect(chatHidden(chat, hidden)).toBe(false);
    expect(chatHidden({ ...chat, repo: "personal" }, hidden)).toBe(true);
    expect(chatHidden({ ...chat, accountOverride: "me-claude" }, hidden)).toBe(true);
    expect(chatHidden({ ...chat, session: { provider: "claude-code", account: "me-claude", sessionId: "s" } }, hidden)).toBe(true);
  });

  it("filters history and usage", () => {
    const item = (repo: string, lastAccount: string | null) => ({ taskId: `${repo}-${lastAccount}`, repo, lastAccount }) as HistoryItem;
    expect(shownHistory([item("personal", "work-claude"), item("company", "me-claude"), item("company", "work-claude")], hidden)).toEqual([
      { ...item("company", "me-claude"), lastAccount: null },
      item("company", "work-claude"),
    ]);
    const use = (repo: string, account: string) => ({ repo, account }) as UsageRecord;
    expect(shownUsage([use("personal", "work-claude"), use("company", "me-claude"), use("company", "work-claude")], hidden)).toEqual([
      use("company", "work-claude"),
    ]);
  });

  it("reorders only the listed items, in the places they hold", () => {
    expect(reorderWithin(["a", "H", "b", "c"], ["c", "a", "b"], (x) => x)).toEqual(["c", "H", "a", "b"]);
  });

  it("keeps hidden accounts in place when a chain is edited", () => {
    const hiddenAccounts = new Set(["H"]);
    expect(mergeChain(["a", "H", "b"], ["b", "a"], hiddenAccounts)).toEqual(["b", "H", "a"]);
    expect(mergeChain(["a", "H", "b"], [], hiddenAccounts)).toEqual(["H"]);
    expect(mergeChain(["H"], ["a", "b", "a"], hiddenAccounts)).toEqual(["H", "a", "b"]);
  });
});
