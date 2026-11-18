import { formatLocalIso } from "@my-ai-slaves/shared";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Parse the reset time out of messages like
 *   "You've hit your session limit · resets 3:45pm"
 *   "You've hit your weekly limit · resets Mon 12:00am"
 * Returns local ISO or null if no recognisable time.
 */
export function parseResetTime(text: string, now: Date): string | null {
  const match = /resets\s+(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!match) return null;
  const [, day, hourText, minuteText, meridiem] = match;
  let hour = Number(hourText) % 12;
  if (meridiem?.toLowerCase() === "pm") hour += 12;
  const minute = Number(minuteText ?? "0");

  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (day) {
    const wanted = WEEKDAYS.indexOf(day.toLowerCase());
    let add = (wanted - target.getDay() + 7) % 7;
    if (add === 0 && target <= now) add = 7;
    target.setDate(target.getDate() + add);
  } else if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return formatLocalIso(target);
}

/** `resetsAt` on Claude's rate_limit_event: units aren't documented, accept seconds or ms. */
export function epochToIso(value: number): string {
  return formatLocalIso(new Date(value < 1e12 ? value * 1000 : value));
}
