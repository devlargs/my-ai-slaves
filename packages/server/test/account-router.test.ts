import type { Account } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { effectiveStatus, pickAccount } from "../src/services/account-router";

const now = new Date("2026-11-18T18:00:00+08:00");
const acct = (id: string, extra: Partial<Account> = {}): Account => ({
  id,
  label: id,
  provider: id.includes("cursor") ? "cursor-agent" : "claude-code",
  host: null,
  configDir: `.data/cli-config/${id}`,
  binary: null,
  status: "available",
  limitedUntil: null,
  lastLimitReason: null,
  mcpConfigPath: null,
  createdAt: "2026-11-18T17:00:00+08:00",
  updatedAt: "2026-11-18T17:00:00+08:00",
  ...extra,
});
const limited = (until: string) => ({ status: "limited" as const, limitedUntil: until });

describe("pickAccount", () => {
  const accounts = [acct("work_1-claude"), acct("work_2-cursor"), acct("personal-claude")];
  const chain = ["work_1-claude", "work_2-cursor", "personal-claude"];

  it("takes the first account in chain order", () => {
    const r = pickAccount({ candidates: chain, accounts, now });
    expect(r).toMatchObject({ kind: "account", account: { id: "work_1-claude" } });
  });

  it("falls through limited and logged-out accounts", () => {
    const r = pickAccount({
      candidates: chain,
      accounts: [acct("work_1-claude", limited("2026-11-18T19:00:00+08:00")), acct("work_2-cursor", { status: "logged-out" }), acct("personal-claude")],
      now,
    });
    expect(r).toMatchObject({ kind: "account", account: { id: "personal-claude" } });
  });

  it("an expired limit counts as available", () => {
    const a = acct("work_1-claude", limited("2026-11-18T17:59:00+08:00"));
    expect(effectiveStatus(a, now)).toBe("available");
    expect(pickAccount({ candidates: chain, accounts: [a], now })).toMatchObject({ kind: "account" });
  });

  it("waits until the earliest limit when all are limited", () => {
    const r = pickAccount({
      candidates: chain,
      accounts: [
        acct("work_1-claude", limited("2026-11-18T21:00:00+08:00")),
        acct("work_2-cursor", limited("2026-11-18T19:30:00+08:00")),
        acct("personal-claude", { status: "logged-out" }),
      ],
      now,
    });
    expect(r).toMatchObject({ kind: "wait", until: "2026-11-18T19:30:00+08:00" });
  });

  it("override goes first", () => {
    const r = pickAccount({ candidates: ["personal-claude", ...chain], accounts, now });
    expect(r).toMatchObject({ kind: "account", account: { id: "personal-claude" } });
  });

  it("can be restricted to one provider (resuming a session)", () => {
    const r = pickAccount({
      candidates: chain,
      accounts: [acct("work_1-claude", limited("2026-11-18T21:00:00+08:00")), acct("work_2-cursor"), acct("personal-claude")],
      now,
      provider: "claude-code",
    });
    expect(r).toMatchObject({ kind: "account", account: { id: "personal-claude" } });
  });

  it("only picks accounts on the repo's machine", () => {
    const r = pickAccount({
      candidates: ["work_1-claude", "dev-claude"],
      accounts: [acct("work_1-claude"), acct("dev-claude", { host: "dev" })],
      now,
      host: "dev",
    });
    expect(r).toMatchObject({ kind: "account", account: { id: "dev-claude" } });
  });

  it("empty chain explains itself", () => {
    expect(pickAccount({ candidates: [], accounts, now })).toMatchObject({ kind: "wait", until: null });
  });
});
