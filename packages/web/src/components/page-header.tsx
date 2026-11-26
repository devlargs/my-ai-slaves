import { ArrowLeftIcon } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Every page starts with this: title, one line of context, actions on the right, hairline below. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-rule pb-5", className)}>
      <div className="min-w-0 max-w-2xl">
        <h1 className="title-display text-(length:--text-title) leading-tight">{title}</h1>
        {description && <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Small header for a panel inside a page (queue column, task detail). */
export function PanelHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-12 shrink-0 items-center gap-2 border-b border-rule px-4", className)}>{children}</div>
  );
}

/**
 * Narrow windows (below `lg`) show a two-pane page one pane at a time. This bar sits on top of the
 * detail pane and goes back to the list; wide windows never show it.
 */
export function BackBar({ label, onBack, className }: { label: string; onBack: () => void; className?: string }) {
  return (
    <div className={cn("flex h-11 shrink-0 items-center border-b border-rule px-2 lg:hidden", className)}>
      <Button size="sm" variant="ghost" className="h-8" onClick={onBack}>
        <ArrowLeftIcon /> {label}
      </Button>
    </div>
  );
}
