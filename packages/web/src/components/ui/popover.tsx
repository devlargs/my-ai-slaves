import { Popover as PopoverPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-rule bg-popover text-popover-foreground shadow-float outline-none",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
