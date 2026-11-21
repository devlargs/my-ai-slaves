import type { DesktopUpdateState } from "@my-ai-slaves/shared";
import { AlertCircleIcon, AlertTriangleIcon, ArrowUpRightIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import { ConfirmButton } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { checkedLabel, desktop, desktopAction, useDesktop, useUpdateCheck } from "@/lib/desktop";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * The desktop app's update control. Always there in the app (nothing in a browser tab): the version
 * and a "Check for updates" button, which always asks GitHub again. When a newer release is found
 * (on a click, on launch and every 6 hours) an "Update to vX" button appears above it, then the
 * download's progress.
 */
export function UpdateControl({ className }: { className?: string }) {
  const { update } = useDesktop();
  const { check, checking } = useUpdateCheck();
  if (!desktop || !update) return null;
  const { status, currentVersion, newVersion, percent, error } = update;

  // The Intel build on an Apple Silicon Mac: getting off it comes before anything else.
  if (update.rosetta && status !== "downloading" && status !== "installing") {
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <RosettaNotice update={update} />
        <span className="num text-center text-[11px] text-muted-foreground">v{currentVersion}</span>
      </div>
    );
  }

  const checkRow = (
    <div className="flex h-7 items-center justify-between gap-2 text-[11px] text-muted-foreground">
      <span className="num flex min-w-0 items-center gap-1.5 truncate" title={error ?? (checkedLabel(update.checkedAt) || undefined)}>
        {status === "error" && !checking && (
          <AlertCircleIcon className="size-3.5 shrink-0 text-danger-ink" aria-label="Update check failed" />
        )}
        v{currentVersion}
        {checking ? (
          <span className="truncate">· checking…</span>
        ) : (
          <>
            {status === "latest" && <span className="truncate">· up to date</span>}
            {status === "error" && <span className="truncate">· check failed</span>}
          </>
        )}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        title="Check for updates"
        aria-label="Check for updates"
        disabled={checking}
        onClick={check}
      >
        <RefreshCwIcon className={cn(checking && "animate-spin")} />
      </Button>
    </div>
  );

  if (status === "available") {
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        <InstallButton newVersion={newVersion} className="w-full" />
        {checkRow}
      </div>
    );
  }

  if (status === "manual") {
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          title="This one can't install from the app"
          onClick={() => void desktopAction(() => desktop!.openReleasePage())}
        >
          <ArrowUpRightIcon /> Get v{newVersion} on GitHub
        </Button>
        {checkRow}
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
          {/* Slid in with transform (composited), not by animating width (a layout per frame). */}
          <div
            className="h-full w-full rounded-full bg-signal transition-transform duration-300"
            style={{ transform: `translateX(${percent - 100}%)` }}
          />
        </div>
      </div>
    );
  }

  return <div className={className}>{checkRow}</div>;
}

/**
 * Shown while the Intel build runs on an Apple Silicon Mac: macOS translates it through Rosetta,
 * which makes every page, click and keystroke many times slower. One click installs the Apple
 * Silicon build of the latest release (or opens the release page when it can't install from here).
 */
export function RosettaNotice({ update, className }: { update: DesktopUpdateState; className?: string }) {
  const checking = update.status === "checking" || update.status === "idle";
  return (
    <div role="alert" className={cn("flex flex-col gap-2 rounded-md bg-warning-soft px-2.5 py-2 text-[11px] leading-snug text-warning-ink", className)}>
      <span className="flex items-start gap-1.5">
        <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
        <span>
          <strong className="font-semibold">Intel build on an Apple Silicon Mac.</strong> It runs through Rosetta, which makes
          the whole app slow.
        </span>
      </span>
      {update.status === "available" ? (
        <InstallButton rosetta newVersion={update.newVersion} label="Switch to Apple Silicon" className="w-full" />
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={checking}
          title={update.error ?? undefined}
          onClick={() => void desktopAction(() => desktop!.openReleasePage())}
        >
          {checking ? (
            "Looking for the right build…"
          ) : (
            <>
              <ArrowUpRightIcon /> Get it on GitHub
            </>
          )}
        </Button>
      )}
    </div>
  );
}

/** Asks first: updating quits the app, which stops running tasks. */
export function InstallButton({
  newVersion,
  label,
  className,
  rosetta = false,
}: {
  newVersion: string | null;
  /** Button text; defaults to "Update to vX". */
  label?: string;
  className?: string;
  /** Replacing the Intel build with the Apple Silicon one (possibly the same version). */
  rosetta?: boolean;
}) {
  const running = useStore((s) => s.tasks.filter((t) => t.status === "running").length);
  return (
    <ConfirmButton
      size="sm"
      variant="outline"
      className={className}
      destructive={false}
      title={rosetta ? "Switch to the Apple Silicon build?" : `Update to v${newVersion}?`}
      description={
        <>
          The app downloads {rosetta ? `the Apple Silicon build of v${newVersion}` : `v${newVersion}`}, checks it against the
          checksum GitHub published, installs it and reopens.
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
      confirmLabel={rosetta ? "Switch and restart" : "Update and restart"}
      onConfirm={() => void desktopAction(() => desktop!.installUpdate())}
    >
      <DownloadIcon /> {label ?? `Update to v${newVersion}`}
    </ConfirmButton>
  );
}
