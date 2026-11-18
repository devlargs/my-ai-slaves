import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import { registerRoutes } from "./http/routes";
import { PROJECT_ROOT, resolveDataDir } from "./paths";
import { createAdapters } from "./providers";
import { createRequestGuard } from "./security/request-guard";
import { AccountService } from "./services/account-service";
import { PromptAssembler } from "./services/prompt-assembler";
import { PromptLibrary } from "./services/prompt-library";
import { QueueService } from "./services/queue-service";
import { RepoService } from "./services/repo-service";
import { BranchService } from "./services/branch-service";
import { AttachmentStore } from "./storage/attachment-store";
import { openDataStores } from "./storage/data-stores";
import { LoginService } from "./login/login-service";
import { WsHub } from "./ws/hub";

// SLAVES_PORT lets a second instance (e.g. a test copy on scratch data) run next to yours.
const PORT = Number(process.env.SLAVES_PORT) || 3005;
const HOST = "127.0.0.1"; // never 0.0.0.0
const HMR_PORT = PORT + 1;
const isProduction = process.env.NODE_ENV === "production";
const webRoot = join(PROJECT_ROOT, "packages", "web");

// ── data + services ─────────────────────────────────────────────────────────
const { stores } = await openDataStores({ dataDir: resolveDataDir() });
const adapters = createAdapters();
const hub = new WsHub();
const accounts = new AccountService(stores, adapters, hub);
const repos = new RepoService(stores);
const branches = new BranchService();
const attachments = new AttachmentStore(stores.paths.attachmentsDir);
const prompts = new PromptLibrary(stores);
const assembler = new PromptAssembler({
  globalBasePrompt: async () => (await stores.settings.read()).basePrompt,
  repoBasePrompt: (repo) => repos.basePromptOf(repo),
});
const queue = new QueueService({ stores, accounts, repos, branches, assembler, adapters, broadcaster: hub, attachments, prompts });
const logins = new LoginService(stores, accounts, adapters, {
  loginUpdated: (state) => hub.loginUpdated(state),
  onLoggedIn: () => void queue.tick(),
});
hub.setSources({
  listQueue: () => queue.list(),
  listAccounts: () => accounts.list(),
  replay: (taskId) => queue.replay(taskId),
});

// ── http ────────────────────────────────────────────────────────────────────
const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 }); // attachments have their own 20 MB limit
app.addHook("onRequest", createRequestGuard(PORT)); // before everything else, including Vite and /ws
await app.register(fastifyWebsocket);
app.register(async (scope) => {
  scope.get("/ws", { websocket: true }, (socket) => hub.handle(socket));
});
registerRoutes(app, { stores, accounts, repos, queue, assembler, adapters, logins, attachments, prompts });

let closeVite: (() => Promise<void>) | null = null;
if (isProduction) {
  await app.register(fastifyStatic, { root: join(webRoot, "dist"), wildcard: false });
  const indexHtml = await readFile(join(webRoot, "dist", "index.html"), "utf8").catch(() => null);
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && indexHtml && !req.url.startsWith("/api")) return reply.type("text/html").send(indexHtml);
    return reply.code(404).send({ error: "Not found" });
  });
} else {
  const { createServer } = await import("vite");
  const middie = (await import("@fastify/middie")).default;
  await app.register(middie);
  const vite = await createServer({
    root: webRoot,
    configFile: join(webRoot, "vite.config.ts"),
    appType: "spa",
    server: { middlewareMode: true, hmr: { port: HMR_PORT, host: "localhost" } },
  });
  closeVite = () => vite.close();
  app.use((req, res, next) => {
    const url = req.url ?? "";
    if (url.startsWith("/api") || url === "/ws" || url.startsWith("/ws?")) return next();
    vite.middlewares(req, res, next);
  });
}

try {
  await app.listen({ host: HOST, port: PORT });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use. Is My AI Slaves already running?\n`);
    process.exit(1);
  }
  throw error;
}

await queue.init();
// Reachability of every repo (SSH hosts can come and go): now, then every minute.
void repos.checkAll();
const availabilityTimer = setInterval(() => void repos.checkAll(), 60_000);
availabilityTimer.unref();
void accounts.checkAll().then(() => queue.tick()); // fresh login status + emails

console.log(`
  My AI Slaves is running ${isProduction ? "" : "(dev)"}

  Open: http://localhost:${PORT}

  Data: ${stores.paths.root}
`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: stopping. Running tasks will show as interrupted next time.`);
  logins.closeAll();
  await queue.shutdown().catch(() => {});
  await closeVite?.().catch(() => {});
  await app.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
