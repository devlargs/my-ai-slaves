import { describe, expect, it } from "vitest";
import {
  COLUMNS_KEY,
  DEFAULT_COLUMNS,
  autoGraphWidth,
  clampColumn,
  dragWidth,
  saveColumns,
  storedColumns,
} from "@/components/git-graph/columns";
import { memoryStorage } from "./memory-storage";

const storage = memoryStorage();

describe("git graph columns", () => {
  it("clamps widths to each column's limits", () => {
    expect(clampColumn("ref", 10)).toBe(60);
    expect(clampColumn("ref", 5000)).toBe(600);
    expect(clampColumn("date", 120.4)).toBe(120);
  });

  it("grows left columns rightwards and right columns leftwards", () => {
    expect(dragWidth("ref", 200, 50)).toBe(250);
    expect(dragWidth("graph", 100, -30)).toBe(70);
    expect(dragWidth("author", 144, -50)).toBe(194);
    expect(dragWidth("hash", 80, 10)).toBe(70);
  });

  it("fits the graph between 56 and 240 px when never resized", () => {
    expect(autoGraphWidth(20)).toBe(56);
    expect(autoGraphWidth(120)).toBe(120);
    expect(autoGraphWidth(900)).toBe(240);
  });

  it("falls back to the defaults for missing or broken saved widths", () => {
    expect(storedColumns()).toEqual(DEFAULT_COLUMNS);
    storage.set(COLUMNS_KEY, "{not json");
    expect(storedColumns()).toEqual(DEFAULT_COLUMNS);
    storage.set(COLUMNS_KEY, JSON.stringify({ ref: "wide", graph: 9999, author: 10, date: 150 }));
    expect(storedColumns()).toEqual({ ...DEFAULT_COLUMNS, graph: 800, author: 60, date: 150 });
  });

  it("round-trips saved widths", () => {
    const widths = { ref: 300, graph: 120, author: 200, date: 110, hash: 90 };
    saveColumns(widths);
    expect(storedColumns()).toEqual(widths);
  });
});
