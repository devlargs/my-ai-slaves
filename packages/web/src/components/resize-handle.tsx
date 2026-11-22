import { useCallback, useEffect, useRef, useState } from "react";
import { cn, storageGet, storageSet } from "@/lib/utils";

interface ResizableOptions {
  /** localStorage key the width is remembered under. */
  key: string;
  initial: number;
  min: number;
  max: number;
  /** Space (px) the rest of the window must keep, so a panel can't push its neighbour off screen. */
  reserve?: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** A panel width the user can drag, like a code editor's side bar. Remembered across restarts. */
export function useResizableWidth({ key, initial, min, max, reserve = 0 }: ResizableOptions) {
  const limit = useCallback(
    (value: number) => clamp(Math.round(value), min, Math.min(max, window.innerWidth - reserve)),
    [min, max, reserve],
  );
  const [width, setWidthState] = useState(() => {
    const stored = Number(storageGet(key));
    return limit(Number.isFinite(stored) && stored > 0 ? stored : initial);
  });
  const setWidth = useCallback(
    (value: number) => {
      const next = limit(value);
      setWidthState(next);
      storageSet(key, String(next));
    },
    [key, limit],
  );
  // Keep it inside the window when the window shrinks (only listens; no work while idle).
  useEffect(() => {
    const onResize = () => setWidthState((w) => limit(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [limit]);
  return { width, setWidth, reset: () => setWidth(initial), min, max };
}

/**
 * A thin vertical drag handle on a panel's right edge. Drag to resize, double-click to reset,
 * arrow keys when focused. Sits over the panel's border, so it takes no layout space.
 */
export function ResizeHandle({
  width,
  setWidth,
  reset,
  min,
  max,
  label,
  className,
}: ReturnType<typeof useResizableWidth> & { label: string; className?: string }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    // While dragging, keep the resize cursor everywhere and stop text getting selected.
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className={cn(
        "group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none outline-none",
        className,
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        setWidth(start.current.width + e.clientX - start.current.x);
      }}
      onPointerUp={(e) => {
        start.current = null;
        setDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDragging(false);
      }}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft") setWidth(width - step);
        else if (e.key === "ArrowRight") setWidth(width + step);
        else if (e.key === "Home") setWidth(min);
        else if (e.key === "End") setWidth(max);
        else return;
        e.preventDefault();
      }}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors duration-150",
          dragging ? "bg-signal" : "bg-transparent group-hover:bg-signal/50 group-focus-visible:bg-signal/70",
        )}
      />
    </div>
  );
}
