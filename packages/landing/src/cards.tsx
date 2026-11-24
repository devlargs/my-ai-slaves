import { ArrowRightLeftIcon, CheckIcon, FileDiffIcon, ListOrderedIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Mark } from "./components/brand";
import { QueueSim } from "./components/queue-sim";
import { SCREENS, src } from "./components/showcase";
import { FallbackChain, MiniDiff, PROMPT_LAYERS } from "./components/visuals";
import { useTheme } from "./theme";

/**
 * Marketing infographics, one per `#cards/<name>`, each drawn at its export size.
 * `npm run landing:cards` saves every one as a PNG (light + dark) into public/cards/.
 */
export const CARDS: Record<string, { w: number; h: number }> = {
  og: { w: 1200, h: 630 },
  fallback: { w: 1080, h: 1080 },
  prompt: { w: 1080, h: 1080 },
  how: { w: 1080, h: 1350 },
  ...Object.fromEntries(SCREENS.map((s) => [`shot-${s.id}`, { w: 1600, h: 1000 }])),
};

export function Cards({ name }: { name: string }) {
  const { theme } = useTheme();
  const size = CARDS[name];
  if (!size) {
    return (
      <div style={{ padding: 40, fontFamily: "var(--font-mono)" }}>
        Unknown card. Try: {Object.keys(CARDS).map((k) => `#cards/${k}`).join(", ")}
      </div>
    );
  }
  const style: CSSProperties = { width: size.w, height: size.h };
  return (
    <div className="cards-root">
      <div className="mcard" style={style} data-card={name}>
        {name === "og" && <Og theme={theme} />}
        {name === "fallback" && <FallbackCard />}
        {name === "prompt" && <PromptCard />}
        {name === "how" && <HowCard />}
        {name.startsWith("shot-") && <ShotCard id={name.slice(5)} theme={theme} />}
      </div>
    </div>
  );
}

function Brand({ size = 34 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, fontWeight: 600, fontSize: size * 0.62, letterSpacing: "-0.015em" }}>
      <Mark size={size} />
      My AI Slaves
    </div>
  );
}

function Footer({ children }: { children?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <Brand />
      <span className="label" style={{ fontSize: 15 }}>
        {children ?? "Free · macOS & Windows · github.com/devlargs/my-ai-slaves"}
      </span>
    </div>
  );
}

function Og({ theme }: { theme: "light" | "dark" }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "560px 1fr", height: "100%" }}>
      <div style={{ display: "grid", alignContent: "space-between", padding: "56px 0 52px 60px" }}>
        <Brand size={38} />
        <div style={{ display: "grid", gap: 22 }}>
          <h1 className="display" style={{ fontSize: 58 }}>
            Queue the work.
            <br />
            Sleep through <span className="hero-title" style={{ fontSize: "inherit" }}><span className="strike">the limits</span></span>.
          </h1>
          <p style={{ margin: 0, fontSize: 21, color: "var(--color-ink-2)", lineHeight: 1.45 }}>
            Claude Code + Cursor tasks, run in your repos, across every subscription you have.
          </p>
        </div>
        <span className="label" style={{ fontSize: 14 }}>
          Free · open source · macOS &amp; Windows
        </span>
      </div>
      <div style={{ position: "relative", overflow: "hidden" }}>
        <div className="shot-frame" style={{ position: "absolute", left: 40, top: 70, width: 1000 }}>
          <img src={src("queue-running", theme)} alt="" />
        </div>
      </div>
    </div>
  );
}

function FallbackCard() {
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: 32, padding: 64, height: "100%" }}>
      <div style={{ display: "grid", gap: 18 }}>
        <span className="label" style={{ fontSize: 16 }}>
          <ArrowRightLeftIcon style={{ width: 16, height: 16, verticalAlign: "-2px", color: "var(--color-signal)" }} /> Account
          fallback
        </span>
        <h2 className="display" style={{ fontSize: 64 }}>
          Hit a usage limit?
          <br />
          <span className="coral">The next account</span> takes over.
        </h2>
      </div>
      <div style={{ display: "grid", alignContent: "center", gap: 28 }}>
        <div style={{ transform: "scale(1.3)", transformOrigin: "left center" }}>
          <FallbackChain />
        </div>
        <QueueSim />
      </div>
      <Footer />
    </div>
  );
}

function PromptCard() {
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: 44, padding: 72, height: "100%" }}>
      <div style={{ display: "grid", gap: 18 }}>
        <span className="label" style={{ fontSize: 16 }}>
          What the CLI receives
        </span>
        <h2 className="display" style={{ fontSize: 76 }}>
          The whole prompt.
          <br />
          <span className="coral">Nothing hidden.</span>
        </h2>
      </div>
      <div className="prompt-doc" style={{ alignSelf: "center" }}>
        <div className="head">
          <span className="label" style={{ fontSize: 13 }}>
            Exact text received
          </span>
          <span className="pill pill-done">
            <CheckIcon style={{ width: 12, height: 12 }} /> 4 layers, in order
          </span>
        </div>
        <div className="body">
          {PROMPT_LAYERS.map((l) => (
            <div key={l.k} className={`pblock ${l.k === "message" ? "msg" : ""}`} style={{ gridTemplateColumns: "190px 1fr", padding: "18px 24px" }}>
              <span className="tag" style={{ fontSize: 13 }}>
                {l.name}
              </span>
              <span className="text" style={{ fontSize: 17 }}>
                {l.text}
              </span>
            </div>
          ))}
        </div>
      </div>
      <Footer />
    </div>
  );
}

function HowCard() {
  const steps: [string, string, string, ReactNode][] = [
    ["01", "Queue it", "Pick a repo, describe the change, tick the prompts it carries.", <ListOrderedIcon key="i" />],
    ["02", "It keeps running", "In your checkout. Limit hit? The next account takes over.", <ArrowRightLeftIcon key="i" />],
    ["03", "You review", "See the diff. Reply for changes, mark finished, or discard.", <FileDiffIcon key="i" />],
  ];
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: 48, padding: 72, height: "100%" }}>
      <div style={{ display: "grid", gap: 18 }}>
        <span className="label" style={{ fontSize: 16 }}>
          How it works
        </span>
        <h2 className="display" style={{ fontSize: 84 }}>
          Write the task.
          <br />
          Walk away.
          <br />
          <span className="coral">Review the diff.</span>
        </h2>
      </div>
      <div style={{ display: "grid", gap: 18, alignContent: "center" }}>
        {steps.map(([n, t, d, icon]) => (
          <div key={n} className="step" style={{ gridTemplateColumns: "64px 1fr", alignItems: "center", gap: 22, padding: "26px 30px" }}>
            <span className="n" style={{ fontSize: 22 }}>
              {n}
            </span>
            <div style={{ display: "grid", gap: 6 }}>
              <h3 style={{ fontSize: 30, display: "flex", gap: 12, alignItems: "center" }}>
                {t}
                <span style={{ color: "var(--color-muted)", display: "inline-flex", width: 24, height: 24 }}>{icon}</span>
              </h3>
              <p style={{ fontSize: 20 }}>{d}</p>
            </div>
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <MiniDiff />
        </div>
      </div>
      <Footer />
    </div>
  );
}

function ShotCard({ id, theme }: { id: string; theme: "light" | "dark" }) {
  const s = SCREENS.find((x) => x.id === id);
  if (!s) return null;
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: 40, padding: "64px 80px 0", height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "end", gap: 40 }}>
        <div style={{ display: "grid", gap: 14 }}>
          <span className="label" style={{ fontSize: 16 }}>
            {s.tab}
          </span>
          <h2 className="display" style={{ fontSize: 62 }}>
            {s.title}
          </h2>
        </div>
        <Brand size={40} />
      </div>
      <div className="shot-frame" style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottom: 0 }}>
        <div className="chrome" aria-hidden="true">
          <i />
          <i />
          <i />
          <span>My AI Slaves</span>
        </div>
        <img src={src(s.id, theme)} alt="" style={{ aspectRatio: "auto" }} />
      </div>
    </div>
  );
}
