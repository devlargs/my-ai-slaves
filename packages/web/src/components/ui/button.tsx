import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * CTA voice (design.md): pills. `default` is ink; `signal` (coral) is reserved for the one main
 * action of a view; `outline` / `ghost` for everything secondary.
 */
export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium select-none cursor-pointer",
    "transition-[background-color,border-color,color,transform] duration-150 ease-[var(--ease-out)]",
    "active:translate-y-px disabled:pointer-events-none disabled:opacity-45",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "bg-ink text-paper hover:bg-ink-2",
        signal: "bg-signal text-on-signal hover:bg-signal-hover",
        destructive: "bg-danger text-on-signal hover:bg-danger/90",
        outline: "border border-rule-strong bg-surface text-ink hover:border-muted-foreground/40 hover:bg-paper-2",
        secondary: "bg-paper-2 text-ink hover:bg-paper-3",
        ghost: "text-ink-2 hover:bg-paper-2 hover:text-ink",
        link: "rounded-none text-signal-ink underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3.5 text-[13px]",
        sm: "h-7 px-2.5 text-xs [&_svg]:size-3.5",
        lg: "h-10 px-5 text-sm",
        icon: "size-8",
        "icon-sm": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
