import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import { registerRoutes } from "./http/routes";
import { PROJECT_ROOT, resolveDataDir } from "./paths";
import { createAdapters } from "./providers";
import { registerCsp } from "./security/csp";
import { createRequestGuard } from "./security/request-guard";
import { AccountService } from "./services/account-service";
import { AskService } from "./services/ask-service";
import { PromptAssembler } from "./services/prompt-assembler";
import { PromptLibrary } from "./services/prompt-library";
import { QueueService } from "./services/queue-service";
import { RepoService } from "./services/repo-service";
import { RepoActions } from "./services/repo-actions";
import { RepoGit } from "./services/repo-git";
import { ScriptService } from "./services/script-service";
import { AttachmentStore } from "./storage/attachment-store";
import { openDataStores } from "./storage/data-stores";
import { NewerDataFileError } from "./storage/json-store";
import { LoginService } from "./login/login-service";
import { WsHub } from "./ws/hub";

// Started by the desktop app (Electron running as plain Node): the CLIs this server spawns must not
// inherit that, or an Electron-based CLI would start as Node too.
delete process.env.ELECTRON_RUN_AS_NODE;

// SLAVES_PORT lets a second instance (e.g. a test copy on scratch data) run next to yours.
const PORT = Number(process.env.SLAVES_PORT) || 3005;
const HOST = "127.0.0.1"; // never 0.0.0.0
const HMR_PORT = PORT + 1;
const isProduction = process.env.NODE_ENV === "production";
// SLAVES_WEB_DIR: where the built web app sits when this runs bundled inside the desktop app.
const webRoot = process.env.SLAVES_WEB_DIR ? resolve(process.env.SLAVES_WEB_DIR) : join(PROJECT_ROOT, "packages", "web");

// ── data + services ─────────────────────────────────────────────────────────
// Activity is appended at most about once a second: a streaming run logs many entries, and each write
// appends their lines in one go. Shutdown writes whatever is still waiting and saves the activity index.
const stores = await openDataStores({ dataDir: resolveDataDir(), activityFlushDelayMs: 1000 }).then(
  (opened) => opened.stores,
  async (error: unknown) => {
    if (!(error instanceof NewerDataFileError)) throw error;
    // Refuse to start rather than replace data a newer build wrote. The desktop app shows this message.
    console.error(`\n${error.message}\n`);
    if (process.send) process.send({ type: "startup-error", message: error.message }, () => process.exit(1));
    else process.exit(1);
    return new Promise<never>(() => {});
  },
);
const adapters = createAdapters();
const hub = new WsHub();
const accounts = new AccountService(stores, adapters, hub);
const repos = new RepoService(stores);
const git = new RepoGit();
const attachments = new AttachmentStore(stores.paths.attachmentsDir);
const prompts = new PromptLibrary(stores);
const scripts = new ScriptService(hub);
const assembler = new PromptAssembler({
  globalBasePrompt: async () => (await stores.settings.read()).basePrompt,
});
const queue = new QueueService({ stores, accounts, repos, git, assembler, adapters, broadcaster: hub, attachments, prompts });
const ask = new AskService({ stores, accounts, repos, adapters, broadcaster: hub });
// Deleting an account is refused while a task or a chat runs on it.
accounts.useTaskLock((accountId) => queue.taskUsingAccount(accountId) ?? ask.chatUsingAccount(accountId));
const actions = new RepoActions((repoId) => queue.busyRepoIds().has(repoId));
// Tasks wait for a graph action (pull, rebase…) in their repo, and start once it's done.
queue.useRepoActionLock((repoId) => actions.inFlight(repoId));
actions.onIdle(() => void queue.tick());
const logins = new LoginService(stores, accounts, adapters, {
  loginUpdated: (state) => hub.loginUpdated(state),
  onLoggedIn: () => void queue.tick(),
});
hub.setSources({
  listQueue: () => queue.list(),
  listAccounts: () => accounts.list(),
  replay: (taskId) => (AskService.isChatId(taskId) ? ask.replay(taskId) : queue.replay(taskId)),
  scriptRuns: (repoId) => scripts.replay(repoId),
});

// ── http ────────────────────────────────────────────────────────────────────
const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 }); // attachments have their own 20 MB limit
app.addHook("onRequest", createRequestGuard(PORT)); // before everything else, including Vite and /ws
if (isProduction) registerCsp(app, PORT); // the built page and its assets; Vite's dev server needs inline scripts
await app.register(fastifyWebsocket);
app.register(async (scope) => {
  scope.get("/ws", { websocket: true }, (socket) => hub.handle(socket));
});
registerRoutes(app, { stores, accounts, repos, queue, ask, assembler, adapters, logins, attachments, prompts, git, actions, scripts });

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
    // The desktop app shows its own message for this; wait for it to arrive before exiting.
    if (process.send) process.send({ type: "port-in-use", port: PORT }, () => process.exit(1));
    else process.exit(1);
    await new Promise(() => {});
  }
  throw error;
}

await ask.init();
await ask.loadBuffers();
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
async function shutdown(signal: string, opts: { resume?: boolean } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: stopping. Running tasks will show as interrupted next time.`);
  logins.closeAll();
  await ask.shutdown().catch(() => {});
  await queue.shutdown(opts).catch(() => {});
  await scripts.stopAll().catch(() => {});
  await closeVite?.().catch(() => {});
  await app.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Desktop app: tell it where to load the UI from, stop cleanly when it quits (Windows has no
// SIGTERM to catch), and never outlive it if it crashes.
if (process.send) {
  process.send({ type: "ready", port: PORT, dataDir: stores.paths.root });
  process.on("message", (message) => {
    const m = message as { type?: string; resumeRunning?: boolean } | null;
    // `resumeRunning`: quitting for "Update and restart", so running tasks run again on the next start.
    if (m?.type === "shutdown") void shutdown(m.resumeRunning ? "update" : "quit", { resume: m.resumeRunning === true });
  });
  process.on("disconnect", () => void shutdown("desktop app closed"));
}
