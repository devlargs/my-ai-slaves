import { ArrowRightLeftIcon, CircleCheckIcon, PlayIcon, TimerResetIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion, useInView, usePageVisible } from "../hooks";

/**
 * A small, honest simulation of what the app does: tasks drain from the queue onto the first free
 * account in the repo's chain; when that account's usage runs out, the run moves to the next one.
 * Runs only while it's on screen and the tab is visible.
 */

const CHAIN = ["work-max", "personal-pro", "side-max"] as const;
type AccountId = (typeof CHAIN)[number];

const POOL: [string, string][] = [
  ["Fix the crash when the cart is empty", "mobile-app"],
  ["Retry failed webhooks with backoff", "payments-api"],
  ["Add a dark mode toggle to the header", "storefront"],
  ["Write Playwright tests for checkout", "storefront"],
  ["Rate-limit the public endpoints", "payments-api"],
  ["Paginate the orders list", "mobile-app"],
  ["Migrate forms to the new validator", "storefront"],
  ["Rotate webhook signing secrets", "payments-api"],
  ["Deep links into product pages", "mobile-app"],
  ["Lazy-load the reviews widget", "storefront"],
];

type Status = "pending" | "running" | "review" | "done";
interface Task {
  key: number;
  title: string;
  repo: string;
  status: Status;
  account: AccountId | null;
  from: AccountId | null;
  left: number;
  age: number;
}
interface Account {
  id: AccountId;
  usage: number;
  limitedFor: number;
}
interface Ev {
  key: number;
  text: string;
  kind: "start" | "fallback" | "review" | "free";
}
interface State {
  n: number;
  next: number;
  tasks: Task[];
  accounts: Account[];
  log: Ev;
}

function initial(): State {
  const tasks = POOL.slice(0, 4).map(
    ([title, repo], i): Task => ({ key: i, title, repo, status: "pending", account: null, from: null, left: 4 + (i % 2), age: 0 }),
  );
  return {
    n: 0,
    next: 4,
    tasks,
    accounts: [
      { id: "work-max", usage: 58, limitedFor: 0 },
      { id: "personal-pro", usage: 22, limitedFor: 0 },
      { id: "side-max", usage: 8, limitedFor: 0 },
    ],
    log: { key: 0, text: "4 tasks queued · chain: work-max → personal-pro → side-max", kind: "start" },
  };
}

function step(prev: State): State {
  const n = prev.n + 1;
  const jitter = (k: number) => ((n * 7919 + k * 104729) % 9) - 4;
  const accounts = prev.accounts.map((a) => ({ ...a }));
  let tasks = prev.tasks.map((t) => ({ ...t, age: t.age + 1 }));
  let log = prev.log;
  const say = (text: string, kind: Ev["kind"]) => {
    log = { key: n, text, kind };
  };
  const acct = (id: AccountId) => accounts.find((a) => a.id === id) as Account;
  const free = () => CHAIN.find((id) => acct(id).limitedFor === 0) ?? null;

  // limits wear off
  for (const a of accounts) {
    if (a.limitedFor > 0) {
      a.limitedFor -= 1;
      if (a.limitedFor === 0) {
        a.usage = 4;
        say(`${a.id}'s limit reset: back in the chain`, "free");
      }
    } else if (a.usage > 0 && !tasks.some((t) => t.status === "running" && t.account === a.id)) {
      a.usage = Math.max(0, a.usage - 1);
    }
  }

  const running = tasks.find((t) => t.status === "running");
  if (running?.account) {
    const a = acct(running.account);
    a.usage = Math.min(100, a.usage + 13 + jitter(1));
    if (a.usage >= 100) {
      a.limitedFor = 9;
      const next = free();
      if (next) {
        say(`${a.id} hit its usage limit → ${next} picks up the run`, "fallback");
        running.from = running.account;
        running.account = next;
      } else {
        say(`${a.id} hit its usage limit · every account is busy, the task waits`, "fallback");
        running.status = "pending";
        running.account = null;
      }
    } else {
      running.left -= 1;
      if (running.left <= 0) {
        running.status = "review";
        running.age = 0;
        say(`Ready for review: ${running.title}`, "review");
      }
    }
  } else {
    const pending = tasks.find((t) => t.status === "pending");
    const to = free();
    if (pending && to) {
      pending.status = "running";
      pending.account = to;
      pending.age = 0;
      say(`Started “${pending.title}” on ${to}`, "start");
    }
  }

  // reviewed work leaves; new work arrives
  for (const t of tasks) if (t.status === "review" && t.age > 4) t.status = "done";
  tasks = tasks.filter((t) => !(t.status === "done" && t.age > 6));
  let next = prev.next;
  while (tasks.filter((t) => t.status !== "done").length < 5) {
    const [title, repo] = POOL[next % POOL.length] as [string, string];
    tasks.push({ key: next, title, repo, status: "pending", account: null, from: null, left: 4 + (next % 3), age: 0 });
    next += 1;
  }
  tasks = tasks.filter((t) => t.status !== "done");
  return { n, next, tasks, accounts, log };
}

const TICK_MS = 1150;

export function QueueSim({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const visible = usePageVisible();
  const [state, setState] = useState<State>(() => {
    // Reduced motion: a still frame that still tells the story (one fallback already happened).
    if (!prefersReducedMotion()) return initial();
    let s = initial();
    for (let i = 0; i < 60 && s.log.kind !== "fallback"; i++) s = step(s);
    return s;
  });

  useEffect(() => {
    if (!inView || !visible || prefersReducedMotion()) return;
    const id = window.setInterval(() => setState(step), TICK_MS);
    return () => window.clearInterval(id);
  }, [inView, visible]);

  const runningOn = state.tasks.find((t) => t.status === "running")?.account ?? null;
  const shown = state.tasks.slice(0, 5);
  const counts = {
    running: state.tasks.filter((t) => t.status === "running").length,
    pending: state.tasks.filter((t) => t.status === "pending").length,
  };

  return (
    <div ref={ref} className={`sim ${className ?? ""}`} role="img" aria-label="Animated example: queued tasks run on one subscription, and move to the next when it hits its usage limit">
      <div className="sim-bar" aria-hidden="true">
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
        <span className="title">My AI Slaves · Queue</span>
      </div>
      <div className="sim-body" aria-hidden="true">
        <div className="sim-section">
          <div className="sim-head">
            <span className="label">Queue</span>
            <span className="label num">
              {counts.running} running · {counts.pending} waiting
            </span>
          </div>
          <div className="sim-tasks">
            {shown.map((t) => (
              <div key={t.key} className={`sim-task ${t.status}`}>
                <span className="t">{t.title}</span>
                <StatusPill status={t.status} />
                <span className="m">
                  {t.repo}
                  {t.account ? ` · ${t.account}` : ""}
                  {t.from && t.status === "running" ? ` · fell back from ${t.from}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="sim-section">
          <div className="sim-head">
            <span className="label">Account chain</span>
            <span className="label">usage</span>
          </div>
          <div className="sim-accounts">
            {state.accounts.map((a) => {
              const limited = a.limitedFor > 0;
              const running = !limited && runningOn === a.id;
              return (
                <div key={a.id} className={`acct ${limited ? "is-limited" : running ? "is-running" : ""}`}>
                  <span className="name">
                    <span className={`dot ${running ? "dot-live" : ""}`} />
                    {a.id}
                  </span>
                  <span className="meter">
                    <i style={{ width: `${Math.max(3, a.usage)}%` }} />
                  </span>
                  <span className="state num">{limited ? `limited · resets soon` : running ? "running" : "available"}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className={`sim-log ${state.log.kind === "fallback" ? "is-fallback" : ""}`} aria-live="off">
        <LogIcon kind={state.log.kind} />
        <span key={state.log.key} className="ev">
          {state.log.text}
        </span>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  if (status === "running")
    return (
      <span className="pill pill-run">
        <span className="dot dot-live" />
        running
      </span>
    );
  if (status === "review") return <span className="pill pill-review">review</span>;
  if (status === "done") return <span className="pill pill-done">done</span>;
  return <span className="pill">pending</span>;
}

function LogIcon({ kind }: { kind: Ev["kind"] }) {
  if (kind === "fallback") return <ArrowRightLeftIcon />;
  if (kind === "review") return <CircleCheckIcon />;
  if (kind === "free") return <TimerResetIcon />;
  return <PlayIcon />;
}
