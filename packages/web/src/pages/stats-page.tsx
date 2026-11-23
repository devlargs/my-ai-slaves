import type { TokenUsage, UsageRecord, UsageStatsResponse } from "@my-ai-slaves/shared";
import { RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { ProviderLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import { cn, storageGet, storageSet } from "@/lib/utils";

type Range = "7" | "30" | "90" | "all";
const RANGES: { value: Range; label: string }[] = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];
const RANGE_KEY = "slaves.statsRange";
const DAY_MS = 86_400_000;

interface Totals extends TokenUsage {
  runs: number;
}

const emptyTotals = (): Totals => ({
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
});

function add(into: Totals, u: TokenUsage): void {
  into.runs += 1;
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
  into.cacheReadTokens += u.cacheReadTokens;
  into.cacheWriteTokens += u.cacheWriteTokens;
  if (u.costUsd !== null) into.costUsd = (into.costUsd ?? 0) + u.costUsd;
}

const totalOf = (u: TokenUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

const full = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function Num({ value }: { value: number }) {
  return (
    <span className="num" title={full.format(value)}>
      {value >= 10_000 ? compact.format(value) : full.format(value)}
    </span>
  );
}

/** Local midnight of a date, as a sortable key. */
function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function StatsPage() {
  const { data, loading, reload } = useApi<UsageStatsResponse>(() => api.usageStats(), [], "stats-usage");
  const accounts = useStore((s) => s.accounts);
  const [range, setRangeState] = useState<Range>(() => {
    const saved = storageGet(RANGE_KEY);
    return RANGES.some((r) => r.value === saved) ? (saved as Range) : "30";
  });
  const setRange = (r: Range) => {
    setRangeState(r);
    storageSet(RANGE_KEY, r);
  };

  const today = dayStart(new Date());
  const records = useMemo(() => {
    const all = data?.records ?? [];
    if (range === "all") return all;
    const from = today - (Number(range) - 1) * DAY_MS;
    return all.filter((r) => new Date(r.at).getTime() >= from);
  }, [data, range, today]);

  const total = useMemo(() => {
    const t = emptyTotals();
    for (const r of records) add(t, r.usage);
    return t;
  }, [records]);

  const perAccount = useMemo(() => {
    const map = new Map<string, Totals>();
    for (const r of records) {
      let t = map.get(r.account);
      if (!t) map.set(r.account, (t = emptyTotals()));
      add(t, r.usage);
    }
    // Every subscription shows, the ones without runs too, in Settings-page order; removed ones go last.
    const known = accounts.map((a) => ({ id: a.id, account: a, totals: map.get(a.id) ?? emptyTotals() }));
    const removed = [...map.entries()]
      .filter(([id]) => !accounts.some((a) => a.id === id))
      .map(([id, totals]) => ({ id, account: null, totals }));
    return [...known, ...removed];
  }, [records, accounts]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      <PageHeader
        title="Statistics"
        description="Tokens your tasks used, per subscription and overall, as the CLIs reported them for each run."
        actions={
          <>
            <Select
              aria-label="Time range"
              className="w-36"
              value={range}
              onValueChange={(v) => setRange(v as Range)}
              options={RANGES}
            />
            <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
              <RefreshCwIcon /> Refresh
            </Button>
          </>
        }
      />

      <Card>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <Stat label="Total tokens" value={totalOf(total)} hero />
          <Stat label="Input" value={total.inputTokens} />
          <Stat label="Output" value={total.outputTokens} />
          <Stat label="Runs" value={total.runs} />
          <Stat label="Cache read" value={total.cacheReadTokens} />
          <Stat label="Cache write" value={total.cacheWriteTokens} />
          <div className="col-span-2 flex flex-col gap-1">
            <span className="label-mono text-muted-foreground">Est. API cost</span>
            <span className="num text-lg font-semibold text-ink">
              {total.costUsd === null ? "—" : usd.format(total.costUsd)}
            </span>
            <span className="text-[11px] text-muted-foreground">Claude&apos;s own estimate; subscriptions aren&apos;t billed this.</span>
          </div>
        </CardContent>
      </Card>

      <DailyChart records={records} range={range} today={today} />

      <Card>
        <CardHeader>
          <CardTitle>Per subscription</CardTitle>
        </CardHeader>
        {perAccount.length === 0 ? (
          <CardContent className="text-[13px] text-muted-foreground">No accounts yet. Add one on the Settings page.</CardContent>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-rule text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-3 py-2 text-right font-medium">Runs</th>
                  <th className="px-3 py-2 text-right font-medium">Input</th>
                  <th className="px-3 py-2 text-right font-medium">Output</th>
                  <th className="px-3 py-2 text-right font-medium">Cache read</th>
                  <th className="px-3 py-2 text-right font-medium">Cache write</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {perAccount.map(({ id, account, totals }) => {
                  const sum = totalOf(totals);
                  const share = totalOf(total) > 0 ? sum / totalOf(total) : 0;
                  return (
                    <tr key={id} className="border-b border-rule last:border-b-0">
                      <td className="px-4 py-2.5">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-ink">
                            {id}
                            {!account && <span className="ml-1.5 font-normal text-muted-foreground">(removed)</span>}
                          </span>
                          {account && (
                            <span className="flex items-center gap-1.5">
                              <ProviderLabel provider={account.provider} />
                              {account.email && <span className="truncate text-[11px] text-muted-foreground">{account.email}</span>}
                              {account.host && <span className="font-mono text-[11px] text-muted-foreground">@{account.host}</span>}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right"><Num value={totals.runs} /></td>
                      <td className="px-3 py-2.5 text-right"><Num value={totals.inputTokens} /></td>
                      <td className="px-3 py-2.5 text-right"><Num value={totals.outputTokens} /></td>
                      <td className="px-3 py-2.5 text-right"><Num value={totals.cacheReadTokens} /></td>
                      <td className="px-3 py-2.5 text-right"><Num value={totals.cacheWriteTokens} /></td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex flex-col items-end gap-1">
                          <span className="font-medium text-ink"><Num value={sum} /></span>
                          <span
                            className="h-1 w-20 overflow-hidden rounded-full bg-paper-3"
                            title={`${Math.round(share * 100)}% of all tokens`}
                          >
                            <span className="block h-full rounded-full bg-ink-2" style={{ width: `${share * 100}%` }} />
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {accounts.some((a) => a.provider === "cursor-agent") && (
          <p className="border-t border-rule px-4 py-2.5 text-[11px] text-muted-foreground">
            Cursor Agent doesn&apos;t report token counts in its output, so its runs are counted but may show no tokens.
          </p>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, hero }: { label: string; value: number; hero?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label-mono text-muted-foreground">{label}</span>
      <span className={cn("font-semibold text-ink", hero ? "text-2xl" : "text-lg")}>
        <Num value={value} />
      </span>
    </div>
  );
}

interface Bucket {
  start: number;
  label: string;
  tokens: number;
  runs: number;
}

/** Tokens per day (per week when the range is longer than 90 days), one series. */
function DailyChart({ records, range, today }: { records: UsageRecord[]; range: Range; today: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const buckets = useMemo(() => {
    const first = records.length ? dayStart(new Date(records[0]!.at)) : today;
    const from = range === "all" ? Math.min(first, today - 6 * DAY_MS) : today - (Number(range) - 1) * DAY_MS;
    const days = Math.round((today - from) / DAY_MS) + 1;
    const step = days > 90 ? 7 : 1;
    const list: Bucket[] = [];
    for (let start = from; start <= today; start += step * DAY_MS) {
      const d = new Date(start);
      const label = d.toLocaleDateString([], { month: "short", day: "numeric" });
      list.push({ start, label: step === 7 ? `Week of ${label}` : label, tokens: 0, runs: 0 });
    }
    for (const r of records) {
      const t = dayStart(new Date(r.at));
      const i = Math.min(list.length - 1, Math.floor((t - from) / (step * DAY_MS)));
      const b = list[i];
      if (!b || i < 0) continue;
      b.tokens += totalOf(r.usage);
      b.runs += 1;
    }
    return list;
  }, [records, range, today]);

  const max = Math.max(1, ...buckets.map((b) => b.tokens));
  const shown = hover !== null ? buckets[hover] : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tokens over time</CardTitle>
        <span className="text-[12px] text-muted-foreground" aria-live="polite">
          {shown ? (
            <>
              {shown.label} · <span className="num text-ink">{full.format(shown.tokens)}</span> tokens ·{" "}
              <span className="num">{shown.runs}</span> {shown.runs === 1 ? "run" : "runs"}
            </>
          ) : (
            <>
              Peak <span className="num text-ink">{compact.format(max === 1 ? 0 : max)}</span>
            </>
          )}
        </span>
      </CardHeader>
      <CardContent>
        <div className="flex h-40 items-end gap-0.5 border-b border-rule" onMouseLeave={() => setHover(null)}>
          {buckets.map((b, i) => (
            <div
              key={b.start}
              className="flex h-full min-w-0 flex-1 cursor-default items-end"
              onMouseEnter={() => setHover(i)}
              role="img"
              aria-label={`${b.label}: ${full.format(b.tokens)} tokens, ${b.runs} runs`}
            >
              <div
                className={cn(
                  "w-full rounded-t-[4px] transition-colors duration-150",
                  hover === i ? "bg-ink" : "bg-ink-2/70",
                )}
                style={{ height: b.tokens > 0 ? `max(2px, ${(b.tokens / max) * 100}%)` : 0 }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[11px] text-muted-foreground">
          <span>{buckets[0]?.label.replace("Week of ", "")}</span>
          <span>Today</span>
        </div>
      </CardContent>
    </Card>
  );
}
