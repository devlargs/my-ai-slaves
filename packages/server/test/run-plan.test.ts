import { randomUUID } from "node:crypto";
import { type Attachment, Repo, RepoPrompt, SavedPrompt, Task } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { EmptyMessageError } from "../src/services/prompt-assembler";
import { type LocatedFiles, planRun, type RunInputs, runFiles } from "../src/services/run-plan";

const file = (name: string): Attachment => ({ id: randomUUID(), name, mime: "image/png", size: 1 });
const repo = (id: string) => Repo.parse({ id, name: id, path: `/code/${id}`, defaultBranch: "main" });
const repoPrompt = (id: string, body: string, attachments: Attachment[] = []) => RepoPrompt.parse({ id, name: id, body, attachments });
const saved = (id: string, body: string, attachments: Attachment[] = []) => SavedPrompt.parse({ id, name: id, body, attachments });
const task = (over: Partial<Task> = {}) =>
  Task.parse({ id: "task_0001_fix", title: "fix", repo: "web", status: "pending", message: "fix the login", ...over });
const locate = (files: Attachment[]): LocatedFiles => new Map(files.map((a) => [a.id, { path: `/att/${a.id}/${a.name}`, dir: `/att/${a.id}` }]));

const inputs = (over: Partial<RunInputs> = {}): RunInputs => ({
  task: task(),
  isReply: false,
  extras: [],
  globalBase: "",
  bound: { prompts: [], missing: [] },
  repoPrompts: [{ repo: "web", prompts: [], missing: [] }],
  earlierBound: [],
  ...over,
});

const plan = (i: RunInputs) => planRun(i, locate(runFiles(i).allFiles));

describe("planRun", () => {
  it("with nothing ticked, sends exactly the message", () => {
    const p = plan(inputs());
    expect(p.assembled.prompt).toBe("fix the login");
    expect(p.addDirs).toEqual([]);
    expect(p.warnings).toEqual([]);
  });

  it("sends global base → main repo prompts → other repos' prompts → bound prompts → message → other repos → files", () => {
    const shot = file("shot.png");
    const promptShot = file("prompt.png");
    const p = plan(
      inputs({
        task: task({ attachments: [shot] }),
        globalBase: "G",
        extras: [{ repo: repo("api"), promptIds: ["api-rules"] }],
        repoPrompts: [
          { repo: "web", prompts: [repoPrompt("web-rules", "W", [promptShot])], missing: [] },
          { repo: "api", prompts: [repoPrompt("api-rules", "A")], missing: [] },
        ],
        bound: { prompts: [saved("review", "B")], missing: [] },
      }),
    );
    expect(p.assembled.prompt).toBe(
      [
        "G",
        "W\n\nA",
        "B",
        "fix the login",
        "Other repositories:\n- api: /code/api",
        `Attached files:\n- /att/${promptShot.id}/prompt.png\n- /att/${shot.id}/shot.png`,
      ].join("\n\n"),
    );
    expect(p.repoSent.map((r) => [r.repo, r.id])).toEqual([
      ["web", "web-rules"],
      ["api", "api-rules"],
    ]);
    expect(p.addDirs).toEqual(["/code/api", `/att/${promptShot.id}`, `/att/${shot.id}`]);
    expect(p.sent).toMatchObject({ kind: "user", text: "fix the login", reply: false, prompts: ["web-rules", "api-rules", "review"] });
  });

  it("warns about deleted prompts instead of sending them", () => {
    const p = plan(
      inputs({
        bound: { prompts: [], missing: ["gone"] },
        repoPrompts: [{ repo: "web", prompts: [], missing: ["old"] }],
      }),
    );
    expect(p.warnings).toEqual([
      "Saved prompt(s) no longer in the library, not sent: gone",
      "Repo prompt(s) no longer in web's list, not sent: old",
    ]);
  });

  it("a reply sends only its bound prompts, the reply and its files, but keeps earlier files readable", () => {
    const first = file("first.png");
    const again = file("again.png");
    const repoShot = file("repo.png");
    const p = plan(
      inputs({
        isReply: true,
        globalBase: "G",
        task: task({
          attachments: [first],
          pendingReply: "now the logout",
          replies: [{ at: "2026-11-24T10:00:00+08:00", message: "now the logout", attachments: [again], promptIds: [] }],
        }),
        repoPrompts: [{ repo: "web", prompts: [repoPrompt("web-rules", "W", [repoShot])], missing: ["old"] }],
        bound: { prompts: [saved("review", "B")], missing: [] },
      }),
    );
    expect(p.assembled.prompt).toBe(`B\n\nnow the logout\n\nAttached files:\n- /att/${again.id}/again.png`);
    expect(p.repoSent).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.allFiles.map((a) => a.name)).toEqual(["again.png", "first.png", "repo.png"]);
    expect(p.sent).toMatchObject({ text: "now the logout", reply: true, prompts: ["review"] });
  });

  it("lists a file only once", () => {
    const shared = file("same.png");
    const p = plan(
      inputs({
        task: task({ attachments: [shared] }),
        bound: { prompts: [saved("review", "", [shared])], missing: [] },
      }),
    );
    expect(p.runFiles).toEqual([shared]);
  });

  it("refuses an empty message with no files", () => {
    expect(() => plan(inputs({ task: task({ message: "  " }) }))).toThrow(EmptyMessageError);
  });
});
