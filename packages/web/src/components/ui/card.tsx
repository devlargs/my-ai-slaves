import type * as React from "react";
import { cn } from "@/lib/utils";

/** Panels: hairline border, no shadow (depth is reserved for floating layers). */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-lg border border-rule bg-card text-card-foreground", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-rule px-4 py-2.5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 className={cn("title-display text-sm", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}
