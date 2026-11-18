const pad = (n: number, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, "0");

/** Local time as ISO 8601 with the machine's offset, e.g. `2026-11-18T18:02:00+08:00`. */
export function formatLocalIso(date: Date = new Date()): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`
  );
}

/** Same local time, safe for file names: `2026-11-18T18-02-00`. */
export function formatFileStamp(date: Date = new Date()): string {
  return formatLocalIso(date).slice(0, 19).replace(/:/g, "-");
}
