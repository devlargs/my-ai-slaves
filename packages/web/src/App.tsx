import {
  BellIcon,
  FolderGit2Icon,
  HistoryIcon,
  LibraryBigIcon,
  ListOrderedIcon,
  type LucideIcon,
  SettingsIcon,
} from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import { UpdateControl } from "@/components/desktop-update";
import { ResizeHandle, useResizableWidth } from "@/components/resize-handle";
import { LiveDot } from "@/components/status";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useStore, ws } from "@/lib/store";
import { cn } from "@/lib/utils";
import { HistoryPage } from "@/pages/history-page";
import { PromptsPage } from "@/pages/prompts-page";
import { QueuePage } from "@/pages/queue-page";
import { ReposPage } from "@/pages/repos-page";
import { SettingsPage } from "@/pages/settings-page";

type Route = "queue" | "repos" | "prompts" | "settings" | "history";

const NAV: { route: Route; label: string; icon: LucideIcon }[] = [
  { route: "queue", label: "Queue", icon: ListOrderedIcon },
  { route: "repos", label: "Repos", icon: FolderGit2Icon },
  { route: "prompts", label: "Prompts", icon: LibraryBigIcon },
  { route: "settings", label: "Settings", icon: SettingsIcon },
  { route: "history", label: "History", icon: HistoryIcon },
];

function readRoute(): Route {
  const r = location.hash.replace(/^#\/?/, "");
  return NAV.some((n) => n.route === r) ? (r as Route) : "queue";
}

function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  // The sidebar shows the new route at once; the page itself switches in a background render that
  // yields to typing and clicks, so a heavy page (a long live output) never freezes the window.
  const page = useDeferredValue(route);
  const unauthorized = useStore((s) => s.unauthorized);

  useEffect(() => {
    // Confirms the session cookie first (a 401 flips to the "session expired" screen), then opens the socket.
    api
      .session()
      .then(() => ws.start())
      .catch(() => {});
  }, []);

  if (unauthorized) return <SessionExpired />;

  return (
    <TooltipProvider delayDuration={250}>
    <div className="flex h-full">
      <Sidebar route={route} />
      <main className="scroll-quiet min-w-0 flex-1 overflow-auto">
        {page === "queue" && <QueuePage />}
        {page === "repos" && <ReposPage />}
        {page === "prompts" && <PromptsPage />}
        {page === "settings" && <SettingsPage />}
        {page === "history" && <HistoryPage />}
      </main>
    </div>
    </TooltipProvider>
  );
}

function Sidebar({ route }: { route: Route }) {
  const connected = useStore((s) => s.connected);
  const tasks = useStore((s) => s.tasks);
  const running = tasks.filter((t) => t.status === "running").length;
  const review = tasks.filter((t) => t.status === "needs-review").length;

  const navWidth = useResizableWidth({ key: "slaves.sidebarWidth", initial: 224, min: 180, max: 400, reserve: 900 });

  return (
    <nav
      aria-label="Main"
      className="relative flex shrink-0 flex-col border-r border-rule bg-paper-2"
      style={{ width: navWidth.width }}
    >
      <ResizeHandle {...navWidth} label="Resize the sidebar" />
      <div className="flex flex-col gap-1 px-4 pt-4 pb-5">
        <div className="flex items-center gap-2">
          <Mark />
          <span className="title-display text-[15px]">My AI Slaves</span>
        </div>
        <div className="flex items-center gap-1.5 pl-7 text-[11px] text-muted-foreground" role="status">
          {connected ? (
            <>
              {/* A still dot: a pulse here would keep the GPU drawing every frame while nothing is happening. */}
              <span className="size-1.5 rounded-full bg-success" aria-hidden /> Live
            </>
          ) : (
            <>
              <span className="size-1.5 rounded-full bg-danger" aria-hidden /> Reconnecting…
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-0.5 px-2">
        {NAV.map(({ route: r, label, icon: Icon }) => {
          const active = route === r;
          return (
            <a
              key={r}
              href={`#/${r}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md border px-2.5 text-[13px] transition-colors duration-150",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--color-focus)",
                active
                  ? "border-rule bg-surface font-medium text-ink"
                  : "border-transparent text-ink-2 hover:bg-paper-3 hover:text-ink",
              )}
            >
              <Icon className={cn("size-4", active ? "text-ink" : "text-muted-foreground")} />
              {label}
              {r === "queue" && (running > 0 || review > 0) && (
                <span className="ml-auto flex items-center gap-1">
                  {running > 0 && (
                    <span
                      title={`${running} running`}
                      className="num inline-flex h-4.5 items-center gap-1 rounded-full bg-signal-soft px-1.5 text-[11px] font-medium text-signal-ink"
                    >
                      <LiveDot /> {running}
                    </span>
                  )}
                  {review > 0 && (
                    <span
                      title={`${review} waiting for review`}
                      className="num inline-flex h-4.5 items-center rounded-full bg-warning-soft px-1.5 text-[11px] font-medium text-warning-ink"
                    >
                      {review}
                    </span>
                  )}
                </span>
              )}
            </a>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col gap-2 p-3">
        <NotificationPrompt />
        <UpdateControl />
        <ThemeToggle />
      </div>
    </nav>
  );
}

/** Wordmark glyph: three stacked queue bars, the top one coral (the task being worked on). */
function Mark() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 shrink-0" aria-hidden>
      <rect x="2" y="3" width="16" height="4" rx="2" fill="var(--color-signal)" />
      <rect x="2" y="8.5" width="12" height="4" rx="2" fill="var(--color-ink)" />
      <rect x="2" y="14" width="8" height="4" rx="2" fill="var(--color-ink)" opacity="0.35" />
    </svg>
  );
}

function NotificationPrompt() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  if (permission !== "default") return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="w-full"
      onClick={async () => {
        try {
          setPermission(await Notification.requestPermission());
        } catch {
          setPermission("denied");
        }
      }}
    >
      <BellIcon /> Enable notifications
    </Button>
  );
}

function SessionExpired() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-rule bg-surface p-6 text-center">
        <h1 className="title-display text-base">Can&apos;t reach the server</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Make sure <code className="font-mono">npm run dev</code> is running, then reload this page.
        </p>
      </div>
    </div>
  );
}
