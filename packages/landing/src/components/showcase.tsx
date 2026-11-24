import {
  ArrowRightLeftIcon,
  BarChart3Icon,
  CheckIcon,
  FileDiffIcon,
  GitGraphIcon,
  HistoryIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
  RadioIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion, useInView, usePageVisible } from "../hooks";

/** Real screenshots of the app (scripts/shots.mjs makes them from demo data), one per tab. */
export const SCREENS: { id: string; tab: string; icon: LucideIcon; title: string; body: string; points: string[] }[] = [
  {
    id: "queue-running",
    tab: "Live run",
    icon: RadioIcon,
    title: "Watch the agent work, live",
    body: "Every message, file read, edit and command streams in as it happens, next to the queue that's waiting its turn.",
    points: ["Exactly which prompts the CLI received, ticked off", "Raw CLI output one toggle away", "Cancel any run, any time"],
  },
  {
    id: "queue-review",
    tab: "Review",
    icon: FileDiffIcon,
    title: "Review the diff, then decide",
    body: "When a run finishes, the task waits for you with everything that changed since it started. Mark it finished, reply for changes, or discard it.",
    points: ["Side-by-side diff per file", "Reply to continue the same session", "Nothing is committed behind your back"],
  },
  {
    id: "queue-fallback",
    tab: "Fallback",
    icon: ArrowRightLeftIcon,
    title: "Limits don't stop the queue",
    body: "This task started on work-max, which hit its usage limit. The run moved to personal-pro on its own and finished there.",
    points: ["Each repo has its own account chain", "Limited accounts come back when they reset", "Claude Code and Cursor, mixed freely"],
  },
  {
    id: "repos-graph",
    tab: "Commit graph",
    icon: GitGraphIcon,
    title: "A commit graph for every repo",
    body: "Branches, merges, stashes and work in progress, with the git actions you reach for daily: pull, push, branch, stash, cherry-pick, rebase.",
    points: ["Undo and redo from the reflog", "Stage and commit from the WIP panel", "Only changes the repo when you click"],
  },
  {
    id: "ask",
    tab: "Ask",
    icon: MessageCircleQuestionIcon,
    title: "Ask questions without touching code",
    body: "Ask mode runs read-only, right away, outside the queue. Perfect for “where is this handled?” and “why does this break?”.",
    points: ["Only your message is sent", "Claude plan mode, Cursor ask mode", "Follow-ups continue the session"],
  },
  {
    id: "stats",
    tab: "Statistics",
    icon: BarChart3Icon,
    title: "Know where your tokens go",
    body: "Token usage per subscription and overall, straight from what each CLI reported, run by run.",
    points: ["Input, output and cache tokens", "Claude's own cost estimate", "Any range: 7 days to all time"],
  },
  {
    id: "history",
    tab: "History",
    icon: HistoryIcon,
    title: "Every run, on the record",
    body: "Each started run is logged with the full prompt it sent, every event and the outcome. Searchable later, kept on your disk.",
    points: ["The exact assembled prompt of every run", "Fallbacks and limits on the timeline", "Plain JSON files you own"],
  },
];

const AUTO_MS = 7000;

export function Showcase({ theme }: { theme: "light" | "dark" }) {
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(true);
  const [zoom, setZoom] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const visible = usePageVisible();
  const screen = SCREENS[index] ?? SCREENS[0];

  useEffect(() => {
    if (!auto || !inView || !visible || zoom || prefersReducedMotion()) return;
    const id = window.setTimeout(() => setIndex((index + 1) % SCREENS.length), AUTO_MS);
    return () => window.clearTimeout(id);
  }, [auto, inView, visible, zoom, index]);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  // Warm the cache for the next screenshot so the swap is instant.
  useEffect(() => {
    const next = SCREENS[(index + 1) % SCREENS.length];
    if (next) new Image().src = src(next.id, theme);
  }, [index, theme]);

  if (!screen) return null;
  const Icon = screen.icon;
  const running = auto && inView && visible && !zoom;

  return (
    <div ref={ref}>
      <div className="tabs" role="tablist" aria-label="App screens">
        {SCREENS.map((s, i) => {
          const TabIcon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={i === index}
              onClick={() => {
                setIndex(i);
                setAuto(false);
              }}
            >
              <TabIcon />
              {s.tab}
              {i === index && running && <span key={index} className="progress" style={{ ["--dur" as string]: `${AUTO_MS}ms` }} />}
            </button>
          );
        })}
      </div>
      <div className="showcase-grid">
        <div className="showcase-copy swap" key={screen.id}>
          <span className="label" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <Icon style={{ width: 14, height: 14 }} />
            {screen.tab}
          </span>
          <h3>{screen.title}</h3>
          <p>{screen.body}</p>
          <ul>
            {screen.points.map((p) => (
              <li key={p}>
                <CheckIcon />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <button type="button" className="zoom" onClick={() => setZoom(true)} aria-label={`Enlarge: ${screen.title}`}>
          <div className="shot-frame swap" key={`${screen.id}-${theme}`}>
            <div className="chrome" aria-hidden="true">
              <i />
              <i />
              <i />
              <span>My AI Slaves</span>
            </div>
            <img src={src(screen.id, theme)} alt={screen.title} width={1600} height={1000} loading="lazy" decoding="async" />
          </div>
        </button>
      </div>
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(false)} role="dialog" aria-modal="true" aria-label={screen.title}>
          <img src={src(screen.id, theme)} alt={screen.title} />
        </div>
      )}
    </div>
  );
}

export function src(id: string, theme: "light" | "dark"): string {
  return `./shots/${id}-${theme}.webp`;
}
