# Design — My AI Slaves

A locked design system for this app. Every screen reads this file before its UI changes. Do not
re-pick a theme per page; extend or amend this file when the system needs to grow. Tokens live in
`packages/web/src/tokens.css`; `packages/web/src/index.css` maps them onto Tailwind and the
shadcn-style variable names the components use.

## Genre

modern-minimal: a calm developer tool. An instrument panel, not a marketing page.

## Macrostructure family

- **App pages** (Queue, Repos, Settings, History): _Workbench_. A fixed sidebar (wordmark, live
  status, text nav, accounts), then either
  - a **two-pane workbench** (Queue, History): a 420–440px list column with a `PanelHeader`, and a
    detail pane with its own title block and underline tabs; or
  - a **single column** (Repos, Settings): `max-w-4xl`, `PageHeader` (title + one line + hairline),
    then hairline panels stacked 24px apart.
- No marketing or content pages. If one is added, it uses this theme with a left-aligned title.

## Theme: Coral (light + dark, follows the OS)

| token | light | dark | use |
| --- | --- | --- | --- |
| `--color-paper` | oklch(98.4% 0.004 75) | oklch(17.5% 0.006 55) | page background, warm grey, never #fff |
| `--color-paper-2` | oklch(96.1% 0.006 72) | oklch(21.5% 0.007 55) | sidebar, fills, hovers |
| `--color-surface` | oklch(99.6% 0.002 75) | oklch(20% 0.007 55) | panels, cards, fields, popovers |
| `--color-ink` | oklch(23% 0.012 55) | oklch(94% 0.006 75) | text, default buttons |
| `--color-muted` | oklch(52% 0.012 60) | oklch(67% 0.01 65) | secondary text (≥ 4.5:1 on paper) |
| `--color-rule` | oklch(91.5% 0.007 70) | oklch(28.5% 0.008 55) | every border is this hairline |
| `--color-signal` | oklch(57% 0.185 35) | oklch(70% 0.16 40) | **the one accent** (coral) |
| `--color-focus` | oklch(62% 0.17 38) | oklch(72% 0.15 40) | focus rings |

Status: `success` / `warning` / `danger`, each with `-soft` (fill) and `-ink` (text) steps. Status
colour is always paired with a word or an icon.

**Coral budget (< 5% of any view):** the view's one main action, the running/live state, the
active tab underline, the selected list item, focus. Never decorative icons, never every row.

## Typography

- One family: **Geist** (variable) for display and body; **Geist Mono** for code, paths, ids,
  times, diffs and the `.label-mono` voice (11px, 500, uppercase, 0.06em).
- Titles: `.title-display` (600, −0.022em). Page titles 22px, panel titles 15px, task titles 18px.
- Body 13px / 1.5. Numbers in counts and times use `.num` (tabular).
- No italic headings, no gradient text.

## Spacing & radii

4-pt scale. Single-column pages: 32px gutters, 24px between panels. Radii: fields and selects 8px
(`rounded-md`), panels, cards and dialogs 12px (`rounded-lg` / `rounded-xl`), buttons, badges and
chips are pills.

## Depth

Hairlines do the work: panels have a 1px `--color-rule` border and no shadow. Only floating layers
(select menu, dialog) get `--shadow-float`. Overlays dim with a warm ink scrim. No glass.

## Motion

Composed and sparse: colour/border shifts at 150ms with `--ease-out`, a 1px press on buttons. The
only looping motion is the live dot on running work and the streaming caret. Reduced motion turns
both off.

## Microinteractions stance

- Destructive actions are muted until hover and always confirm in a dialog that names what is lost.
- Selected list items get a coral border + soft ring; hover only darkens the hairline.
- Files attach by paste, drop or the paperclip; each uploads immediately and shows as a chip.

## CTA voice

- **Signal** (`<Button variant="signal">`): coral pill. **One per view**: Queue, Reply,
  Push + open PR/MR, Log in when an account is logged out.
- **Default**: ink pill, for ordinary confirmations and saves.
- **Outline / ghost**: secondary and tertiary actions.

## What every page MUST share

- The sidebar (mark + wordmark, live status, nav with raised active item, accounts with dots).
- `PageHeader` / `PanelHeader` (`packages/web/src/components/page-header.tsx`).
- The type pair, `.label-mono` voice, coral budget and CTA voice above.

## What pages MAY differ on

- Two-pane workbench vs single column.
- Panel composition inside a page.

## Exports

### tokens.css

`packages/web/src/tokens.css` is the source of truth.

### Tailwind v4 `@theme`

Wired in `packages/web/src/index.css`: `bg-paper`, `bg-surface`, `text-ink-2`, `border-rule`,
`bg-signal`, `text-signal-ink`, `bg-success-soft`, `text-warning-ink`, `shadow-float`, …

### shadcn/ui CSS variables

`--background` → paper · `--foreground` → ink · `--card` / `--popover` → surface · `--primary` → ink ·
`--muted` / `--accent` / `--secondary` → paper-2 · `--border` → rule · `--input` → rule-strong ·
`--ring` → focus · `--destructive` → danger.
