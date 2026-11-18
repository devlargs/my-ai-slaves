import type { LoginState } from "@my-ai-slaves/shared";
import { CheckCircle2, Copy, ExternalLink, Loader2, XCircle } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, attempt } from "@/lib/api";
import { ws } from "@/lib/store";

const FINAL = new Set(["success", "failed", "cancelled"]);

/** Log an account in from the app: open the sign-in page, (Claude) paste the code back, done. */
export function LoginDialog({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" onInteractOutside={(e) => e.preventDefault()}>
        <DialogTitle>Log in: {accountId}</DialogTitle>
        <DialogDescription>
          Uses the CLI&apos;s official sign-in. You sign in on the provider&apos;s own page; the app never sees your
          password, and the login is saved in this account&apos;s own config folder.
        </DialogDescription>
        {open && accountId && <LoginFlow accountId={accountId} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function LoginFlow({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [attemptNo, setAttemptNo] = useState(0);
  const [login, setLogin] = useState<LoginState | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const latest = useRef<LoginState | null>(null);
  latest.current = login;

  useEffect(() => {
    let loginId: string | null = null;
    let disposed = false;
    const early = new Map<string, LoginState>(); // updates that arrive before the POST returns
    setLogin(null);
    setCode("");

    const off = ws.addListener((msg) => {
      if (msg.type !== "login.updated" || msg.login.accountId !== accountId) return;
      if (loginId === null) early.set(msg.login.loginId, msg.login);
      else if (msg.login.loginId === loginId) setLogin(msg.login);
    });

    void attempt(api.loginAccount(accountId)).then((state) => {
      if (!state || disposed) return;
      loginId = state.loginId;
      setLogin(early.get(state.loginId) ?? state);
    });

    return () => {
      disposed = true;
      off();
      const current = latest.current;
      if (loginId && current && !FINAL.has(current.status)) void api.cancelLogin(loginId).catch(() => {});
    };
  }, [accountId, attemptNo]);

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (!login || !code.trim()) return;
    setSubmitting(true);
    const state = await attempt(api.submitLoginCode(login.loginId, code));
    setSubmitting(false);
    if (state) {
      setLogin(state);
      setCode("");
    }
  }

  const status = login?.status ?? "starting";
  const showLink = !!login?.url && (status === "open-url" || status === "needs-code" || status === "verifying");

  return (
    <div className="flex flex-col gap-4">
      {status === "starting" && <Step icon="spin" text="Starting the login…" />}

      {showLink && login?.url && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">1. Sign in</p>
          <div className="flex flex-wrap gap-2">
            <a href={login.url} target="_blank" rel="noreferrer noopener" className={buttonVariants()}>
              <ExternalLink className="size-4" /> Open sign-in page
            </a>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(login.url ?? "").then(
                  () => toast.success("Link copied"),
                  () => toast.error("Couldn't copy the link"),
                );
              }}
            >
              <Copy className="size-4" /> Copy link
            </Button>
          </div>
        </div>
      )}

      {status === "needs-code" && (
        <form onSubmit={submitCode} className="flex flex-col gap-2">
          <p className="text-sm font-medium">2. Paste the code shown after you sign in</p>
          <div className="flex gap-2">
            <Input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste code here"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <Button type="submit" disabled={!code.trim() || submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null} Submit
            </Button>
          </div>
        </form>
      )}

      {status === "open-url" && <Step icon="spin" text="Waiting for you to approve the login in the browser…" />}
      {status === "verifying" && <Step icon="spin" text={login?.message ?? "Checking the login…"} />}
      {status === "success" && <Step icon="ok" text="Logged in." />}
      {(status === "failed" || status === "cancelled") && (
        <Step icon="fail" text={login?.message ?? (status === "failed" ? "Login failed." : "Login cancelled.")} />
      )}

      {login?.message && (status === "needs-code" || status === "open-url") && (
        <p className="text-xs text-muted-foreground">{login.message}</p>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? "Hide details" : "Show details"}
        </button>
        <div className="flex gap-2">
          {(status === "failed" || status === "cancelled") && (
            <Button variant="outline" onClick={() => setAttemptNo((n) => n + 1)}>
              Try again
            </Button>
          )}
          <Button variant={status === "success" ? "default" : "outline"} onClick={onClose}>
            {status === "success" ? "Done" : FINAL.has(status) ? "Close" : "Cancel"}
          </Button>
        </div>
      </div>

      {showDetails && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
          {login?.output || "No output yet."}
        </pre>
      )}
    </div>
  );
}

function Step({ icon, text }: { icon: "spin" | "ok" | "fail"; text: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {icon === "spin" && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      {icon === "ok" && <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />}
      {icon === "fail" && <XCircle className="size-4 shrink-0 text-destructive" />}
      <span>{text}</span>
    </div>
  );
}
