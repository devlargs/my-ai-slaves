import { BellIcon, HistoryIcon, ListOrderedIcon, type LucideIcon, FolderGit2Icon, SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { AccountStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useStore, ws } from "@/lib/store";
import { cn } from "@/lib/utils";
import { HistoryPage } from "@/pages/history-page";
import { QueuePage } from "@/pages/queue-page";
import { ReposPage } from "@/pages/repos-page";
import { SettingsPage } from "@/pages/settings-page";

type Route = "queue" | "repos" | "settings" | "history";

const NAV: { route: Route; label: string; icon: LucideIcon }[] = [
  { route: "queue", label: "Queue", icon: ListOrderedIcon },
  { route: "repos", label: "Repos", icon: FolderGit2Icon },
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
    <div className="flex h-full">
      <Sidebar route={route} />
      <main className="min-w-0 flex-1 overflow-auto">
        {route === "queue" && <QueuePage />}
        {route === "repos" && <ReposPage />}
        {route === "settings" && <SettingsPage />}
        {route === "history" && <HistoryPage />}
      </main>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

function Sidebar({ route }: { route: Route }) {
  const connected = useStore((s) => s.connected);
  const tasks = useStore((s) => s.tasks);
  const accounts = useStore((s) => s.accounts);
  const running = tasks.filter((t) => t.status === "running").length;
  const review = tasks.filter((t) => t.status === "needs-review").length;

  return (
    <nav className="flex w-52 shrink-0 flex-col border-r bg-sidebar">
      <div className="px-4 py-3">
        <div className="text-sm font-semibold">My AI Slaves</div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-destructive")} />
          {connected ? "connected" : "reconnecting…"}
        </div>
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        {NAV.map(({ route: r, label, icon: Icon }) => (
          <a
            key={r}
            href={`#/${r}`}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
              route === r ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
            {r === "queue" && (running > 0 || review > 0) && (
              <span className="ml-auto font-mono text-[11px]">
                {running > 0 && <span className="text-primary">{running}▶</span>}
                {review > 0 && <span className="ml-1 text-warning">{review}?</span>}
              </span>
            )}
          </a>
        ))}
      </div>
      {accounts.length > 0 && (
        <div className="mt-4 flex flex-col gap-1 px-4">
          <div className="text-[11px] font-medium text-muted-foreground uppercase">Accounts</div>
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-1 text-xs">
              <span className="truncate">{a.label}</span>
              <AccountStatusBadge account={a} />
            </div>
          ))}
        </div>
      )}
      <div className="mt-auto p-3">
        <NotificationPrompt />
      </div>
    </nav>
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
      <div className="max-w-md rounded-lg border bg-card p-6 text-center">
        <h1 className="text-base font-semibold">Can&apos;t reach the server</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Make sure <code className="font-mono">npm run dev</code> is running, then reload this page.
        </p>
      </div>
    </div>
  );
}
