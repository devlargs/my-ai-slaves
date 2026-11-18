import type { AccountView } from "@my-ai-slaves/shared";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { useNow } from "@/lib/hooks";
import { formatDuration } from "@/lib/utils";

const taskVariants: Record<string, BadgeVariant> = {
  pending: "secondary",
  running: "default",
  "needs-review": "warning",
  interrupted: "destructive",
  done: "success",
  failed: "destructive",
  discarded: "outline",
  cancelled: "outline",
};

export function TaskStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={taskVariants[status] ?? "outline"}>
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {status}
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

export function AccountStatusBadge({ account }: { account: AccountView }) {
  const now = useNow();
  if (account.status === "limited") {
    const left = secondsLeft(account, now);
    return (
      <Badge variant="warning" title={account.limitedUntil ?? undefined}>
        limited{left !== null ? ` · ${formatDuration(left)}` : ""}
      </Badge>
    );
  }
  const variant: BadgeVariant =
    account.status === "available" ? "success" : account.status === "logged-out" ? "destructive" : "outline";
  return <Badge variant={variant}>{account.status}</Badge>;
}

export function ProviderLabel({ provider }: { provider: string }) {
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      {provider === "claude-code" ? "Claude Code" : provider === "cursor-agent" ? "Cursor Agent" : provider}
    </span>
  );
}
