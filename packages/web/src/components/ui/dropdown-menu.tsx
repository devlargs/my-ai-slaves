import { ChevronRightIcon } from "lucide-react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuSub = MenuPrimitive.Sub;

const panel =
  "z-50 min-w-48 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-rule bg-popover p-1 text-popover-foreground shadow-float outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0";
const row =
  "relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px] text-ink-2 outline-none select-none data-[highlighted]:bg-paper-2 data-[highlighted]:text-ink data-[disabled]:cursor-default data-[disabled]:opacity-40 [&_svg]:size-3.5 [&_svg]:shrink-0";

export function DropdownMenuContent({ className, sideOffset = 2, ...props }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(panel, "max-h-(--radix-dropdown-menu-content-available-height)", className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & { destructive?: boolean }) {
  return (
    <MenuPrimitive.Item
      className={cn(row, destructive && "text-danger-ink data-[highlighted]:text-danger-ink", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-rule", className)} {...props} />;
}

export function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof MenuPrimitive.SubTrigger>) {
  return (
    <MenuPrimitive.SubTrigger className={cn(row, "data-[state=open]:bg-paper-2 data-[state=open]:text-ink", className)} {...props}>
      {children}
      <ChevronRightIcon className="ml-auto" />
    </MenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent className={cn(panel, className)} {...props} />
    </MenuPrimitive.Portal>
  );
}
