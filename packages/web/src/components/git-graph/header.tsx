import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { type ColumnKey, type ColumnWidths, DEFAULT_COLUMNS, GROWS_LEFT, dragWidth, saveColumns, storedColumns } from "./columns";

/** The graph's column widths, remembered across repos and restarts. */
export function useColumnWidths() {
  const [widths, setWidths] = useState<ColumnWidths>(storedColumns);
  const update = useCallback((key: ColumnKey, px: number | null, save: boolean) => {
    setWidths((w) => {
      const next = { ...w, [key]: px };
      if (save) saveColumns(next);
      return next;
    });
  }, []);
  return [widths, update] as const;
}

/**
 * A column edge you drag to resize the column (double-click puts it back to its default). Columns left of
 * the message have it on their right edge, the ones right of it on their left edge.
 */
function Resizer({
  col,
  width,
  onResize,
}: {
  col: ColumnKey;
  width: number;
  onResize: (key: ColumnKey, px: number | null, save: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      className={cn(
        "absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none select-none",
        "after:absolute after:inset-y-1 after:w-px after:bg-rule hover:after:bg-signal",
        dragging && "after:bg-signal",
        GROWS_LEFT[col] ? "left-0 after:left-0" : "right-0 after:right-0",
      )}
      onDoubleClick={() => onResize(col, DEFAULT_COLUMNS[col], true)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        const startX = e.clientX;
        let last = width;
        el.setPointerCapture(e.pointerId);
        setDragging(true);
        const move = (ev: PointerEvent) => {
          last = dragWidth(col, width, ev.clientX - startX);
          onResize(col, last, false);
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          setDragging(false);
          onResize(col, last, true);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
    />
  );
}

/** The commit list's header row; every column but the message can be dragged wider or narrower. */
export function GraphHeader({
  widths,
  graphWidth,
  onResize,
}: {
  widths: ColumnWidths;
  /** The graph column as drawn (its auto width when it was never resized). */
  graphWidth: number;
  onResize: (key: ColumnKey, px: number | null, save: boolean) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center border-b border-rule bg-paper-2 text-[11px] text-muted-foreground label-mono"
      style={{ height: 26 }}
    >
      <span className="relative shrink-0 truncate px-2 max-lg:max-w-24" style={{ width: widths.ref }}>
        Branch / tag
        <Resizer col="ref" width={widths.ref} onResize={onResize} />
      </span>
      <span className="relative shrink-0 truncate px-2.5" style={{ width: graphWidth }}>
        Graph
        <Resizer col="graph" width={graphWidth} onResize={onResize} />
      </span>
      <span className="min-w-0 flex-1 truncate px-2">Commit message</span>
      <span className="relative hidden shrink-0 truncate px-2 xl:block" style={{ width: widths.author }}>
        <Resizer col="author" width={widths.author} onResize={onResize} />
        Author
      </span>
      <span className="relative shrink-0 truncate px-2 max-lg:hidden" style={{ width: widths.date }}>
        <Resizer col="date" width={widths.date} onResize={onResize} />
        Date
      </span>
      <span className="relative hidden shrink-0 truncate px-2 2xl:block" style={{ width: widths.hash }}>
        <Resizer col="hash" width={widths.hash} onResize={onResize} />
        Commit
      </span>
    </div>
  );
}
