import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-rule-strong transition-colors duration-150",
        "data-[state=checked]:bg-ink hover:data-[state=unchecked]:bg-muted-foreground/40",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 rounded-full bg-surface shadow-[0_1px_2px_oklch(0%_0_0/0.2)] transition-transform duration-150 ease-[var(--ease-out)] data-[state=checked]:translate-x-[15px] data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
}
