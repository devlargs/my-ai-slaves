import { ProviderId, SettingsFile, formatLocalIso } from "@my-ai-slaves/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdapterRegistry } from "../providers";
import type { AccountService } from "../services/account-service";
import { badRequest, HttpError } from "../services/common";
import { CommandError } from "../services/git";
import { EmptyMessageError, type PromptAssembler } from "../services/prompt-assembler";
import { listRemoteHosts } from "../remote/hosts";
import type { PromptLibrary } from "../services/prompt-library";
import type { QueueService } from "../services/queue-service";
import type { RepoService } from "../services/repo-service";
import { AttachmentError, type AttachmentStore } from "../storage/attachment-store";
import type { DataStores } from "../storage/data-stores";
import { ATTACHMENT_LIMITS, PREVIEWABLE_IMAGE_TYPES } from "@my-ai-slaves/shared";
import type { LoginService } from "../login/login-service";

export interface RouteDeps {
  stores: DataStores;
  accounts: AccountService;
  repos: RepoService;
  queue: QueueService;
  assembler: PromptAssembler;
  adapters: AdapterRegistry;
  logins: LoginService;
  attachments: AttachmentStore;
  prompts: PromptLibrary;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`Invalid request: ${issue?.path.join(".") || "body"}: ${issue?.message}`);
  }
  return result.data;
}

const Ids = z.object({ ids: z.array(z.string()) });
const params = (req: { params: unknown }) => req.params as { id: string };

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { stores, accounts, repos, queue, assembler, logins, attachments, prompts } = deps;

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

  // ── settings ──────────────────────────────────────────────────────────────
  app.get("/api/settings", () => stores.settings.read());
  app.put("/api/settings", async (req) => {
    const body = parseBody(SettingsFile.omit({ updatedAt: true }), req.body);
    const saved = await stores.settings.update(() => ({ ...body, updatedAt: formatLocalIso() }));
    void queue.tick(); // concurrency may have changed
    return saved;
  });

  // ── accounts ──────────────────────────────────────────────────────────────
  app.get("/api/accounts", () => accounts.list());
  app.post("/api/accounts", async (req) => {
    const body = parseBody(
      z.object({ label: z.string(), provider: ProviderId, host: z.string().min(1).nullable().optional() }),
      req.body,
    );
    return accounts.create(body.label.trim(), body.provider, body.host ?? null);
  });
  app.put("/api/accounts/order", async (req) => {
    await accounts.reorder(parseBody(Ids, req.body).ids);
    return { ok: true };
  });
  app.delete("/api/accounts/:id", async (req) => {
    await accounts.remove(params(req).id);
    await queue.publish();
    return { ok: true };
  });
  app.post("/api/accounts/:id/login", (req) => logins.start(params(req).id));
  app.get("/api/logins/:id", (req) => logins.get(params(req).id));
  app.post("/api/logins/:id/code", (req) =>
    logins.submitCode(params(req).id, parseBody(z.object({ code: z.string() }), req.body).code),
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
    const body = parseBody(z.object({ path: z.string(), host: z.string().min(1).nullable().optional() }), req.body);
    return repos.register(body.path, body.host ?? null);
  });
  app.post("/api/repos/:id/check", async (req) => {
    const repo = await repos.get(params(req).id);
    await repos.checkAvailability(repo);
    void queue.tick();
    return repos.toView(repo);
  });
  app.get("/api/remote/hosts", () => listRemoteHosts());
  app.patch("/api/repos/:id", async (req) => {
    const body = parseBody(
      z.object({
        name: z.string().optional(),
        defaultBranch: z.string().min(1).optional(),
        accountChain: z.array(z.string()).optional(),
        committerName: z.string().max(200).optional(),
        committerEmail: z.string().max(200).optional(),
        labels: z.array(z.string().max(40)).max(20).optional(),
      }),
      req.body,
    );
    const repo = await repos.update(params(req).id, body);
    void queue.tick();
    return repo;
  });
  app.delete("/api/repos/:id", async (req) => {
    await repos.remove(params(req).id);
    return { ok: true };
  });
  // The repo's prompts: you tick which ones each task sends (default ones come pre-ticked).
  const RepoPromptBody = z.object({ name: z.string().max(120), body: z.string().max(200_000), default: z.boolean().optional() });
  const promptParams = (req: { params: unknown }) => req.params as { id: string; promptId: string };
  app.get("/api/repos/:id/prompts", async (req) => (await repos.prompts(params(req).id)).list());
  app.post("/api/repos/:id/prompts", async (req, reply) => {
    const body = parseBody(RepoPromptBody, req.body);
    const list = await repos.prompts(params(req).id);
    return reply.code(201).send(await list.create(body.name, body.body, { default: body.default ?? false }));
  });
  app.put("/api/repos/:id/prompts/order", async (req) => {
    await (await repos.prompts(params(req).id)).reorder(parseBody(Ids, req.body).ids);
    return { ok: true };
  });
  app.patch("/api/repos/:id/prompts/:promptId", async (req) => {
    const { id, promptId } = promptParams(req);
    return (await repos.prompts(id)).update(promptId, parseBody(RepoPromptBody.partial(), req.body));
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
    const body = parseBody(
      z.object({
        repo: z.string(),
        message: z.string(),
        attachmentIds: z.array(z.string()).optional(),
        promptIds: z.array(z.string()).optional(),
        repoPromptIds: z.array(z.string()).optional(),
        extraRepos: z.array(z.string()).optional(),
        extraRepoPromptIds: z.record(z.string(), z.array(z.string())).optional(),
      }),
      req.body,
    );
    if (!body.message.trim()) return { prompt: "", layers: [] };
    const extras = await repos.extras(await repos.get(body.repo), body.extraRepos);
    const files = await attachments.resolve(body.attachmentIds);
    const bound = await prompts.resolve(await prompts.validate(body.promptIds));
    const repoPrompts = await repos.prompts(body.repo);
    const repoBound = await repoPrompts.resolve(
      body.repoPromptIds === undefined ? await repoPrompts.defaultIds() : await repoPrompts.validate(body.repoPromptIds),
    );
    const repoBodies = repoBound.prompts.map((p) => p.body);
    for (const extra of extras) {
      const list = await repos.prompts(extra.id);
      const ticked = body.extraRepoPromptIds?.[extra.id];
      const got = await list.resolve(ticked === undefined ? await list.defaultIds() : await list.validate(ticked));
      repoBodies.push(...got.prompts.map((p) => p.body));
    }
    return assembler.forTask(body.message, {
      repoPrompts: repoBodies,
      boundPrompts: bound.prompts.map((p) => p.body),
      otherRepos: extras.map((r) => ({ name: r.name, path: r.path })),
      attachmentPaths: files.map((a) => attachments.pathOf(a)),
    });
  });

  // ── tasks ─────────────────────────────────────────────────────────────────
  app.get("/api/tasks", () => queue.list());
  app.post("/api/tasks", async (req) =>
    queue.create(
      parseBody(
        z.object({
          repo: z.string(),
          message: z.string(),
          accountOverride: z.string().nullable().optional(),
          attachmentIds: z.array(z.string()).optional(),
          promptIds: z.array(z.string()).optional(),
          repoPromptIds: z.array(z.string()).optional(),
          extraRepos: z.array(z.string()).optional(),
          extraRepoPromptIds: z.record(z.string(), z.array(z.string())).optional(),
        }),
        req.body,
      ),
    ),
  );
  app.put("/api/tasks/order", async (req) => {
    await queue.reorder(parseBody(Ids, req.body).ids);
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
    const body = parseBody(
      z.object({ message: z.string(), attachmentIds: z.array(z.string()).optional(), promptIds: z.array(z.string()).optional() }),
      req.body,
    );
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
    parseBody(z.object({ confirm: z.literal(true) }), req.body);
    await queue.discard(params(req).id);
    return { ok: true };
  });

  app.get("/api/history", () => queue.history());

  // ── prompt library ────────────────────────────────────────────────────────
  const PromptBody = z.object({ name: z.string().max(120), body: z.string().max(200_000) });
  app.get("/api/prompts", () => prompts.list());
  app.post("/api/prompts", async (req, reply) => {
    const body = parseBody(PromptBody, req.body);
    return reply.code(201).send(await prompts.create(body.name, body.body));
  });
  app.put("/api/prompts/order", async (req) => {
    await prompts.reorder(parseBody(Ids, req.body).ids);
    return { ok: true };
  });
  app.patch("/api/prompts/:id", async (req) => prompts.update(params(req).id, parseBody(PromptBody.partial(), req.body)));
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

  // Unknown /api routes → JSON 404 (not the SPA).
  app.all("/api/*", async (_req, reply) => reply.code(404).send({ error: "Not found" }));
}
