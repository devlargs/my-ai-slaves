import {
  AskFollowUpRequest,
  ATTACHMENT_LIMITS,
  CreateAskRequest,
  CreateAccountRequest,
  CreatePromptRequest,
  CreateRepoPromptRequest,
  CreateTaskRequest,
  DiscardRequest,
  formatLocalIso,
  GitBranchRequest,
  GitCommitRequest,
  GitPathsRequest,
  GitPullRequest,
  GitRefAction,
  LoginCodeRequest,
  PREVIEWABLE_IMAGE_TYPES,
  PromptPreviewRequest,
  RegisterRepoRequest,
  ReorderRequest,
  ReplyRequest,
  ScriptRequest,
  SetLabelColorRequest,
  SettingsFile,
  SetVisibilityRequest,
  UpdateAskRequest,
  UpdatePromptRequest,
  UpdateRepoPromptRequest,
  UpdateRepoRequest,
} from "@my-ai-slaves/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdapterRegistry } from "../providers";
import type { AccountService } from "../services/account-service";
import type { AskService } from "../services/ask-service";
import { AvatarProxy } from "../services/avatar-proxy";
import { badRequest, HttpError } from "../services/common";
import { CommandError } from "../services/git";
import { EmptyMessageError, type PromptAssembler } from "../services/prompt-assembler";
import { listRemoteHosts } from "../remote/hosts";
import type { PromptLibrary } from "../services/prompt-library";
import type { QueueService } from "../services/queue-service";
import type { RepoActions } from "../services/repo-actions";
import type { RepoGit } from "../services/repo-git";
import { identityOf } from "../services/queue-service";
import type { RepoService } from "../services/repo-service";
import type { ScriptService } from "../services/script-service";
import { readHidden, readVisibility, shownUsage } from "../services/visibility";
import { AttachmentError, type AttachmentStore } from "../storage/attachment-store";
import type { DataStores } from "../storage/data-stores";
import type { LoginService } from "../login/login-service";

export interface RouteDeps {
  stores: DataStores;
  accounts: AccountService;
  repos: RepoService;
  queue: QueueService;
  ask: AskService;
  assembler: PromptAssembler;
  adapters: AdapterRegistry;
  logins: LoginService;
  attachments: AttachmentStore;
  prompts: PromptLibrary;
  git: RepoGit;
  actions: RepoActions;
  scripts: ScriptService;
  /** Commit-graph avatars; defaults to one that fetches from Gravatar. */
  avatars?: AvatarProxy;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`Invalid request: ${issue?.path.join(".") || "body"}: ${issue?.message}`);
  }
  return result.data;
}

const params = (req: { params: unknown }) => req.params as { id: string };

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { stores, accounts, repos, queue, ask, assembler, logins, attachments, prompts, git, actions, scripts } = deps;
  const avatars = deps.avatars ?? new AvatarProxy();

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof EmptyMessageError) return reply.code(400).send({ error: error.message });
    if (error instanceof AttachmentError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof CommandError) return reply.code(500).send({ error: error.message });
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
    console.error(error);
    return reply.code(500).send({ error: (error as Error).message || "Internal error" });
  });

  app.get("/api/session", async () => ({ ok: true, dataDir: stores.paths.root }));

  app.get("/api/data/recoveries", () => stores.recoveries);

  // ── settings ──────────────────────────────────────────────────────────────
  app.get("/api/settings", () => stores.settings.read());
  app.put("/api/settings", async (req) => {
    const body = parseBody(SettingsFile.omit({ updatedAt: true }), req.body);
    const ids = body.committers.map((c) => c.id);
    if (new Set(ids).size !== ids.length) throw badRequest("Two committers share an id.");
    // A default that was just deleted falls back to your git config.
    if (!ids.includes(body.defaultCommitterId ?? "")) body.defaultCommitterId = null;
    const saved = await stores.settings.update(() => ({ ...body, updatedAt: formatLocalIso() }));
    void queue.tick(); // concurrency may have changed
    return saved;
  });

  // ── visibility (Settings → Security) ──────────────────────────────────────
  // The one place hidden repos and subscriptions are listed. Hiding changes nothing on disk but the
  // flag: logins stay, and a hidden repo's queued tasks wait until it is shown again.
  app.get("/api/visibility", () => readVisibility(stores));
  app.put("/api/visibility", async (req) => {
    const body = parseBody(SetVisibilityRequest, req.body);
    if (body.kind === "repo") await repos.setHidden(body.id, body.hidden);
    else await accounts.setHidden(body.id, body.hidden);
    await Promise.all([accounts.publish(), queue.publish(), ask.publish()]);
    void queue.tick(); // a repo shown again runs its waiting tasks; a hidden account is skipped from now on
    return readVisibility(stores);
  });

  // ── accounts ──────────────────────────────────────────────────────────────
  app.get("/api/accounts", () => accounts.list());
  app.post("/api/accounts", async (req) => {
    const body = parseBody(CreateAccountRequest, req.body);
    return accounts.create(body.label.trim(), body.provider, body.host ?? null);
  });
  app.put("/api/accounts/order", async (req) => {
    await accounts.reorder(parseBody(ReorderRequest, req.body).ids);
    return { ok: true };
  });
  app.delete("/api/accounts/:id", async (req) => {
    await accounts.remove(params(req).id);
    await queue.publish();
    void queue.tick(); // a task that waited for it to be deleted picks another account
    return { ok: true };
  });
  app.post("/api/accounts/:id/login", (req) => logins.start(params(req).id));
  app.get("/api/logins/:id", (req) => logins.get(params(req).id));
  app.post("/api/logins/:id/code", (req) =>
    logins.submitCode(params(req).id, parseBody(LoginCodeRequest, req.body).code),
  );
  app.post("/api/logins/:id/cancel", (req) => logins.cancel(params(req).id));
  app.post("/api/accounts/:id/check", async (req) => {
    const view = await accounts.checkAuth(params(req).id);
    void queue.tick();
    return view;
  });
  app.post("/api/accounts/:id/clear-limit", async (req) => {
    const view = await accounts.clearLimit(params(req).id);
    void queue.tick();
    return view;
  });

  // ── repos & knowledge ─────────────────────────────────────────────────────
  app.get("/api/repos", () => repos.listViews());
  app.post("/api/repos", async (req) => {
    const body = parseBody(RegisterRepoRequest, req.body);
    return repos.register(body.path, body.host ?? null);
  });
  app.post("/api/repos/:id/check", async (req) => {
    const repo = await repos.get(params(req).id);
    await repos.checkAvailability(repo);
    void queue.tick();
    return repos.view(repo);
  });
  // Read-only commit graph (git log --all) for the repo's graph view.
  app.get("/api/repos/:id/graph", async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? "", 10) || 300, 1), 5000);
    const repo = await repos.get(params(req).id);
    const [graph, history] = await Promise.all([git.graph(repo, limit), actions.history(repo)]);
    return { ...graph, history };
  });
  // The graph toolbar (Undo / Redo / Pull / Branch): the only repo changes the app makes, and only on a click.
  app.post("/api/repos/:id/git/undo", async (req) => ({ history: await actions.undo(await repos.get(params(req).id)) }));
  app.post("/api/repos/:id/git/redo", async (req) => ({ history: await actions.redo(await repos.get(params(req).id)) }));
  app.post("/api/repos/:id/git/pull", async (req) => {
    const { mode } = parseBody(GitPullRequest, req.body);
    const repo = await repos.get(params(req).id);
    return { history: await actions.pull(repo, mode, identityOf(repo, await stores.settings.read())) };
  });
  app.post("/api/repos/:id/git/branch", async (req) => {
    const { name } = parseBody(GitBranchRequest, req.body);
    return { history: await actions.createBranch(await repos.get(params(req).id), name) };
  });
  // The WIP panel: stage / unstage files and commit them, only when you click it.
  app.post("/api/repos/:id/git/stage", async (req) => {
    const { paths } = parseBody(GitPathsRequest, req.body);
    await actions.stage(await repos.get(params(req).id), paths);
    return { ok: true };
  });
  app.post("/api/repos/:id/git/unstage", async (req) => {
    const { paths } = parseBody(GitPathsRequest, req.body);
    await actions.unstage(await repos.get(params(req).id), paths);
    return { ok: true };
  });
  app.post("/api/repos/:id/git/commit", async (req) => {
    const body = parseBody(GitCommitRequest, req.body);
    const repo = await repos.get(params(req).id);
    return { history: await actions.commit(repo, body, identityOf(repo, await stores.settings.read())) };
  });
  // The graph's right-click menu on a branch / commit (GitKraken's), again only on a click.
  app.post("/api/repos/:id/git/ref", async (req) => {
    const body = parseBody(GitRefAction, req.body);
    const repo = await repos.get(params(req).id);
    return { history: await actions.refAction(repo, body, identityOf(repo, await stores.settings.read())) };
  });
  // What an interactive rebase onto a branch would replay (read-only).
  app.get("/api/repos/:id/rebase-plan", async (req) => {
    const { onto } = req.query as { onto?: string };
    if (!onto || onto.length > 250) throw badRequest("Which branch to rebase onto?");
    return git.rebasePlan(await repos.get(params(req).id), onto);
  });
  // A commit vs the working directory (read-only), for "Compare commit against working directory".
  app.get("/api/repos/:id/compare/:hash", async (req) => {
    const { id, hash } = params(req) as { id: string; hash: string };
    if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw badRequest("Not a commit hash");
    return git.compare(await repos.get(id), hash);
  });
  // Uncommitted changes (read-only git status + diff), for the graph view's WIP row.
  app.get("/api/repos/:id/wip", async (req) => git.workingChanges(await repos.get(params(req).id)));
  // One commit's message, files and diff (read-only), for the graph view's details pane.
  app.get("/api/repos/:id/commits/:hash", async (req) => {
    const { id, hash } = params(req) as { id: string; hash: string };
    if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw badRequest("Not a commit hash");
    return git.commit(await repos.get(id), hash);
  });
  app.get("/api/remote/hosts", () => listRemoteHosts());
  // One colour per label, shared by every repo that has it. App only; never sent to a CLI.
  // ── repo scripts (package.json) ───────────────────────────────────────────
  app.get("/api/scripts/running", async () => {
    const hidden = await readHidden(stores);
    return { repoIds: scripts.runningRepoIds().filter((id) => !hidden.repos.has(id)) };
  });
  app.get("/api/repos/:id/scripts", async (req) => scripts.list(await repos.get(params(req).id)));
  app.post("/api/repos/:id/scripts/run", async (req) => {
    const { script } = parseBody(ScriptRequest, req.body);
    return scripts.run(await repos.get(params(req).id), script);
  });
  app.post("/api/repos/:id/scripts/stop", async (req) => {
    const { script } = parseBody(ScriptRequest, req.body);
    await scripts.stop(params(req).id, script);
    return { ok: true };
  });

  app.get("/api/label-colors", () => repos.labelColors());
  app.put("/api/label-colors", async (req) => {
    const body = parseBody(SetLabelColorRequest, req.body);
    return repos.setLabelColor(body.label, body.color);
  });
  app.patch("/api/repos/:id", async (req) => {
    const body = parseBody(UpdateRepoRequest, req.body);
    const repo = await repos.update(params(req).id, body);
    void queue.tick();
    return repo;
  });
  app.delete("/api/repos/:id", async (req) => {
    // Check first: a repo that can't be removed (queued tasks) keeps its running scripts.
    await repos.assertRemovable(params(req).id);
    await scripts.stopAll(params(req).id);
    await repos.remove(params(req).id);
    return { ok: true };
  });
  // The repo's prompts: you tick which ones each task sends (default ones come pre-ticked).
  /** A prompt's `attachmentIds` → the stored files (undefined = leave them as they are). */
  const promptFiles = async (ids: string[] | undefined) => (ids === undefined ? undefined : attachments.resolve(ids));
  const promptParams = (req: { params: unknown }) => req.params as { id: string; promptId: string };
  app.get("/api/repos/:id/prompts", async (req) => (await repos.prompts(params(req).id)).list());
  app.post("/api/repos/:id/prompts", async (req, reply) => {
    const body = parseBody(CreateRepoPromptRequest, req.body);
    const list = await repos.prompts(params(req).id);
    const files = (await promptFiles(body.attachmentIds)) ?? [];
    return reply.code(201).send(await list.create(body.name, body.body, { default: body.default ?? false, attachments: files }));
  });
  app.put("/api/repos/:id/prompts/order", async (req) => {
    await (await repos.prompts(params(req).id)).reorder(parseBody(ReorderRequest, req.body).ids);
    return { ok: true };
  });
  app.patch("/api/repos/:id/prompts/:promptId", async (req) => {
    const { id, promptId } = promptParams(req);
    const { attachmentIds, ...patch } = parseBody(UpdateRepoPromptRequest, req.body);
    return (await repos.prompts(id)).update(promptId, { ...patch, attachments: await promptFiles(attachmentIds) });
  });
  app.delete("/api/repos/:id/prompts/:promptId", async (req) => {
    const { id, promptId } = promptParams(req);
    await (await repos.prompts(id)).remove(promptId);
    return { ok: true };
  });
  app.get("/api/fs/browse", (req) => {
    const q = req.query as { path?: string; host?: string };
    return repos.browse(q.path, q.host || null);
  });

  // ── prompt preview ────────────────────────────────────────────────────────
  app.post("/api/prompt/preview", async (req) => {
    const body = parseBody(PromptPreviewRequest, req.body);
    if (!body.message.trim() && !body.attachmentIds?.length) return { prompt: "", layers: [] };
    const extras = await repos.extras(await repos.get(body.repo), body.extraRepos);
    const files = await attachments.resolve(body.attachmentIds);
    const bound = await prompts.resolve(await prompts.validate(body.promptIds));
    const repoPrompts = await repos.prompts(body.repo);
    const repoBound = await repoPrompts.resolve(
      body.repoPromptIds === undefined ? await repoPrompts.defaultIds() : await repoPrompts.validate(body.repoPromptIds),
    );
    const repoTicked = [...repoBound.prompts];
    for (const extra of extras) {
      const list = await repos.prompts(extra.id);
      const ticked = body.extraRepoPromptIds?.[extra.id];
      const got = await list.resolve(ticked === undefined ? await list.defaultIds() : await list.validate(ticked));
      repoTicked.push(...got.prompts);
    }
    // A prompt's own files go with it, before the message's (the same order the run uses).
    const allFiles = [...repoTicked, ...bound.prompts].flatMap((p) => p.attachments).concat(files);
    const paths = [...new Map(allFiles.map((a) => [a.id, attachments.pathOf(a)])).values()];
    return assembler.forTask(body.message, {
      repoPrompts: repoTicked.map((p) => p.body),
      boundPrompts: bound.prompts.map((p) => p.body),
      otherRepos: extras.map((r) => ({ name: r.name, path: r.path })),
      attachmentPaths: paths,
    });
  });

  // ── tasks ─────────────────────────────────────────────────────────────────
  app.get("/api/tasks", () => queue.list());
  app.post("/api/tasks", async (req) => queue.create(parseBody(CreateTaskRequest, req.body)));
  app.put("/api/tasks/order", async (req) => {
    await queue.reorder(parseBody(ReorderRequest, req.body).ids);
    return { ok: true };
  });
  app.post("/api/tasks/:id/cancel", async (req) => {
    await queue.cancel(params(req).id);
    return { ok: true };
  });
  app.post("/api/tasks/:id/retry", async (req) => {
    await queue.retry(params(req).id);
    return { ok: true };
  });
  app.post("/api/tasks/:id/reply", async (req) => {
    const body = parseBody(ReplyRequest, req.body);
    await queue.reply(params(req).id, body.message, body.attachmentIds, body.promptIds);
    return { ok: true };
  });
  app.get("/api/tasks/:id/history", (req) => stores.activity.forTask(params(req).id));
  app.get("/api/tasks/:id/diff", (req) => queue.diff(params(req).id));
  app.post("/api/tasks/:id/finish", async (req) => {
    await queue.markFinished(params(req).id);
    return { ok: true };
  });
  app.post("/api/tasks/:id/discard", async (req) => {
    parseBody(DiscardRequest, req.body);
    await queue.discard(params(req).id);
    return { ok: true };
  });

  // ── ask mode ──
  app.get("/api/ask", () => ask.list());
  app.post("/api/ask", async (req) => ask.create(parseBody(CreateAskRequest, req.body)));
  app.post("/api/ask/:id/messages", async (req) => {
    await ask.ask(params(req).id, parseBody(AskFollowUpRequest, req.body).message);
    return { ok: true };
  });
  app.post("/api/ask/:id/stop", async (req) => {
    await ask.stop(params(req).id);
    return { ok: true };
  });
  app.patch("/api/ask/:id", async (req) => ask.update(params(req).id, parseBody(UpdateAskRequest, req.body)));
  app.delete("/api/ask/:id", async (req) => {
    await ask.remove(params(req).id);
    return { ok: true };
  });

  app.get("/api/stats/usage", async () => ({ records: shownUsage(stores.activity.usageRecords(), await readHidden(stores)) }));

  app.get("/api/history", async (req) => {
    const q = req.query as { offset?: string; limit?: string };
    const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
    const limit = Math.min(500, Math.max(1, Math.floor(Number(q.limit) || 50)));
    return queue.historyPage(offset, limit);
  });

  // ── prompt library ────────────────────────────────────────────────────────
  app.get("/api/prompts", () => prompts.list());
  app.post("/api/prompts", async (req, reply) => {
    const body = parseBody(CreatePromptRequest, req.body);
    const files = (await promptFiles(body.attachmentIds)) ?? [];
    return reply.code(201).send(await prompts.create(body.name, body.body, { attachments: files }));
  });
  app.put("/api/prompts/order", async (req) => {
    await prompts.reorder(parseBody(ReorderRequest, req.body).ids);
    return { ok: true };
  });
  app.patch("/api/prompts/:id", async (req) => {
    const { attachmentIds, ...patch } = parseBody(UpdatePromptRequest, req.body);
    return prompts.update(params(req).id, { ...patch, attachments: await promptFiles(attachmentIds) });
  });
  app.delete("/api/prompts/:id", async (req) => {
    await prompts.remove(params(req).id);
    return { ok: true };
  });

  // ── attachments ───────────────────────────────────────────────────────────
  // One raw file per request; the name rides in the query string.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: ATTACHMENT_LIMITS.maxBytes + 1024 },
    (_req, body, done) => done(null, body),
  );
  app.post("/api/attachments", async (req, reply) => {
    const name = String((req.query as { name?: string }).name ?? "file");
    if (!Buffer.isBuffer(req.body)) throw badRequest("Send the file as application/octet-stream.");
    const type = req.headers["x-file-type"];
    const saved = await attachments.save(req.body, name, typeof type === "string" ? type : undefined);
    return reply.code(201).send(saved);
  });
  // Previews: only byte-verified images, never anything the browser could run.
  app.get("/api/attachments/:id", async (req, reply) => {
    const a = await attachments.find(params(req).id);
    if (!a || !PREVIEWABLE_IMAGE_TYPES.includes(a.mime)) return reply.code(404).send({ error: "Not found" });
    return reply
      .header("Content-Type", a.mime)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .send(await attachments.read(a));
  });

  // Commit-graph avatars: only when Settings → "Show author avatars" is on, fetched by the server so the
  // browser never talks to Gravatar. Off (the default) = 404 and the graph shows initials.
  app.get("/api/avatars/:hash", async (req, reply) => {
    const hash = (req.params as { hash: string }).hash;
    const size = Number((req.query as { s?: string }).s ?? 48);
    if (!AvatarProxy.valid(hash, size)) return reply.code(400).send({ error: "Invalid avatar request" });
    if (!(await stores.settings.read()).commitAvatars) return reply.code(404).send({ error: "Avatars are off" });
    const avatar = await avatars.get(hash, size);
    if (!avatar) return reply.code(404).send({ error: "No avatar" });
    return reply
      .header("Content-Type", avatar.type)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, max-age=86400")
      .send(avatar.body);
  });

  // Unknown /api routes → JSON 404 (not the SPA).
  app.all("/api/*", async (_req, reply) => reply.code(404).send({ error: "Not found" }));
}
