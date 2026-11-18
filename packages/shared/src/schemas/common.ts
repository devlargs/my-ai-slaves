import { z } from "zod";
import { formatLocalIso } from "../time";

/** ISO 8601 timestamp with a timezone offset. */
export const Timestamp = z.iso.datetime({ offset: true });

/** Timestamp field that is filled with "now" when missing from a hand-edited file. */
export const timestampNow = () => Timestamp.default(() => formatLocalIso());

export const ProviderId = z.enum(["claude-code", "cursor-agent"]);
export type ProviderId = z.infer<typeof ProviderId>;
