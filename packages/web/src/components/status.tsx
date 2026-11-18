import type { AccountView } from "@my-ai-slaves/shared";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { useNow } from "@/lib/hooks";
import { cn, formatDuration } from "@/lib/utils";

const taskVariants: Record<string, BadgeVariant> = {
  pending: "outline",
  running: "signal",
  "needs-review": "warning",
  interrupted: "destructive",
  done: "success",
  failed: "destructive",
  discarded: "secondary",
  cancelled: "secondary",
};

const taskLabels: Record<string, string> = { "needs-review": "review" };

/** A live coral pulse; the only looping motion in the app. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex size-1.5", className)} aria-hidden>
      <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-60 motion-reduce:hidden" />
      <span className="relative size-1.5 rounded-full bg-current" />
    </span>
  );
}

export function TaskStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant={taskVariants[status] ?? "outline"} className={className}>
      {status === "running" && <LiveDot />}
      {taskLabels[status] ?? status}
    </Badge>
  );
}

/** Seconds left until `limitedUntil`, preferring the absolute timestamp so the countdown stays live. */
function secondsLeft(account: AccountView, now: number): number | null {
  if (account.limitedUntil) {
    const t = new Date(account.limitedUntil).getTime();
    if (!Number.isNaN(t)) return Math.max(0, (t - now) / 1000);
  }
  return account.secondsUntilAvailable;
}

const accountTone: Record<string, { variant: BadgeVariant; dot: string; label: string }> = {
  available: { variant: "success", dot: "bg-success", label: "available" },
  limited: { variant: "warning", dot: "bg-warning", label: "limited" },
  "logged-out": { variant: "destructive", dot: "bg-danger", label: "logged out" },
  unknown: { variant: "outline", dot: "bg-rule-strong", label: "unknown" },
};

export function AccountStatusBadge({ account }: { account: AccountView }) {
  const now = useNow();
  const tone = accountTone[account.status] ?? accountTone.unknown!;
  const left = account.status === "limited" ? secondsLeft(account, now) : null;
  return (
    <Badge variant={tone.variant} title={account.limitedUntil ?? undefined}>
      {tone.label}
      {left !== null && <span className="num">· {formatDuration(left)}</span>}
    </Badge>
  );
}

/** Compact form for dense lists: a status dot plus a short word. */
export function AccountStatusDot({ account }: { account: AccountView }) {
  const now = useNow();
  const tone = accountTone[account.status] ?? accountTone.unknown!;
  const left = account.status === "limited" ? secondsLeft(account, now) : null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground" title={account.limitedUntil ?? undefined}>
      <span className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
      <span className="num">{left !== null ? formatDuration(left) : tone.label}</span>
    </span>
  );
}

export function ProviderLabel({ provider }: { provider: string }) {
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      {provider === "claude-code" ? "Claude Code" : provider === "cursor-agent" ? "Cursor Agent" : provider}
    </span>
  );
}
