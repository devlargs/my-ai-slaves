import { storageGet, storageSet } from "@/lib/utils";
import { REF_COL } from "./layout";

/** The commit graph's resizable columns. The commit message takes whatever width is left. */
export type ColumnKey = "ref" | "graph" | "author" | "date" | "hash";

/** Column widths in px. `graph: null` means "fit the lanes" (the layout's own width). */
export interface ColumnWidths {
  ref: number;
  graph: number | null;
  author: number;
  date: number;
  hash: number;
}

export const DEFAULT_COLUMNS: ColumnWidths = { ref: REF_COL, graph: null, author: 144, date: 96, hash: 80 };
export const COLUMN_LIMITS: Record<ColumnKey, { min: number; max: number }> = {
  ref: { min: 60, max: 600 },
  graph: { min: 40, max: 800 },
  author: { min: 60, max: 400 },
  date: { min: 60, max: 300 },
  hash: { min: 56, max: 300 },
};
/** Columns right of the message grow when their left edge is dragged left. */
export const GROWS_LEFT: Record<ColumnKey, boolean> = { ref: false, graph: false, author: true, date: true, hash: true };

export const COLUMNS_KEY = "git-graph:columns";

export const clampColumn = (key: ColumnKey, px: number) => {
  const { min, max } = COLUMN_LIMITS[key];
  return Math.round(Math.min(max, Math.max(min, px)));
};

/** The width a drag gives a column: `start` plus how far the pointer moved, towards the message or away. */
export const dragWidth = (key: ColumnKey, start: number, dx: number) => clampColumn(key, start + (GROWS_LEFT[key] ? -dx : dx));

/** The graph column when it's left on "fit": the lanes' width, kept between 56 and 240 px. */
export const autoGraphWidth = (lanes: number) => Math.min(Math.max(lanes, 56), 240);

/** Saved widths, each checked and clamped; anything missing or broken falls back to the default. */
export function storedColumns(): ColumnWidths {
  let saved: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(storageGet(COLUMNS_KEY) ?? "null");
    if (v && typeof v === "object" && !Array.isArray(v)) saved = v as Record<string, unknown>;
  } catch {
    // corrupt value: use the defaults
  }
  const out: ColumnWidths = { ...DEFAULT_COLUMNS };
  for (const key of Object.keys(COLUMN_LIMITS) as ColumnKey[]) {
    const v = saved?.[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clampColumn(key, v);
  }
  return out;
}

export function saveColumns(widths: ColumnWidths): void {
  storageSet(COLUMNS_KEY, JSON.stringify(widths));
}
