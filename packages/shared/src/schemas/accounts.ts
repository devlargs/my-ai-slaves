import { z } from "zod";
import { ProviderId, Timestamp, timestampNow } from "./common";

/** Labels double as ids and folder names under .data/cli-config/. */
export const AccountLabel = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
  message: "use lowercase letters, digits, '_' or '-' (max 64 chars)",
});

export const AccountStatus = z.enum(["available", "limited", "logged-out", "unknown"]);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const Account = z.object({
  id: AccountLabel,
  label: AccountLabel,
  provider: ProviderId,
  /** SSH host (from ~/.ssh/config) this account runs on; null = this Mac. */
  host: z.string().min(1).nullable().default(null),
  /**
   * Local accounts: their isolated CLI config folder, relative to the project root
   * (e.g. `.data/cli-config/work_1-claude`). Remote accounts use the server's own login: "".
   */
  configDir: z.string(),
  /** CLI command override (remote hosts may only have `cursor-agent`). null = the provider setting. */
  binary: z.string().min(1).nullable().default(null),
  status: AccountStatus.default("unknown"),
  limitedUntil: Timestamp.nullable().default(null),
  lastLimitReason: z.string().nullable().default(null),
  /** Phase 2: MCP config handed to the CLI. Unused in the MVP. */
  mcpConfigPath: z.string().nullable().default(null),
  createdAt: timestampNow(),
  updatedAt: timestampNow(),
});
export type Account = z.infer<typeof Account>;

export const AccountsFile = z.object({
  accounts: z.array(Account).default([]),
});
export type AccountsFile = z.infer<typeof AccountsFile>;
