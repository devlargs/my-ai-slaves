import { AlertCircleIcon, ArrowUpRightIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import { ConfirmButton } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { desktop, desktopAction, useDesktop } from "@/lib/desktop";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * The desktop app's update control. Always there in the app (nothing in a browser tab): the version
 * and a check button, which becomes a "Check for updates" install button as soon as a newer release is found (checked on
 * launch and every 6 hours), then the download's progress.
 */
export function UpdateControl({ className }: { className?: string }) {
  const { update } = useDesktop();
  if (!desktop || !update) return null;
  const { status, currentVersion, newVersion, percent, error } = update;

  if (status === "available") {
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <InstallButton newVersion={newVersion} label="Check for updates" className="w-full" />
        <span className="num text-center text-[11px] text-muted-foreground">v{currentVersion}</span>
      </div>
    );
  }

  if (status === "manual") {
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <Button size="sm" variant="outline" className="w-full" onClick={() => void desktopAction(() => desktop!.openReleasePage())}>
          <ArrowUpRightIcon /> Get v{newVersion} on GitHub
        </Button>
        <span className="text-center text-[11px] text-muted-foreground">This one can't install from the app</span>
      </div>
    );
  }

  if (status === "downloading" || status === "installing") {
    return (
      <div className={cn("flex flex-col gap-1.5", className)} role="status">
        <div className="flex items-center justify-between text-[11px] text-ink-2">
          <span>{status === "installing" ? "Restarting to update…" : `Downloading v${newVersion}…`}</span>
          <span className="num">{percent}%</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-paper-3">
          <div className="h-full rounded-full bg-signal transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  const checking = status === "checking";
  return (
    <div className={cn("flex h-7 items-center justify-between gap-2 text-[11px] text-muted-foreground", className)}>
      <span className="num flex min-w-0 items-center gap-1.5 truncate" title={error ?? undefined}>
        {status === "error" && <AlertCircleIcon className="size-3.5 shrink-0 text-danger-ink" aria-label="Update check failed" />}
        v{currentVersion}
        {status === "latest" && <span className="truncate">· up to date</span>}
        {status === "error" && <span className="truncate">· check failed</span>}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        title="Check for updates"
        aria-label="Check for updates"
        disabled={checking}
        onClick={() => void desktopAction(() => desktop!.checkForUpdates())}
      >
        <RefreshCwIcon className={cn(checking && "animate-spin")} />
      </Button>
    </div>
  );
}

/** Asks first: updating quits the app, which stops running tasks. */
export function InstallButton({
  newVersion,
  label,
  className,
}: {
  newVersion: string | null;
  /** Button text; defaults to "Update to vX". */
  label?: string;
  className?: string;
}) {
  const running = useStore((s) => s.tasks.filter((t) => t.status === "running").length);
  return (
    <ConfirmButton
      size="sm"
      variant="outline"
      className={className}
      destructive={false}
      title={`Update to v${newVersion}?`}
      description={
        <>
          The app downloads v{newVersion}, checks it against the checksum GitHub published, installs it and reopens.
          {running > 0 && (
            <>
              {" "}
              <strong className="text-ink">
                {running} running {running === 1 ? "task stops" : "tasks stop"}
              </strong>{" "}
              and will show as interrupted.
            </>
          )}
        </>
      }
      confirmLabel="Update and restart"
      onConfirm={() => void desktopAction(() => desktop!.installUpdate())}
    >
      <DownloadIcon /> {label ?? `Update to v${newVersion}`}
    </ConfirmButton>
  );
}
