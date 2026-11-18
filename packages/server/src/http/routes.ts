import { ProviderId, SettingsFile, formatLocalIso } from "@my-ai-slaves/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdapterRegistry } from "../providers";
import type { AccountService } from "../services/account-service";
import { badRequest, HttpError } from "../services/common";
import { CommandError } from "../services/git";
import { EmptyMessageError, type PromptAssembler } from "../services/prompt-assembler";
import type { QueueService } from "../services/queue-service";
import type { RepoService } from "../services/repo-service";
import type { DataStores } from "../storage/data-stores";
import type { LoginService } from "../login/login-service";

export interface RouteDeps {
  stores: DataStores;
  accounts: AccountService;
  repos: RepoService;
  queue: QueueService;
  assembler: PromptAssembler;
  adapters: AdapterRegistry;
  logins: LoginService;
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
  const { stores, accounts, repos, queue, assembler, logins } = deps;

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof EmptyMessageError) return reply.code(400).send({ error: error.message });
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
    const body = parseBody(z.object({ label: z.string(), provider: ProviderId }), req.body);
    return accounts.create(body.label.trim(), body.provider);
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
  app.get("/api/repos", () => repos.list());
  app.post("/api/repos", async (req) => repos.register(parseBody(z.object({ path: z.string() }), req.body).path));
  app.patch("/api/repos/:id", async (req) => {
    const body = parseBody(
      z.object({
        name: z.string().optional(),
        defaultBranch: z.string().min(1).optional(),
        accountChain: z.array(z.string()).optional(),
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
  app.get("/api/repos/:id/knowledge", (req) => repos.getKnowledge(params(req).id));
  app.put("/api/repos/:id/knowledge", async (req) =>
    repos.setKnowledge(params(req).id, parseBody(z.object({ basePrompt: z.string() }), req.body).basePrompt),
  );
  app.get("/api/fs/browse", (req) => repos.browse((req.query as { path?: string }).path));

  // ── prompt preview ────────────────────────────────────────────────────────
  app.post("/api/prompt/preview", async (req) => {
    const body = parseBody(z.object({ repo: z.string(), message: z.string() }), req.body);
    if (!body.message.trim()) return { prompt: "", layers: [] };
    return assembler.forTask(body.repo, body.message);
  });

  // ── tasks ─────────────────────────────────────────────────────────────────
  app.get("/api/tasks", () => queue.list());
  app.post("/api/tasks", async (req) =>
    queue.create(
      parseBody(
        z.object({ repo: z.string(), message: z.string(), accountOverride: z.string().nullable().optional() }),
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
    await queue.reply(params(req).id, parseBody(z.object({ message: z.string() }), req.body).message);
    return { ok: true };
  });
  app.get("/api/tasks/:id/history", (req) => stores.activity.forTask(params(req).id));
  app.get("/api/tasks/:id/diff", (req) => queue.diff(params(req).id));
  app.post("/api/tasks/:id/keep", async (req) => {
    await queue.keep(params(req).id);
    return { ok: true };
  });
  app.post("/api/tasks/:id/push", (req) => queue.push(params(req).id));
  app.post("/api/tasks/:id/discard", async (req) => {
    parseBody(z.object({ confirm: z.literal(true) }), req.body);
    await queue.discard(params(req).id);
    return { ok: true };
  });

  app.get("/api/history", () => queue.history());

  // Unknown /api routes → JSON 404 (not the SPA).
  app.all("/api/*", async (_req, reply) => reply.code(404).send({ error: "Not found" }));
}
