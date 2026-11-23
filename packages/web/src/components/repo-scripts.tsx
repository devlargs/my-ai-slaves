import type { RepoScripts, ScriptRun, ScriptRunInfo, ServerMessage } from "@my-ai-slaves/shared";
import { ChevronRightIcon, Loader2Icon, PlayIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { api, attempt } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { ws } from "@/lib/store";
import { cn } from "@/lib/utils";
import { isWindowActive } from "@/lib/window-active";

/** The last this many characters of a run's output are shown (the server keeps the same). */
const OUTPUT_CAP = 256 * 1024;

// Colour codes and other terminal escapes: shown as plain text here.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes on purpose
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;
const clean = (text: string) => text.replace(ANSI, "");

/**
 * The scripts of a repo's package.json (`npm run dev`, …): run one in the repo's folder, watch its
 * output, stop it. Only loads and listens while the repo is expanded (`active`).
 */
export function RepoScriptsPanel({ repoId, active }: { repoId: string; active: boolean }) {
  const { data, loading, error } = useApi<RepoScripts | null>(
    () => (active ? api.getRepoScripts(repoId) : Promise.resolve(null)),
    [repoId, active],
    active ? `repo-scripts:${repoId}` : undefined,
  );
  const runs = useScriptRuns(repoId, active);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const setOpenFor = (name: string, value: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (value) next.add(name);
      else next.delete(name);
      return next;
    });

  const run = async (name: string) => {
    setBusy(name);
    setOpenFor(name, true);
    await attempt(api.runRepoScript(repoId, name));
    setBusy(null);
  };
  const stop = async (name: string) => {
    setBusy(name);
    await attempt(api.stopRepoScript(repoId, name));
    setBusy(null);
  };

  const scripts = data?.scripts ?? [];
  const pm = data?.packageManager ?? "npm";

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Label>Scripts</Label>
        {scripts.length > 0 && <span className="num text-[11px] text-muted-foreground">{scripts.length}</span>}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        From the repo&apos;s package.json. Runs in the repo&apos;s folder{data ? <> with {pm}</> : null}; stops when the app quits.
      </p>

      {!data && loading && (
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" /> Reading package.json…
        </span>
      )}
      {error && !data && <span className="text-[11px] text-danger-ink">{error}</span>}
      {data && !data.found && <span className="text-[11px] text-muted-foreground">No package.json at the repo&apos;s root.</span>}
      {data?.found && scripts.length === 0 && (
        <span className="text-[11px] text-muted-foreground">package.json has no scripts.</span>
      )}

      {scripts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {scripts.map((s) => {
            const r = runs[s.name];
            const running = r?.status === "running";
            const expanded = open.has(s.name) && Boolean(r);
            return (
              <div key={s.name} className="rounded-lg border border-rule bg-surface">
                <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
                  <button
                    type="button"
                    disabled={!r}
                    onClick={() => setOpenFor(s.name, !open.has(s.name))}
                    aria-expanded={expanded}
                    aria-label={`Output of ${s.name}`}
                    className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-ink disabled:cursor-default disabled:opacity-30"
                  >
                    <ChevronRightIcon className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-xs text-ink">
                      {pm} run {s.name}
                    </span>
                    <span className="truncate font-mono text-[10.5px] text-muted-foreground" title={s.command}>
                      {s.command}
                    </span>
                  </div>
                  {r && <RunBadge run={r} />}
                  {running ? (
                    <Button size="sm" variant="outline" disabled={busy === s.name} onClick={() => void stop(s.name)}>
                      {busy === s.name ? <Loader2Icon className="animate-spin" /> : <SquareIcon />} Stop
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy === s.name} onClick={() => void run(s.name)}>
                      {busy === s.name ? <Loader2Icon className="animate-spin" /> : <PlayIcon />} Run
                    </Button>
                  )}
                </div>
                {expanded && r && <ScriptOutput output={r.output} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RunBadge({ run }: { run: ScriptRunInfo }) {
  switch (run.status) {
    case "running":
      return (
        <Badge variant="signal" className="shrink-0">
          <Loader2Icon className="size-3 animate-spin" /> running
        </Badge>
      );
    case "done":
      return (
        <Badge variant="success" className="shrink-0">
          done
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="shrink-0" title={run.exitCode === null ? undefined : `Exit code ${run.exitCode}`}>
          failed{run.exitCode !== null ? ` (${run.exitCode})` : ""}
        </Badge>
      );
    case "stopped":
      return (
        <Badge variant="secondary" className="shrink-0">
          stopped
        </Badge>
      );
  }
}

/** The run's output; stays scrolled to the bottom unless you scroll up. */
function ScriptOutput({ output }: { output: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const text = clean(output);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the output grows
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-72 min-h-16 overflow-auto border-t border-rule bg-paper-2/60 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-ink-2"
    >
      {text || (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <TerminalIcon className="size-3" /> No output yet.
        </span>
      )}
    </pre>
  );
}

/**
 * The latest run of each script of a repo, kept live over the WebSocket while `active`. New output
 * is applied 10 times a second in the active window, once a second otherwise.
 */
function useScriptRuns(repoId: string, active: boolean): Record<string, ScriptRun> {
  const [runs, setRuns] = useState<Record<string, ScriptRun>>({});
  useEffect(() => {
    if (!active) return;
    const pending = new Map<string, string>(); // runId → output not yet applied
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!pending.size) return;
      const chunks = new Map(pending);
      pending.clear();
      setRuns((prev) => {
        const next = { ...prev };
        for (const [name, r] of Object.entries(prev)) {
          const chunk = chunks.get(r.id);
          if (chunk) next[name] = { ...r, output: (r.output + chunk).slice(-OUTPUT_CAP) };
        }
        return next;
      });
    };
    const off = ws.addListener((msg: ServerMessage) => {
      if (!("repoId" in msg) || msg.repoId !== repoId) return;
      if (msg.type === "scripts.replay") {
        pending.clear();
        setRuns(Object.fromEntries(msg.runs.map((r) => [r.script, r])));
      } else if (msg.type === "script.updated") {
        flush();
        setRuns((prev) => {
          const old = prev[msg.run.script];
          const output = old && old.id === msg.run.id ? old.output : "";
          return { ...prev, [msg.run.script]: { ...msg.run, output } };
        });
      } else if (msg.type === "script.output") {
        pending.set(msg.runId, (pending.get(msg.runId) ?? "") + msg.chunk);
        timer ??= setTimeout(flush, isWindowActive() ? 100 : 1000);
      }
    });
    const unsubscribe = ws.subscribeRepoScripts(repoId);
    return () => {
      off();
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [repoId, active]);
  return runs;
}
