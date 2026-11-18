import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Attachment, ATTACHMENT_LIMITS } from "@my-ai-slaves/shared";
import { toPrettyJson } from "./fs-utils";

const META = "meta.json";

export class AttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Pasted and uploaded files: `.data/attachments/<id>/<name>` + `.data/attachments/<id>/meta.json`.
 * Outside every repository, so a task's worktree (and its diff) stays clean. The CLI gets read
 * access to a task's attachment folders through `--add-dir`.
 */
export class AttachmentStore {
  constructor(readonly dir: string) {}

  dirOf(id: string): string {
    return join(this.dir, id);
  }

  pathOf(a: Attachment): string {
    return join(this.dirOf(a.id), a.name);
  }

  async save(bytes: Buffer, claimedName: string, claimedType: string | undefined): Promise<Attachment> {
    if (bytes.length === 0) throw new AttachmentError(400, "That file is empty.");
    if (bytes.length > ATTACHMENT_LIMITS.maxBytes) {
      throw new AttachmentError(413, `${claimedName || "That file"} is larger than 20 MB.`);
    }
    const attachment: Attachment = {
      id: randomUUID(),
      name: safeName(claimedName),
      // The browser's type is only a claim: an image type must be proven by the bytes,
      // because images are the only thing we ever serve back.
      mime:
        sniffImage(bytes) ??
        (claimedType && !claimedType.startsWith("image/") && !/html|svg|xml|javascript/i.test(claimedType)
          ? claimedType
          : "application/octet-stream"),
      size: bytes.length,
    };
    const dir = this.dirOf(attachment.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, attachment.name), bytes, { mode: 0o600 });
    await writeFile(join(dir, META), toPrettyJson(attachment), { mode: 0o600 });
    return attachment;
  }

  async find(id: string): Promise<Attachment | null> {
    if (!Attachment.shape.id.safeParse(id).success) return null;
    try {
      const parsed = Attachment.safeParse(JSON.parse(await readFile(join(this.dirOf(id), META), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async read(a: Attachment): Promise<Buffer> {
    return readFile(this.pathOf(a));
  }

  /** The attachments a request refers to; throws if any is missing. */
  async resolve(ids: string[] | undefined): Promise<Attachment[]> {
    const unique = [...new Set(ids ?? [])];
    if (unique.length > ATTACHMENT_LIMITS.maxFiles) {
      throw new AttachmentError(400, `Attach at most ${ATTACHMENT_LIMITS.maxFiles} files.`);
    }
    const found: Attachment[] = [];
    for (const id of unique) {
      const a = await this.find(id);
      if (!a) throw new AttachmentError(400, "An attached file is missing. Attach it again.");
      found.push(a);
    }
    return found;
  }
}

function safeName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const cleaned = base
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(-120);
  return cleaned && cleaned !== META ? cleaned : "file";
}

function sniffImage(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}
