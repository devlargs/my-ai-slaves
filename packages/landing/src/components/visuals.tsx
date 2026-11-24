/** Small, static infographics drawn in HTML/SVG with the app's tokens (crisp at any size, both themes). */

export function FallbackChain({ short = false }: { short?: boolean }) {
  return (
    <div className="chain">
      <span className="acct-chip limited">
        <span className="dot" />
        work-max
      </span>
      <span className="arrow">→</span>
      <span className="acct-chip running">
        <span className="dot dot-live" />
        personal-pro
      </span>
      <span className="arrow">→</span>
      <span className="acct-chip">
        <span className="dot" />
        side-max
      </span>
      {!short && (
        <>
          <span className="arrow">→</span>
          <span className="acct-chip">
            <span className="dot" />
            cursor
          </span>
        </>
      )}
    </div>
  );
}

export const PROMPT_LAYERS = [
  { k: "global", name: "Global base prompt", text: "Keep changes small. Run typecheck and tests before you finish." },
  { k: "repo", name: "Repo prompts you ticked", text: "Work on a new branch. Conventional Commits. Open a merge request." },
  { k: "saved", name: "Saved prompts you bound", text: "End with the root cause and how you verified the fix." },
  { k: "message", name: "Your message", text: "Fix the crash on Android when the cart is empty." },
] as const;

export function PromptLayers({ compact = false }: { compact?: boolean }) {
  return (
    <div className="layers">
      {PROMPT_LAYERS.map((l, i) => (
        <div key={l.k} className={`layer ${l.k === "message" ? "msg" : ""}`}>
          <span className="i">{i + 1}</span>
          <span>{l.name}</span>
          {!compact && <span className="k">{l.k}</span>}
        </div>
      ))}
    </div>
  );
}

export function MiniDiff() {
  return (
    <div className="diff">
      <div className="file">src/screens/CartScreen.tsx · +1 −1</div>
      <div className="ctx"> const {"{ items, total }"} = useCart();</div>
      <div className="del">- const currency = items[0].currency;</div>
      <div className="add">+ const currency = items[0]?.currency ?? store.defaultCurrency;</div>
      <div className="ctx"> return &lt;CartList items={"{items}"} /&gt;;</div>
    </div>
  );
}

const BAR_HEIGHTS = [34, 52, 41, 70, 48, 62, 88, 55, 46, 74, 60, 92, 66, 58];

export function MiniBars() {
  return (
    <div className="bars" aria-hidden="true">
      {BAR_HEIGHTS.map((h, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed decorative list
          key={i}
          className={i === 11 ? "hot" : ""}
          style={{ height: `${h}%`, animationDelay: `${i * 40}ms` }}
        />
      ))}
    </div>
  );
}

/** A tiny commit graph: main + two feature lanes merging back. */
export function MiniGraph() {
  const lane = (x: number) => 14 + x * 20;
  const row = (y: number) => 12 + y * 22;
  const dots: [number, number, string][] = [
    [0, 0, "var(--color-signal)"],
    [1, 1, "oklch(62% 0.14 250)"],
    [1, 2, "oklch(62% 0.14 250)"],
    [0, 3, "var(--color-signal)"],
    [2, 4, "oklch(62% 0.13 150)"],
    [0, 5, "var(--color-signal)"],
    [0, 6, "var(--color-signal)"],
  ];
  const labels = [
    "fix: price rounding in summary",
    "feat(reviews): moderation queue",
    "feat(reviews): stars + text",
    "feat: wishlist",
    "fix(cart): badge after remove",
    "perf: preload hero font",
    "chore: initial commit",
  ];
  return (
    <svg viewBox="0 0 320 162" width="100%" role="img" aria-label="Commit graph">
      <path d={`M${lane(0)} ${row(0)} V${row(6)}`} stroke="var(--color-signal)" strokeWidth="2" fill="none" />
      <path
        d={`M${lane(0)} ${row(0)} C${lane(1)} ${row(0)}, ${lane(1)} ${row(0)}, ${lane(1)} ${row(1)} V${row(2)} C${lane(1)} ${row(3)}, ${lane(0)} ${row(3)}, ${lane(0)} ${row(3)}`}
        stroke="oklch(62% 0.14 250)"
        strokeWidth="2"
        fill="none"
      />
      <path
        d={`M${lane(0)} ${row(3)} C${lane(2)} ${row(3)}, ${lane(2)} ${row(3)}, ${lane(2)} ${row(4)} C${lane(2)} ${row(5)}, ${lane(0)} ${row(5)}, ${lane(0)} ${row(5)}`}
        stroke="oklch(62% 0.13 150)"
        strokeWidth="2"
        fill="none"
      />
      {dots.map(([x, y, c]) => (
        <circle key={`${x}-${y}`} cx={lane(x)} cy={row(y)} r="5.5" fill="var(--color-surface)" stroke={c} strokeWidth="2" />
      ))}
      {labels.map((l, i) => (
        <text key={l} x="78" y={row(i) + 4} fontSize="11" fill={i === 0 ? "var(--color-ink)" : "var(--color-ink-2)"} fontFamily="var(--font-sans)">
          {l}
        </text>
      ))}
    </svg>
  );
}

export function MiniTerm() {
  return (
    <div className="term" aria-label="A remote repo runs over ssh">
      <span>
        <span className="p">repo</span> payments-api <span className="c">on</span> build-box <span className="c">(ssh)</span>
      </span>
      <span className="c">$ ssh build-box -- claude -p …</span>
      <span>
        ✓ <span className="c">git, the CLI and its login run on the server</span>
      </span>
    </div>
  );
}

export function MiniChat() {
  return (
    <div className="chat">
      <div className="bubble you">Where is the session refresh handled?</div>
      <div className="bubble ai">
        In <code>src/auth/session.ts</code>: <code>refreshSession()</code> retries the 401s once the new token lands.
      </div>
    </div>
  );
}
