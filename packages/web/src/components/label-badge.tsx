import { LABEL_COLORS, type LabelColor } from "@my-ai-slaves/shared";
import { CheckIcon, PaletteIcon, TagIcon } from "lucide-react";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { attempt } from "@/lib/api";
import { saveLabelColor, useLabelColor } from "@/lib/hooks";
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

/** One row of colour swatches for a label; a pick applies to every repo that has the label. */
function ColorSwatches({ label, color }: { label: string; color: LabelColor }) {
  return (
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
        <ColorSwatches label={label} color={color} />
      </PopoverContent>
    </Popover>
  );
}

/** Small palette button next to a label filter: one popover to colour every label at once. */
export function LabelColorsButton({ labels, className }: { labels: string[]; className?: string }) {
  const colorOf = useLabelColor();
  if (labels.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Label colours"
          title="Label colours"
          className={cn(
            "flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-(--color-focus)",
            className,
          )}
        >
          <PaletteIcon className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-2">
        <div className="mb-2 px-0.5 text-[11px] text-muted-foreground">Label colours (all repos)</div>
        <div className="scroll-quiet flex max-h-80 flex-col gap-1.5 overflow-auto">
          {labels.map((label) => (
            <div key={label.toLowerCase()} className="flex items-center justify-between gap-4">
              <LabelBadge label={label} color={colorOf(label)} className="max-w-36 truncate" />
              <ColorSwatches label={label} color={colorOf(label)} />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
