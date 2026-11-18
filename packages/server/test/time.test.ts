import { formatFileStamp, formatLocalIso } from "@my-ai-slaves/shared";
import { afterEach, describe, expect, it } from "vitest";

const original = process.env.TZ;
afterEach(() => {
  process.env.TZ = original;
});

describe("formatLocalIso", () => {
  const instant = new Date("2026-11-18T10:02:00Z");

  it("uses the local offset (+08:00)", () => {
    process.env.TZ = "Asia/Manila";
    expect(formatLocalIso(instant)).toBe("2026-11-18T18:02:00+08:00");
  });

  it("handles negative offsets", () => {
    process.env.TZ = "America/New_York";
    expect(formatLocalIso(instant)).toBe("2026-11-18T05:02:00-05:00");
  });

  it("handles half-hour offsets", () => {
    process.env.TZ = "Asia/Kolkata";
    expect(formatLocalIso(instant)).toBe("2026-11-18T15:32:00+05:30");
  });

  it("file stamp has no colons", () => {
    process.env.TZ = "Asia/Manila";
    expect(formatFileStamp(instant)).toBe("2026-11-18T18-02-00");
  });
});
