import { describe, expect, it } from "vitest";
import {
  assemblePrompt,
  assembleReply,
  EmptyMessageError,
  PromptAssembler,
} from "../src/services/prompt-assembler";

describe("assemblePrompt", () => {
  it("with all base prompts blank, sends exactly the message", () => {
    const { prompt, layers } = assemblePrompt({ globalBase: "", repoPrompts: [], message: "fix the login redirect" });
    expect(prompt).toBe("fix the login redirect");
    expect(layers).toEqual([
      { name: "global", included: false },
      { name: "repo", included: false },
      { name: "prompts", included: false },
      { name: "message", included: true },
      { name: "repos", included: false },
      { name: "attachments", included: false },
    ]);
  });

  it("lists a cross-repo task's other repos after the message, before attached files", () => {
    const { prompt, layers } = assemblePrompt({
      globalBase: "G",
      message: "M",
      otherRepos: [{ name: "api", path: "/code/api" }, { name: "web", path: "/code/web" }],
      attachmentPaths: ["/tmp/a.png"],
    });
    expect(prompt).toBe("G\n\nM\n\nOther repositories:\n- api: /code/api\n- web: /code/web\n\nAttached files:\n- /tmp/a.png");
    expect(layers.find((l) => l.name === "repos")).toEqual({ name: "repos", included: true });
  });

  it("orders global → repo → message, joined by one blank line", () => {
    const { prompt } = assemblePrompt({ globalBase: "G", repoPrompts: ["R"], message: "M" });
    expect(prompt).toBe("G\n\nR\n\nM");
  });

  it("skips an empty middle layer without leaving an extra separator", () => {
    expect(assemblePrompt({ globalBase: "G", repoPrompts: [], message: "M" }).prompt).toBe("G\n\nM");
    expect(assemblePrompt({ globalBase: "", repoPrompts: ["R"], message: "M" }).prompt).toBe("R\n\nM");
  });

  it("treats whitespace-only layers as empty", () => {
    const { prompt, layers } = assemblePrompt({ globalBase: "  \n\t ", repoPrompts: ["\n\n"], message: "M" });
    expect(prompt).toBe("M");
    expect(layers.filter((l) => l.included).map((l) => l.name)).toEqual(["message"]);
  });

  it("passes included layers through byte-for-byte (no trimming, no headings)", () => {
    const globalBase = "  Use pnpm.\n- keep diffs small\n";
    const repoBase = "# Repo notes\nNx monorepo ✓ — ünïcödé\n\n";
    const message = "\tRefactor auth  ";
    const { prompt } = assemblePrompt({ globalBase, repoPrompts: [repoBase], message });
    expect(prompt).toBe(`${globalBase}\n\n${repoBase}\n\n${message}`);
  });

  it("adds no text of its own: output length is the inputs plus separators", () => {
    const parts = { globalBase: "a".repeat(10), repoPrompts: ["b".repeat(20)], message: "c".repeat(30) };
    expect(assemblePrompt(parts).prompt).toHaveLength(10 + 20 + 30 + 2 * 2);
  });

  it("refuses an empty message", () => {
    expect(() => assemblePrompt({ globalBase: "G", repoPrompts: ["R"], message: "   " })).toThrow(EmptyMessageError);
  });
});

describe("repo prompts", () => {
  it("only the ticked ones are sent, in the order given, each verbatim, blank ones skipped", () => {
    const { prompt, layers } = assemblePrompt({ globalBase: "G", repoPrompts: ["R1", "  ", "R2\n"], message: "M" });
    expect(prompt).toBe("G\n\nR1\n\nR2\n\n\nM");
    expect(layers.find((l) => l.name === "repo")).toEqual({ name: "repo", included: true });
  });

  it("none ticked = no repo layer", () => {
    const { prompt, layers } = assemblePrompt({ globalBase: "G", repoPrompts: [], message: "M" });
    expect(prompt).toBe("G\n\nM");
    expect(layers.find((l) => l.name === "repo")).toEqual({ name: "repo", included: false });
  });
});

describe("bound saved prompts", () => {
  it("go after the repo base prompt and before the message, verbatim, blank ones skipped", () => {
    const { prompt, layers } = assemblePrompt({
      globalBase: "G",
      repoPrompts: ["R"],
      boundPrompts: ["P1", "   ", "P2\n"],
      message: "M",
    });
    expect(prompt).toBe("G\n\nR\n\nP1\n\nP2\n\n\nM");
    expect(layers.find((l) => l.name === "prompts")).toEqual({ name: "prompts", included: true });
  });

  it("replies send bound prompts before the reply", () => {
    expect(assembleReply("do it", [], ["STYLE"]).prompt).toBe("STYLE\n\ndo it");
  });
});

describe("attachments layer", () => {
  it("lists attached file paths last, only when there are files", () => {
    const { prompt, layers } = assemblePrompt({ globalBase: "G", repoPrompts: [], message: "M", attachmentPaths: ["/a/x.png", "/b/y.pdf"] });
    expect(prompt).toBe("G\n\nM\n\nAttached files:\n- /a/x.png\n- /b/y.pdf");
    expect(layers.at(-1)).toEqual({ name: "attachments", included: true });
  });

  it("replies carry their own files", () => {
    expect(assembleReply("see this", ["/a/x.png"]).prompt).toBe("see this\n\nAttached files:\n- /a/x.png");
  });
});

describe("assembleReply", () => {
  it("sends only the reply", () => {
    expect(assembleReply("looks good, now add tests").prompt).toBe("looks good, now add tests");
  });

  it("refuses an empty reply", () => {
    expect(() => assembleReply("")).toThrow(EmptyMessageError);
  });
});

describe("PromptAssembler", () => {
  it("reads the global base prompt fresh on every call", async () => {
    let globalBase = "";
    const assembler = new PromptAssembler({ globalBasePrompt: async () => globalBase });

    expect((await assembler.forTask("do it", { repoPrompts: ["Repo rules"] })).prompt).toBe("Repo rules\n\ndo it");
    globalBase = "Global rules";
    expect((await assembler.forTask("do it", { repoPrompts: ["Repo rules"] })).prompt).toBe("Global rules\n\nRepo rules\n\ndo it");
    expect((await assembler.forTask("do it")).prompt).toBe("Global rules\n\ndo it");
  });
});
