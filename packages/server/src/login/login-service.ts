import { randomUUID } from "node:crypto";
import type { LoginState, LoginStatus } from "@my-ai-slaves/shared";
import { type IPty, spawn } from "node-pty";
import type { AdapterRegistry } from "../providers";
import type { AccountService } from "../services/account-service";
import { conflict, notFound } from "../services/common";
import type { DataStores } from "../storage/data-stores";

const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g; // e.g. hyperlinks
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g; // colours, cursor moves
const ESC = /\u001b[@-Z\\-_]/g;
const URL_RE = /https:\/\/[^\s"'<>]+/;
const CODE_PROMPT = /paste code/gi;
const CODE_PROMPT_LINE = /paste code/i;

const OUTPUT_TAIL = 6000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const VERIFY_POLL_MS = 2000;
const VERIFY_POLL_LIMIT_MS = 60_000;
const FORGET_AFTER_MS = 10 * 60_000;

export function plainText(raw: string): string {
  return raw.replace(OSC, "").replace(CSI, "").replace(ESC, "").replace(/\r\n?/g, "\n");
}

const isFinal = (status: LoginStatus) => status === "success" || status === "failed" || status === "cancelled";

interface Session {
  state: LoginState;
  pty: IPty;
  alive: boolean;
  raw: string;
  promptsAtSubmit: number | null;
  timers: NodeJS.Timeout[];
}

export interface LoginEvents {
  loginUpdated(state: LoginState): void;
  /** Called after a successful login (e.g. to wake the queue). */
  onLoggedIn?(accountId: string): void;
}

/**
 * Logs accounts in from the app, like running the CLI's login yourself: the CLI (in a hidden
 * pseudo-terminal) opens your browser, you sign in on the provider's site, and its local callback
 * completes the login. We pick out the link (to re-open it) and, for Claude, can pass back a pasted code.
 * Credentials end up in the account's own config dir / Keychain entry, never in our files.
 */
export class LoginService {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly stores: DataStores,
    private readonly accounts: AccountService,
    private readonly adapters: AdapterRegistry,
    private readonly events: LoginEvents,
  ) {}

  get(loginId: string): LoginState {
    const session = this.sessions.get(loginId);
    if (!session) throw notFound("That login session has ended. Start a new one.");
    return session.state;
  }

  async start(accountId: string): Promise<LoginState> {
    const account = await this.accounts.get(accountId);
    for (const s of this.sessions.values()) {
      if (s.state.accountId === accountId && !isFinal(s.state.status)) this.finish(s, "cancelled", "Replaced by a new login.");
    }

    const settings = await this.stores.settings.read();
    const spec = this.adapters[account.provider].loginCommand(this.accounts.context(account), settings);
    const pty = spawn(spec.command, spec.args, {
      name: "xterm-256color",
      cols: 500, // wide, so long sign-in links are never wrapped
      rows: 50,
      cwd: spec.cwd,
      env: spec.env,
    });

    const session: Session = {
      state: {
        loginId: randomUUID(),
        accountId,
        provider: account.provider,
        status: "starting",
        url: null,
        acceptsCode: account.provider === "claude-code",
        message: "Starting the login…",
        email: null,
        output: "",
      },
      pty,
      alive: true,
      raw: "",
      promptsAtSubmit: null,
      timers: [],
    };
    this.sessions.set(session.state.loginId, session);

    pty.onData((data) => this.onOutput(session, data));
    pty.onExit(({ exitCode }) => {
      session.alive = false;
      void this.onExit(session, exitCode);
    });
    session.timers.push(setTimeout(() => this.finish(session, "failed", "Timed out. Start the login again."), LOGIN_TIMEOUT_MS));

    this.publish(session);
    return session.state;
  }

  submitCode(loginId: string, code: string): LoginState {
    const session = this.sessions.get(loginId);
    if (!session) throw notFound("That login session has ended. Start a new one.");
    if (!session.state.acceptsCode || session.state.status !== "open-url" || !session.alive) {
      throw conflict("This login isn't waiting for a code.");
    }
    const trimmed = code.trim();
    if (!trimmed) throw conflict("Paste the code shown on the sign-in page.");

    session.promptsAtSubmit = this.countPrompts(session);
    session.pty.write(`${trimmed}\r`);
    this.update(session, { status: "verifying", message: "Checking the code…" });
    this.pollUntilLoggedIn(session);
    return session.state;
  }

  cancel(loginId: string): LoginState {
    const session = this.sessions.get(loginId);
    if (!session) throw notFound("That login session has ended.");
    if (!isFinal(session.state.status)) this.finish(session, "cancelled", "Login cancelled.");
    return session.state;
  }

  closeAll(): void {
    for (const s of this.sessions.values()) if (!isFinal(s.state.status)) this.finish(s, "cancelled", "Server stopped.");
  }

  // ── internals ────────────────────────────────────────────────────────────

  private countPrompts(session: Session): number {
    return plainText(session.raw).match(CODE_PROMPT)?.length ?? 0;
  }

  private onOutput(session: Session, data: string): void {
    session.raw = (session.raw + data).slice(-100_000);
    if (isFinal(session.state.status)) return;
    const text = plainText(session.raw);
    // Only look at complete lines: output arrives in chunks and a link can be cut mid-way.
    const completeLines = text.slice(0, text.lastIndexOf("\n") + 1);
    const url = URL_RE.exec(completeLines)?.[0] ?? session.state.url;
    const prompts = this.countPrompts(session);
    const output = text.slice(-OUTPUT_TAIL);

    if (session.state.status === "verifying" && session.promptsAtSubmit !== null && prompts > session.promptsAtSubmit) {
      // Asked for the code again: the one we sent was rejected.
      const lastLines = text.trim().split("\n").filter((l) => l.trim() && !CODE_PROMPT_LINE.test(l)).slice(-2).join(" ");
      session.promptsAtSubmit = null;
      this.update(session, { status: "open-url", url, output, message: `That code didn't work. ${lastLines}`.trim() });
      return;
    }
    if (session.state.status === "starting" && url) {
      this.update(session, {
        status: "open-url",
        url,
        output,
        message: "A sign-in page opened in your browser. Sign in there; this finishes by itself.",
      });
      return;
    }
    this.update(session, { url, output });
  }

  private async onExit(session: Session, exitCode: number): Promise<void> {
    if (isFinal(session.state.status)) return;
    this.update(session, { status: "verifying", message: "Checking the login…" });
    if (await this.isLoggedIn(session)) {
      this.finish(session, "success", session.state.email ? `Logged in as ${session.state.email}.` : "Logged in.");
      return;
    }
    const tail = plainText(session.raw)
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .slice(-3)
      .join(" ");
    this.finish(session, "failed", tail || `The login command exited with code ${exitCode}.`);
  }

  /** After a code is pasted, don't depend on the CLI exiting: check the login every few seconds. */
  private pollUntilLoggedIn(session: Session): void {
    const startedAt = Date.now();
    const tick = async () => {
      if (isFinal(session.state.status) || session.state.status !== "verifying") return;
      if (await this.isLoggedIn(session)) {
        this.finish(session, "success", session.state.email ? `Logged in as ${session.state.email}.` : "Logged in.");
        return;
      }
      if (Date.now() - startedAt < VERIFY_POLL_LIMIT_MS) session.timers.push(setTimeout(() => void tick(), VERIFY_POLL_MS));
    };
    session.timers.push(setTimeout(() => void tick(), VERIFY_POLL_MS));
  }

  private async isLoggedIn(session: Session): Promise<boolean> {
    try {
      const view = await this.accounts.checkAuth(session.state.accountId); // also saves + broadcasts the status
      const ok = view.status !== "logged-out" && view.status !== "unknown";
      if (ok) session.state = { ...session.state, email: view.email };
      return ok;
    } catch {
      return false;
    }
  }

  private finish(session: Session, status: LoginStatus, message: string): void {
    for (const t of session.timers) clearTimeout(t);
    session.timers = [];
    if (session.alive) {
      session.alive = false;
      try {
        session.pty.kill();
      } catch {
        // already gone
      }
    }
    this.update(session, { status, message });
    if (status === "success") this.events.onLoggedIn?.(session.state.accountId);
    setTimeout(() => this.sessions.delete(session.state.loginId), FORGET_AFTER_MS).unref();
  }

  private update(session: Session, patch: Partial<LoginState>): void {
    session.state = { ...session.state, ...patch };
    this.publish(session);
  }

  private publish(session: Session): void {
    this.events.loginUpdated(session.state);
  }
}
