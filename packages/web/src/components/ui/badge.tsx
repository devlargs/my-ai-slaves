import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/** Soft pills. Status colour is always paired with its word. */
const badgeVariants = cva(
  "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-medium leading-none whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-paper-2 text-ink-2",
        signal: "border-transparent bg-signal-soft text-signal-ink",
        secondary: "border-transparent bg-paper-2 text-muted-foreground",
        outline: "border-rule bg-transparent text-muted-foreground",
        success: "border-transparent bg-success-soft text-success-ink",
        warning: "border-transparent bg-warning-soft text-warning-ink",
        destructive: "border-transparent bg-danger-soft text-danger-ink",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
