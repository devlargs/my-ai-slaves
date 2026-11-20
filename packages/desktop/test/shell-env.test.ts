import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPath, mergePaths } from "../src/shell-env";

describe("login shell PATH", () => {
  it("reads the PATH between the markers, ignoring whatever the rc files print", () => {
    const out = "Welcome!\nnvm: using 22\n__MY_AI_SLAVES_PATH_START__/a/bin:/usr/bin__MY_AI_SLAVES_PATH_END__";
    expect(extractPath(out)).toBe("/a/bin:/usr/bin");
    expect(extractPath("no markers")).toBeNull();
    expect(extractPath("__MY_AI_SLAVES_PATH_START____MY_AI_SLAVES_PATH_END__")).toBeNull();
  });

  it("merges PATH lists, first occurrence wins", () => {
    const join = (...p: string[]) => p.join(delimiter);
    expect(mergePaths(join("/x", "/usr/bin"), undefined, join("/usr/bin", "/y"), "")).toBe(join("/x", "/usr/bin", "/y"));
  });
});
