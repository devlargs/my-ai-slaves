import type { GraphCommit } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { DOT, ROW, WIP, edgePath, layout, wipCommit, x } from "@/components/git-graph/layout";

const c = (hash: string, parents: string[] = [], refs: string[] = []): GraphCommit => ({
  hash,
  parents,
  author: "a",
  email: "a@example.com",
  avatar: "",
  date: "2026-01-01T00:00:00Z",
  subject: hash,
  refs,
});
const lanes = (commits: GraphCommit[], pinned: string | null = null) => layout(commits, pinned).rows.map((r) => r.lane);

describe("git graph lane layout", () => {
  it("keeps a straight history in lane 0", () => {
    const { rows, width } = layout([c("c", ["b"]), c("b", ["a"]), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    // One lane: padding on both sides plus the avatar.
    expect(width).toBe(14 * 2 + DOT * 2);
    // The root commit has no line going down.
    expect(rows[2]!.edges.some((e) => e.half === "bottom")).toBe(false);
    expect(rows[0]!.edges).toEqual([expect.objectContaining({ from: 0, to: 0, half: "bottom" })]);
  });

  it("opens a lane for a merge's second parent and converges it back", () => {
    // m merges f into main; f and b both come from a.
    const commits = [c("m", ["b", "f"]), c("f", ["a"]), c("b", ["a"]), c("a")];
    const { rows, width } = layout(commits);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    expect(width).toBe(14 * 2 + 28 + DOT * 2);
    // The merge row draws a line to the second parent's lane.
    expect(rows[0]!.edges).toContainEqual(expect.objectContaining({ from: 0, to: 1, half: "bottom" }));
    // b's row: lane 1 (waiting for a) passes through.
    expect(rows[2]!.edges).toContainEqual(expect.objectContaining({ from: 1, to: 1, through: true }));
    // a's row: both lanes converge into lane 0.
    expect(rows[3]!.edges).toContainEqual(expect.objectContaining({ from: 1, to: 0, half: "top" }));
    expect(rows[3]!.edges).toContainEqual(expect.objectContaining({ from: 0, to: 0, half: "top" }));
  });

  it("gives two branch tips their own lanes and colours", () => {
    const { rows } = layout([c("x", ["a"]), c("y", ["a"]), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(rows[0]!.color).not.toBe(rows[1]!.color);
  });

  it("keeps lane 0 for a pinned branch until its tip arrives", () => {
    const commits = [c("x", ["a"]), c("p", ["a"]), c("a")];
    expect(lanes(commits)).toEqual([0, 1, 0]);
    expect(lanes(commits, "p")).toEqual([1, 0, 0]);
    // A pinned hash that isn't loaded changes nothing.
    expect(lanes(commits, "missing")).toEqual([0, 1, 0]);
  });

  it("draws the WIP row's line to the checked-out commit dashed", () => {
    const { rows } = layout([wipCommit("b"), c("b", ["a"]), c("a")]);
    expect(rows[0]!.commit.hash).toBe(WIP);
    expect(rows[0]!.edges).toEqual([expect.objectContaining({ half: "bottom", dashed: true })]);
    expect(rows[1]!.edges).toContainEqual(expect.objectContaining({ half: "top", dashed: true }));
    // Below the checked-out commit the line is solid again.
    expect(rows[1]!.edges.find((e) => e.half === "bottom")?.dashed).toBe(false);
    expect(wipCommit(null).parents).toEqual([]);
  });

  it("draws a line down to parents outside the loaded page", () => {
    const { rows } = layout([c("b", ["not-loaded"])]);
    expect(rows[0]!.edges).toContainEqual(expect.objectContaining({ half: "bottom" }));
  });

  it("builds SVG paths for straight, curved and pass-through edges", () => {
    expect(edgePath({ from: 0, to: 0, half: "top", color: "" })).toBe(`M${x(0)} 0V${ROW / 2}`);
    expect(edgePath({ from: 1, to: 1, half: "top", through: true, color: "" })).toBe(`M${x(1)} 0V${ROW}`);
    expect(edgePath({ from: 0, to: 1, half: "bottom", color: "" })).toMatch(new RegExp(`^M${x(0)} ${ROW / 2}C`));
  });
});
