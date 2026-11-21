import { LABEL_COLORS, type LabelColor } from "@my-ai-slaves/shared";
import { CheckIcon, TagIcon } from "lucide-react";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { attempt } from "@/lib/api";
import { saveLabelColor } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** `data-label-color` for a colour; gray is the plain pill, so it sets nothing. */
export function labelColorAttr(color: LabelColor): { "data-label-color"?: LabelColor } {
  return color === "gray" ? {} : { "data-label-color": color };
}

/** A repo label pill in its colour. */
export function LabelBadge({
  label,
  color,
  className,
  children,
}: {
  label: string;
  color: LabelColor;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Badge variant="default" className={cn("label-tint gap-1", className)} {...labelColorAttr(color)}>
      <TagIcon className={cn("size-3", color === "gray" ? "text-muted-foreground" : "opacity-80")} />
      {label}
      {children}
    </Badge>
  );
}

/** Popover of colour swatches for one label; the pick applies to every repo that has the label. */
export function LabelColorPicker({
  label,
  color,
  children,
}: {
  label: string;
  color: LabelColor;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-auto p-2">
        <div className="mb-1.5 px-0.5 text-[11px] text-muted-foreground">
          Colour for <span className="font-medium text-ink-2">{label}</span> (all repos)
        </div>
        <div className="flex gap-1" role="radiogroup" aria-label={`Colour for ${label}`}>
          {LABEL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={c}
              title={c}
              onClick={() => void attempt(saveLabelColor(label, c))}
              {...labelColorAttr(c)}
              className={cn(
                "label-tint flex size-6 cursor-pointer items-center justify-center rounded-full border border-rule bg-paper-2 text-ink-2 transition-shadow focus-visible:outline-2 focus-visible:outline-(--color-focus)",
                c === color ? "ring-2 ring-ink ring-offset-1 ring-offset-popover" : "hover:border-rule-strong",
              )}
            >
              {c === color && <CheckIcon className="size-3" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
