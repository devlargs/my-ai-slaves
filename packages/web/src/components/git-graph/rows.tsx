import type { GraphCommit, WipSummary } from "@my-ai-slaves/shared";
import { CheckIcon, CloudIcon, FileMinusIcon, FilePenIcon, FilePlusIcon, LaptopIcon, TagIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ROW, DOT } from "./layout";
import type { RefGroup } from "./view-state";

export const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";
/**
 * The author's Gravatar (by SHA-256 email hash), fetched through this app's server so the browser never
 * contacts gravatar.com. Only used when Settings → "Show author avatars" is on.
 */
export const avatarUrl = (hash: string, size: number) => `/api/avatars/${hash}?s=${size}`;

/**
 * The commit's mark on its lane: the author's initial in a ring of the lane's colour, with their Gravatar
 * over it when avatars are on (the initial shows while it loads or when there is none). Merges get a dashed ring.
 */
export function CommitAvatar({
  commit,
  cx,
  color,
  avatars,
}: {
  commit: GraphCommit;
  cx: number;
  color: string;
  avatars: boolean;
}) {
  const cy = ROW / 2;
  const r = DOT - 1;
  const clip = `avatar-${commit.hash}`;
  const [failed, setFailed] = useState(false);
  return (
    <g>
      <clipPath id={clip}>
        <circle cx={cx} cy={cy} r={r} />
      </clipPath>
      <circle cx={cx} cy={cy} r={r} fill="var(--color-surface)" />
      <text
        x={cx}
        y={cy}
        dy="0.35em"
        textAnchor="middle"
        fontSize={11}
        fontWeight={600}
        fill={color}
        style={{ userSelect: "none" }}
      >
        {initial(commit.author)}
      </text>
      {avatars && commit.avatar && !failed && (
        <image
          href={avatarUrl(commit.avatar, 48)}
          x={cx - r}
          y={cy - r}
          width={r * 2}
          height={r * 2}
          clipPath={`url(#${clip})`}
          preserveAspectRatio="xMidYMid slice"
          onError={() => setFailed(true)}
        >
          <title>{commit.author}</title>
        </image>
      )}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeDasharray={commit.parents.length > 1 ? "3 2" : undefined}
      />
    </g>
  );
}

function RefPill({ group, color }: { group: RefGroup; color: string }) {
  const title =
    group.kind === "tag"
      ? `Tag ${group.name}`
      : group.kind === "detached"
        ? "Detached HEAD"
        : [group.head && "checked out", group.local && "local", ...group.remotes.map((r) => `on ${r}`)].filter(Boolean).join(" · ");
  if (group.kind === "tag") {
    // Tags: the name, then the tag icon, edged in the commit's lane colour.
    return (
      <Badge
        variant="default"
        className="min-w-0 max-w-full shrink gap-1 rounded-md border font-mono text-ink"
        style={{ borderColor: color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}
        title={`Tag ${group.name}`}
      >
        <span className="truncate">{group.name}</span>
        <TagIcon className="size-3 shrink-0 opacity-80" />
      </Badge>
    );
  }
  return (
    <Badge
      variant={group.head ? "signal" : "default"}
      className="min-w-0 max-w-full shrink gap-1 rounded-md font-mono"
      title={`${group.name}${title ? ` (${title})` : ""}`}
    >
      {group.head && <CheckIcon className="size-3 shrink-0" />}
      <span className="truncate">{group.name}</span>
      {group.kind === "branch" && group.local && <LaptopIcon className="size-3 shrink-0 opacity-70" />}
      {group.remotes.length > 0 && <CloudIcon className="size-3 shrink-0 opacity-70" />}
    </Badge>
  );
}

/** The commit's branch and tag labels, joined to its avatar by a line in the lane's colour. */
export function RefCell({
  groups,
  color,
  onMenu,
}: {
  groups: RefGroup[];
  color: string;
  /** Right-click on a branch label. */
  onMenu?: (e: React.MouseEvent, group: RefGroup) => void;
}) {
  const [first] = groups;
  if (!first) return null;
  // A tag gets its own pill next to the branch, rather than hiding behind "+n".
  const tag = first.kind === "tag" ? undefined : groups.find((g) => g.kind === "tag");
  const shown = tag ? [first, tag] : [first];
  const rest = groups.filter((g) => !shown.includes(g));
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      {shown.map((g) => (
        <span
          key={`${g.kind}:${g.name}`}
          className="flex min-w-0 shrink"
          onContextMenu={g.kind === "branch" && onMenu ? (e) => onMenu(e, g) : undefined}
        >
          <RefPill group={g} color={color} />
        </span>
      ))}
      {rest.length > 0 && (
        <Badge variant="outline" className="shrink-0 rounded-md px-1.5" title={rest.map((g) => g.name).join("\n")}>
          +{rest.length}
        </Badge>
      )}
      <span className="h-px min-w-2 flex-1 opacity-70" style={{ background: color }} />
    </span>
  );
}

/** Inline "enter branch name" field on the checked-out commit's row. */
export function BranchNameInput({ onSubmit, onCancel, busy }: { onSubmit: (name: string) => void; onCancel: () => void; busy: boolean }) {
  const [name, setName] = useState("");
  return (
    <Input
      autoFocus
      value={name}
      disabled={busy}
      placeholder="enter branch name"
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && name.trim()) onSubmit(name.trim());
      }}
      onBlur={() => !name.trim() && !busy && onCancel()}
      className="h-6 rounded-md px-2 font-mono text-xs"
    />
  );
}

/** The WIP row's message: "// WIP" and how many files are modified, added and deleted. */
export function WipMessage({ summary }: { summary: WipSummary }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5 px-2">
      <span className="truncate text-muted-foreground italic">{"// WIP"}</span>
      {summary.modified > 0 && (
        <span className="flex items-center gap-0.5 text-warning-ink" title={`${summary.modified} modified`}>
          <FilePenIcon className="size-3" />
          <span className="num">{summary.modified}</span>
        </span>
      )}
      {summary.added > 0 && (
        <span className="flex items-center gap-0.5 text-success-ink" title={`${summary.added} added`}>
          <FilePlusIcon className="size-3" />
          <span className="num">{summary.added}</span>
        </span>
      )}
      {summary.deleted > 0 && (
        <span className="flex items-center gap-0.5 text-danger-ink" title={`${summary.deleted} deleted`}>
          <FileMinusIcon className="size-3" />
          <span className="num">{summary.deleted}</span>
        </span>
      )}
    </span>
  );
}
