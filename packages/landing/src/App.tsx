import {
  ArrowRightIcon,
  BarChart3Icon,
  CheckIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitGraphIcon,
  LayersIcon,
  ListOrderedIcon,
  LockIcon,
  MessageCircleQuestionIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  SunIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AppleLogo, GitHubLogo, Mark, MarkBars, WindowsLogo } from "./components/brand";
import { QueueSim } from "./components/queue-sim";
import { Showcase, src } from "./components/showcase";
import { FallbackChain, MiniBars, MiniChat, MiniDiff, MiniGraph, MiniTerm, PROMPT_LAYERS, PromptLayers } from "./components/visuals";
import { useRevealAll, useScrollY } from "./hooks";
import { DOWNLOADS, type DownloadKey, detectPlatform, RELEASES_URL, REPO_URL } from "./links";
import { type ThemePref, useTheme } from "./theme";

const delay = (ms: number) => ({ "--delay": `${ms}ms` }) as CSSProperties;

export function App() {
  const { pref, theme, set } = useTheme();
  const platform = useMemo(detectPlatform, []);
  useRevealAll();

  return (
    <>
      <Nav pref={pref} setTheme={set} platform={platform} />
      <main>
        <Hero platform={platform} theme={theme} />
        <Marquee />
        <HowItWorks />
        <Features />
        <section id="screens" className="section showcase">
          <div className="wrap">
            <div className="section-head reveal">
              <span className="label">The app, for real</span>
              <h2 className="h2">Seven screens. Zero babysitting.</h2>
              <p className="lede">
                These are real screenshots of My AI Slaves, running real tasks on demo repos. Click one to see it full size.
              </p>
            </div>
            <div className="reveal" style={delay(80)}>
              <Showcase theme={theme} />
            </div>
          </div>
        </section>
        <PromptSection />
        <Numbers />
        <Faq />
        <FinalCta platform={platform} />
      </main>
      <Footer />
    </>
  );
}

// ── nav ─────────────────────────────────────────────────────────────────────
function Nav({ pref, setTheme, platform }: { pref: ThemePref; setTheme: (p: ThemePref) => void; platform: DownloadKey | null }) {
  const y = useScrollY();
  return (
    <header className={`nav ${y > 8 ? "scrolled" : ""}`}>
      <div className="wrap nav-inner">
        <a className="brand" href="#top" aria-label="My AI Slaves, back to top">
          <Mark size={28} />
          My AI Slaves
        </a>
        <nav className="nav-links" aria-label="Sections">
          <a className="btn btn-ghost" href="#how">
            How it works
          </a>
          <a className="btn btn-ghost" href="#features">
            Features
          </a>
          <a className="btn btn-ghost" href="#screens">
            Screens
          </a>
          <a className="btn btn-ghost" href="#faq">
            FAQ
          </a>
        </nav>
        <ThemeSwitch pref={pref} set={setTheme} />
        <a className="btn btn-ghost hide-xs" href={REPO_URL} aria-label="GitHub repository">
          <GitHubLogo />
        </a>
        <a className="btn btn-ink btn-sm hide-xs" href={platform ? DOWNLOADS[platform].href : "#download"}>
          Download
        </a>
      </div>
    </header>
  );
}

function ThemeSwitch({ pref, set }: { pref: ThemePref; set: (p: ThemePref) => void }) {
  const opts: [ThemePref, string, typeof SunIcon][] = [
    ["system", "Follow the system", MonitorIcon],
    ["light", "Light", SunIcon],
    ["dark", "Dark", MoonIcon],
  ];
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {opts.map(([v, label, Icon]) => (
        <button key={v} type="button" aria-pressed={pref === v} title={label} aria-label={label} onClick={() => set(v)}>
          <Icon />
        </button>
      ))}
    </div>
  );
}

// ── hero ────────────────────────────────────────────────────────────────────
function DownloadButtons({ platform, signal = true }: { platform: DownloadKey | null; signal?: boolean }) {
  const primary: DownloadKey = platform ?? "macArm";
  const secondary: DownloadKey = primary === "windows" ? "macArm" : "windows";
  return (
    <div className="hero-ctas">
      <a className={`btn ${signal ? "btn-signal" : "btn-ink"}`} href={DOWNLOADS[primary].href}>
        {primary === "windows" ? <WindowsLogo /> : <AppleLogo />}
        {DOWNLOADS[primary].short}
      </a>
      <a className="btn btn-outline" href={DOWNLOADS[secondary].href}>
        {secondary === "windows" ? <WindowsLogo /> : <AppleLogo />}
        {secondary === "windows" ? "Windows" : "macOS"}
      </a>
    </div>
  );
}

function Hero({ platform, theme }: { platform: DownloadKey | null; theme: "light" | "dark" }) {
  const stage = useRef<HTMLDivElement>(null);
  // The product shot leans back and straightens up as you scroll toward it (at most once per frame).
  const [tilt, setTilt] = useState(14);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = stage.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const progress = Math.min(1, Math.max(0, 1 - (top - window.innerHeight * 0.25) / (window.innerHeight * 0.75)));
      setTilt(Math.round(140 * (1 - progress)) / 10);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section id="top" className="hero">
      <div className="wrap">
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="label reveal">Claude Code + Cursor · macOS &amp; Windows · free</span>
            <h1 className="display hero-title reveal" style={delay(60)}>
              <span className="line">Queue the work.</span>
              <span className="line">
                Sleep through <span className="strike">the limits</span>.
              </span>
            </h1>
            <p className="lede reveal" style={delay(140)}>
              My AI Slaves lines up your coding tasks and runs them through the Claude Code and Cursor CLIs, right in your repos.
              When one subscription hits its usage limit, the next one picks up the run. You come back to diffs, not to a
              “limit reached” message.
            </p>
            <div className="reveal" style={delay(220)}>
              <DownloadButtons platform={platform} />
            </div>
            <div className="hero-meta reveal" style={delay(280)}>
              <span>
                <CheckIcon /> Open source, MIT
              </span>
              <span>
                <LockIcon /> Runs on 127.0.0.1 only
              </span>
              <span>
                <ShieldCheckIcon /> No hidden prompts
              </span>
            </div>
          </div>
          <div className="reveal" style={delay(200)}>
            <QueueSim />
          </div>
        </div>

        <div className="shot-stage reveal" ref={stage} style={delay(120)}>
          <div className="tilt" style={{ "--tilt": `${tilt}deg`, "--tilt-scale": 0.94 + (0.06 * (14 - tilt)) / 14 } as CSSProperties}>
            <div className="shot-frame">
              <div className="chrome" aria-hidden="true">
                <i />
                <i />
                <i />
                <span>My AI Slaves</span>
              </div>
              <img
                src={src("queue-running", theme)}
                alt="My AI Slaves: the queue on the left, a task running live on the right"
                width={1600}
                height={1000}
                fetchPriority="high"
              />
            </div>
          </div>
          <div className="shot-callouts" aria-hidden="true">
            <span className="callout" style={{ left: "-1%", top: "30%" }}>
              <ListOrderedIcon /> Tasks wait their turn
            </span>
            <span className="callout" style={{ right: "-1%", top: "13%" }}>
              <CheckIcon /> Every prompt layer, checked off
            </span>
            <span className="callout" style={{ right: "6%", top: "64%" }}>
              <FileDiffIcon /> Live edits, reads and commands
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── marquee of real-looking tasks ───────────────────────────────────────────
const TICKER: [string, string][] = [
  ["review", "Add a dark mode toggle to the header"],
  ["running", "Fix the crash when the cart is empty"],
  ["done", "Retry failed webhooks with backoff"],
  ["pending", "Write Playwright tests for checkout"],
  ["done", "Upgrade to Fastify 5"],
  ["review", "Translate checkout to Spanish"],
  ["done", "Keyboard navigation for the mega menu"],
  ["pending", "Rate-limit the public endpoints"],
  ["done", "Speed up the CI typecheck"],
  ["review", "Deep links into product pages"],
  ["done", "Document the refunds API"],
  ["pending", "Seed script for local dev"],
];

function Marquee() {
  const items = [...TICKER, ...TICKER];
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {items.map(([status, title], i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is doubled for a seamless loop
            key={i}
            className="pill"
          >
            <span
              className={`label ${status === "running" ? "coral" : ""}`}
              style={status === "done" ? { color: "var(--color-success-ink)" } : status === "review" ? { color: "var(--color-warning-ink)" } : undefined}
            >
              {status}
            </span>
            {title}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── how it works ────────────────────────────────────────────────────────────
function HowItWorks() {
  return (
    <section id="how" className="section">
      <div className="wrap">
        <div className="section-head reveal">
          <span className="label">How it works</span>
          <h2 className="h2">Write the task. Walk away. Review the diff.</h2>
          <p className="lede">
            No new workflow to learn. It drives the same CLIs you already use, with the subscriptions you already pay for.
          </p>
        </div>
        <div className="steps">
          <div className="step reveal">
            <span className="n">01</span>
            <h3>Queue it</h3>
            <p>Pick a repo, describe the change, paste a screenshot. Tick the repo prompts and saved prompts it should carry.</p>
            <div className="viz">
              <div className="sim-task" style={{ animation: "none" }}>
                <span className="t">Fix the crash when the cart is empty</span>
                <span className="pill">pending</span>
                <span className="m">mobile-app · 3 prompts</span>
              </div>
              <div className="sim-task" style={{ animation: "none", opacity: 0.6 }}>
                <span className="t">Write Playwright tests for checkout</span>
                <span className="pill">pending</span>
                <span className="m">storefront · 2 prompts</span>
              </div>
            </div>
          </div>
          <div className="step reveal" style={delay(100)}>
            <span className="n">02</span>
            <h3>It runs, and keeps running</h3>
            <p>
              Tasks run in your checkout, one repo at a time. Hit a usage limit? The run moves to the next account in that repo's
              chain.
            </p>
            <div className="viz">
              <FallbackChain short />
            </div>
          </div>
          <div className="step reveal" style={delay(200)}>
            <span className="n">03</span>
            <h3>You review</h3>
            <p>See exactly what changed since the task started. Reply for changes in the same session, mark it finished, or discard it.</p>
            <div className="viz">
              <MiniDiff />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── features bento ──────────────────────────────────────────────────────────
function Features() {
  return (
    <section id="features" className="section rule-top">
      <div className="wrap">
        <div className="section-head reveal">
          <span className="label">Features</span>
          <h2 className="h2">Everything a night shift needs.</h2>
          <p className="lede">Built by a developer who got tired of watching a progress bar and a usage meter at the same time.</p>
        </div>
        <div className="bento">
          <article className="card span-4 reveal">
            <div className="copy">
              <h3>
                <RefreshCwIcon /> Fallback across every subscription
              </h3>
              <p>
                Log in to as many Claude Code accounts as you have (and Cursor). Each repo gets an ordered chain. A run that hits
                a limit continues on the next account, and the limited one rejoins when it resets.
              </p>
            </div>
            <div className="viz">
              <FallbackChain />
            </div>
          </article>
          <article className="card card-ink span-2 reveal" style={delay(80)}>
            <div className="copy">
              <h3>
                <GitBranchIcon /> No branches. No worktrees.
              </h3>
              <p>
                Tasks run in your repo exactly as it's checked out. The app never creates, switches, resets or commits anything.
                Your repo prompts decide how changes are handled.
              </p>
            </div>
          </article>
          <article className="card span-2 reveal">
            <div className="copy">
              <h3>
                <LayersIcon /> Prompts in layers
              </h3>
              <p>A global base prompt, per-repo prompts and a saved library, stacked in a fixed, visible order.</p>
            </div>
            <div className="viz">
              <PromptLayers compact />
            </div>
          </article>
          <article className="card span-2 reveal" style={delay(80)}>
            <div className="copy">
              <h3>
                <MessageCircleQuestionIcon /> Ask mode
              </h3>
              <p>Read-only questions that run at once, outside the queue. Only your message is sent.</p>
            </div>
            <div className="viz">
              <MiniChat />
            </div>
          </article>
          <article className="card span-2 reveal" style={delay(160)}>
            <div className="copy">
              <h3>
                <GitGraphIcon /> A real commit graph
              </h3>
              <p>Branches, merges and stashes, with pull, push, cherry-pick, rebase and undo a right-click away.</p>
            </div>
            <div className="viz">
              <MiniGraph />
            </div>
          </article>
          <article className="card span-3 reveal">
            <div className="copy">
              <h3>
                <ServerIcon /> Remote repos over SSH
              </h3>
              <p>
                Point a repo at a host from your <span className="mono">~/.ssh/config</span>. Git and the CLI run on that server,
                with its own login, and Cancel really stops the remote process.
              </p>
            </div>
            <div className="viz">
              <MiniTerm />
            </div>
          </article>
          <article className="card span-3 reveal" style={delay(80)}>
            <div className="copy">
              <h3>
                <BarChart3Icon /> Token statistics
              </h3>
              <p>Usage per subscription and overall, from what each CLI reported. See which account is doing the heavy lifting.</p>
            </div>
            <div className="viz">
              <MiniBars />
            </div>
          </article>
          <article className="card span-2 reveal">
            <div className="copy">
              <h3>
                <FolderGit2Icon /> Cross-repo tasks
              </h3>
              <p>Tick several repos: the agent works in the main one and reaches the others, each with its own prompts.</p>
            </div>
          </article>
          <article className="card span-2 reveal" style={delay(80)}>
            <div className="copy">
              <h3>
                <ShieldCheckIcon /> No AI attribution
              </h3>
              <p>Commits use the committer you pick per repo. No “Co-Authored-By” trailers, no robot footers.</p>
            </div>
          </article>
          <article className="card span-2 reveal" style={delay(160)}>
            <div className="copy">
              <h3>
                <LockIcon /> Local first
              </h3>
              <p>A desktop app on 127.0.0.1. Your queue, prompts, history and CLI logins are plain files in a folder you pick.</p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

// ── prompt transparency ─────────────────────────────────────────────────────
function PromptSection() {
  const [on, setOn] = useState<string | null>(null);
  return (
    <section className="section">
      <div className="wrap split">
        <div className="section-head reveal" style={{ marginBottom: 0 }}>
          <span className="label">What gets sent</span>
          <h2 className="h2">The whole prompt. Nothing hidden.</h2>
          <p className="lede">
            The only text a CLI receives is what you wrote, in layers, joined by a blank line. No secret system prompt, no role
            play, no wrapper. Every task shows what its run received, and every run is logged with its full prompt.
          </p>
          <ul className="checks">
            <li>
              <CheckIcon />
              <span>
                <b>Global base prompt</b> for every task, everywhere.
              </span>
            </li>
            <li>
              <CheckIcon />
              <span>
                <b>Repo prompts</b> you tick per task: branching, commits, style. The defaults come pre-ticked.
              </span>
            </li>
            <li>
              <CheckIcon />
              <span>
                <b>Saved prompts</b> from your library, with their screenshots.
              </span>
            </li>
            <li>
              <CheckIcon />
              <span>
                <b>Your message.</b> Replies send only the reply.
              </span>
            </li>
          </ul>
        </div>
        <div className="prompt-doc reveal" style={delay(100)}>
          <div className="head">
            <span className="label">Exact text received · side-max</span>
            <span className="pill pill-done">
              <CheckIcon style={{ width: 12, height: 12 }} /> 4 layers
            </span>
          </div>
          <div className="body">
            {PROMPT_LAYERS.map((l) => (
              <div
                key={l.k}
                className={`pblock ${l.k === "message" ? "msg" : ""} ${on === l.k ? "on" : ""}`}
                onMouseEnter={() => setOn(l.k)}
                onMouseLeave={() => setOn(null)}
              >
                <span className="tag">{l.name}</span>
                <span className="text">{l.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── numbers ─────────────────────────────────────────────────────────────────
function Numbers() {
  return (
    <section className="ink-band" aria-label="By the numbers">
      <div className="wrap stats">
        <div className="stat reveal">
          <span className="v num">
            0<span className="coral">.</span>
          </span>
          <span className="k">hidden prompts, wrappers or system text added to your task</span>
        </div>
        <div className="stat reveal" style={delay(80)}>
          <span className="v num">
            0<span className="coral">.</span>
          </span>
          <span className="k">branches, worktrees or commits the app makes on its own</span>
        </div>
        <div className="stat reveal" style={delay(160)}>
          <span className="v num">
            ∞<span className="coral">.</span>
          </span>
          <span className="k">accounts in a fallback chain. Bring every subscription you have</span>
        </div>
        <div className="stat reveal" style={delay(240)}>
          <span className="v num">
            2<span className="coral">.</span>
          </span>
          <span className="k">CLIs side by side: Claude Code and the Cursor Agent</span>
        </div>
      </div>
    </section>
  );
}

// ── faq ─────────────────────────────────────────────────────────────────────
const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "What do I need to run it?",
    a: (
      <p>
        macOS 13+ or Windows 10/11, and the CLIs you want to use installed: <code>claude</code> (Claude Code) and/or Cursor's{" "}
        <code>agent</code>. You log in to your accounts from inside the app, each one in its own isolated config folder.
      </p>
    ),
  },
  {
    q: "Does it use my API key or my subscription?",
    a: (
      <p>
        Your subscriptions. It drives the official CLIs with the logins you add, and scrubs API keys like{" "}
        <code>ANTHROPIC_API_KEY</code> from their environment so a run never bills a key by surprise.
      </p>
    ),
  },
  {
    q: "Will it mess with my branches?",
    a: (
      <p>
        No. The app never creates, switches, resets, stashes, commits or pushes anything on a task. The agent works in your
        checkout as it is, and your repo prompts tell it how to handle changes (for example: “work on a new branch, open a merge
        request”). The commit graph's git buttons only act when you click them.
      </p>
    ),
  },
  {
    q: "How does the fallback actually work?",
    a: (
      <p>
        Every repo has an ordered chain of accounts. A task runs on the first available one. When the CLI reports a usage limit,
        that account is marked limited until it resets and the run continues on the next account in the chain. Logged-out
        accounts are skipped the same way.
      </p>
    ),
  },
  {
    q: "Is my code sent anywhere?",
    a: (
      <p>
        Only where the CLI you chose sends it. The app itself listens on <code>127.0.0.1</code>, has no telemetry, and keeps
        everything (queue, prompts, history, logins) as plain files in a data folder you pick. Commit-graph avatars are off by
        default.
      </p>
    ),
  },
  {
    q: "macOS says the app can't be verified. Now what?",
    a: (
      <>
        <p>
          The app isn't notarized yet. Drag it to Applications, then run{" "}
          <code>xattr -dr com.apple.quarantine "/Applications/My AI Slaves.app"</code> once, or use System Settings → Privacy
          &amp; Security → Open Anyway. On Windows, click More info → Run anyway.
        </p>
        <p>Updates installed from inside the app (sha256-verified) don't ask again.</p>
      </>
    ),
  },
  {
    q: "What does it cost?",
    a: <p>Nothing. It's MIT-licensed and open source. You only pay for the subscriptions you already have.</p>,
  },
];

function Faq() {
  return (
    <section id="faq" className="section">
      <div className="wrap split" style={{ alignItems: "start" }}>
        <div className="section-head reveal">
          <span className="label">FAQ</span>
          <h2 className="h2">Questions, answered.</h2>
          <p className="lede">
            Something else? <a href={`${REPO_URL}/issues`}>Open an issue on GitHub</a>.
          </p>
        </div>
        <div className="faq reveal" style={delay(80)}>
          {FAQ.map((f, i) => (
            <details key={f.q} open={i === 0}>
              <summary>
                {f.q}
                <PlusIcon />
              </summary>
              <div className="a">{f.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── final cta ───────────────────────────────────────────────────────────────
function FinalCta({ platform }: { platform: DownloadKey | null }) {
  return (
    <section id="download" className="section final">
      <div className="wrap">
        <div className="final-card reveal">
          <MarkBars className="final-mark" />
          <span className="label" style={{ color: "inherit", opacity: 0.7 }}>
            Free · open source · macOS &amp; Windows
          </span>
          <h2 className="h2">Put your subscriptions on the night shift.</h2>
          <p className="lede">Queue tonight's tasks, close the laptop lid on your worries, and review the diffs over coffee.</p>
          <DownloadButtons platform={platform} />
          <p className="download-alt" style={{ color: "inherit", opacity: 0.75, margin: 0 }}>
            All builds:{" "}
            {(Object.keys(DOWNLOADS) as DownloadKey[]).map((k, i) => (
              <span key={k}>
                {i > 0 && " · "}
                <a href={DOWNLOADS[k].href} style={{ color: "inherit" }}>
                  {DOWNLOADS[k].label}
                </a>
              </span>
            ))}{" "}
            ·{" "}
            <a href={RELEASES_URL} style={{ color: "inherit" }}>
              Release notes <ArrowRightIcon style={{ width: 12, height: 12, display: "inline", verticalAlign: "-1px" }} />
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer rule-top">
      <div className="wrap footer-inner">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <Mark size={20} />
          My AI Slaves · MIT License
        </span>
        <nav aria-label="Footer">
          <a href={REPO_URL}>GitHub</a>
          <a href={RELEASES_URL}>Releases</a>
          <a href={`${REPO_URL}#security-model`}>Security model</a>
          <a href={`${REPO_URL}/issues`}>Issues</a>
        </nav>
      </div>
    </footer>
  );
}
