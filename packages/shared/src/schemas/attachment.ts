import { z } from "zod";

/**
 * A file you pasted or uploaded in the chat. Stored outside every repository at
 * `.data/attachments/<id>/<name>`; the CLI gets read access to it with `--add-dir`.
 */
export const Attachment = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  mime: z.string(),
  size: z.int().nonnegative(),
});
export type Attachment = z.infer<typeof Attachment>;

export const ATTACHMENT_LIMITS = { maxFiles: 10, maxBytes: 20 * 1024 * 1024 } as const;

/** Images verified by their bytes; only these are ever served back to the browser (as previews). */
export const PREVIEWABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
