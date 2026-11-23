import type * as React from "react";
import { cn } from "@/lib/utils";

const field = [
  "w-full rounded-md border border-rule-strong bg-surface text-[13px] text-ink placeholder:text-muted-foreground/80",
  "transition-[border-color,box-shadow] duration-150 ease-out",
  "hover:border-muted-foreground/40",
  "focus-visible:border-signal/70 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-signal/15",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-invalid:border-danger aria-invalid:ring-danger/15",
].join(" ");

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(field, "flex h-8 px-2.5 py-1", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(field, "flex min-h-20 px-3 py-2 leading-relaxed", className)} {...props} />;
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-xs font-medium text-ink-2", className)} {...props} />;
}
