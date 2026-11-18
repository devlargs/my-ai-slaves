import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoginState } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { LoginService, plainText } from "../src/login/login-service";
import { createAdapters } from "../src/providers";
import { AccountService } from "../src/services/account-service";
import { nullBroadcaster } from "../src/services/common";
import { openDataStores } from "../src/storage/data-stores";
import { memoryLogger, tempDir } from "./helpers";

const fixtures = resolve(fileURLToPath(new URL("./fixtures", import.meta.url)));

async function setup() {
  await chmod(join(fixtures, "fake-claude.mjs"), 0o755);
  await chmod(join(fixtures, "fake-cursor.mjs"), 0o755);
  const dir = await tempDir();
  const { stores } = await openDataStores({ dataDir: join(dir, "data"), logger: memoryLogger() });
  await stores.settings.update((s) => {
    s.providers["claude-code"].binary = join(fixtures, "fake-claude.mjs");
    s.providers["cursor-agent"].binary = join(fixtures, "fake-cursor.mjs");
  });
  const adapters = createAdapters();
  const accounts = new AccountService(stores, adapters, nullBroadcaster);
  const updates: LoginState[] = [];
  const loggedIn: string[] = [];
  const logins = new LoginService(stores, accounts, adapters, {
    loginUpdated: (s) => updates.push(s),
    onLoggedIn: (id) => loggedIn.push(id),
  });
  return { accounts, logins, updates, loggedIn };
}

async function waitForState(logins: LoginService, id: string, check: (s: LoginState) => boolean): Promise<LoginState> {
  const start = Date.now();
  for (;;) {
    const s = logins.get(id);
    if (check(s)) return s;
    if (Date.now() - start > 8000) throw new Error(`timed out; last state: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("plainText", () => {
  it("strips hyperlinks, colours and carriage returns", () => {
    const raw = "visit: \u001b]8;;https://x.y/a?b=1\u0007\u001b[94mhttps://x.y/a?b=1\u001b[39m\u001b]8;;\u0007\r\nnext";
    expect(plainText(raw)).toBe("visit: https://x.y/a?b=1\nnext");
  });
});

describe("LoginService", () => {
  it("never reports a link cut off mid-chunk", async () => {
    const { accounts, logins } = await setup();
    await accounts.create("new-claude", "claude-code");
    const started = await logins.start("new-claude");
    const session = (logins as any).sessions.get(started.loginId);
    (logins as any).onOutput(session, "visit: https://claude.com/cai/oauth/authorize?code=true&sta");
    expect(logins.get(started.loginId).url).toBeNull();
    (logins as any).onOutput(session, "te=abc\r\nPaste code here if prompted > ");
    expect(logins.get(started.loginId).url).toBe("https://claude.com/cai/oauth/authorize?code=true&state=abc");
    logins.cancel(started.loginId);
  });

  it("Claude: the browser sign-in finishes by itself and reports the account", async () => {
    const { accounts, logins } = await setup();
    await accounts.create("new-auto-claude", "claude-code");
    const started = await logins.start("new-auto-claude");
    const done = await waitForState(logins, started.loginId, (s) => s.status === "success");
    expect(done.message).toBe("Logged in as new-auto-claude@example.com.");
    const view = (await accounts.list()).find((a) => a.id === "new-auto-claude");
    expect(view).toMatchObject({ status: "available", email: "new-auto-claude@example.com", plan: "max" });
  });

  it("Claude fallback: a pasted code works too, and a wrong one is reported", async () => {
    const { accounts, logins, loggedIn } = await setup();
    await accounts.create("new-claude", "claude-code");
    expect((await accounts.checkAuth("new-claude")).status).toBe("logged-out");

    const started = await logins.start("new-claude");
    const waiting = await waitForState(logins, started.loginId, (s) => s.status === "open-url");
    expect(waiting.url).toBe("https://claude.com/cai/oauth/authorize?code=true&state=abc");
    expect(waiting.acceptsCode).toBe(true);

    logins.submitCode(started.loginId, "bad");
    const retry = await waitForState(logins, started.loginId, (s) => s.status === "open-url" && !!s.message?.includes("didn't work"));
    expect(retry.message).toContain("Invalid code");

    logins.submitCode(started.loginId, "good");
    await waitForState(logins, started.loginId, (s) => s.status === "success");
    expect((await accounts.list()).find((a) => a.id === "new-claude")?.status).toBe("available");
    expect(loggedIn).toEqual(["new-claude"]);
  });

  it("Cursor: shows the link and finishes by itself", async () => {
    const { accounts, logins } = await setup();
    await accounts.create("work-cursor", "cursor-agent");
    const started = await logins.start("work-cursor");
    const done = await waitForState(logins, started.loginId, (s) => s.status === "success");
    expect(done.url).toBe("https://cursor.com/loginDeepControl?challenge=x&mode=login");
    expect(done.acceptsCode).toBe(false);
    expect((await accounts.list())[0]).toMatchObject({ email: "test@example.com", plan: "Team: Acme" });
  });

  it("cancel stops the login", async () => {
    const { accounts, logins } = await setup();
    await accounts.create("new-claude", "claude-code");
    const started = await logins.start("new-claude");
    await waitForState(logins, started.loginId, (s) => s.status === "open-url");
    expect(logins.cancel(started.loginId).status).toBe("cancelled");
    expect(() => logins.submitCode(started.loginId, "good")).toThrow();
  });
});
