import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Attachment, ATTACHMENT_LIMITS } from "@my-ai-slaves/shared";
import { scriptOn, sendFile, shq } from "../remote/machine";
import { toPrettyJson } from "./fs-utils";

const META = "meta.json";
/** Where attachments are copied on an SSH host, relative to its $HOME. */
const REMOTE_DIR = ".my-ai-slaves/attachments";

const isId = (id: string) => Attachment.shape.id.safeParse(id).success;

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
 * Outside every repository, so a task's diff stays clean. The CLI gets read
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
    if (!isId(id)) return null;
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

  private readonly remoteHomes = new Map<string, Promise<string>>();
  /** `<host>\0<attachment id>` → its copy on that host (attachments never change, so one copy is enough). */
  private readonly sent = new Map<string, Promise<void>>();

  /**
   * Where each file is on the machine that runs the task: this Mac → in place; an SSH host →
   * copied to `~/.my-ai-slaves/attachments/<id>/<name>` there (once per host while the app runs).
   */
  async locate(host: string | null, files: Attachment[]): Promise<Map<string, { path: string; dir: string }>> {
    const result = new Map<string, { path: string; dir: string }>();
    if (!host) {
      for (const a of files) result.set(a.id, { path: this.pathOf(a), dir: this.dirOf(a.id) });
      return result;
    }
    if (files.length === 0) return result;
    let homeP = this.remoteHomes.get(host);
    if (!homeP) {
      homeP = scriptOn(host, 'printf %s "$HOME"').then((r) => r.stdout.trim());
      this.remoteHomes.set(host, homeP);
      homeP.catch(() => this.remoteHomes.delete(host));
    }
    const home = await homeP;
    for (const a of files) {
      const dir = `${home}/${REMOTE_DIR}/${a.id}`;
      const key = `${host}\0${a.id}`;
      let copy = this.sent.get(key);
      if (!copy) {
        copy = sendFile(host, this.pathOf(a), dir, a.name);
        this.sent.set(key, copy);
        // A failed copy is tried again next time.
        copy.catch(() => this.sent.delete(key));
      }
      await copy;
      result.set(a.id, { path: `${dir}/${a.name}`, dir });
    }
    return result;
  }

  /**
   * Delete these attachments here and their copies on `hosts` (plus any host this run sent them to).
   * A host that can't be reached keeps its copies; the next sweep there removes them.
   */
  async remove(ids: Iterable<string>, hosts: Iterable<string> = []): Promise<void> {
    const valid = [...new Set(ids)].filter(isId);
    if (valid.length === 0) return;
    const remote = new Map<string, string[]>();
    for (const host of hosts) remote.set(host, [...valid]);
    for (const key of this.sent.keys()) {
      const [host, id] = key.split("\0") as [string, string];
      if (!valid.includes(id)) continue;
      const list = remote.get(host) ?? [];
      if (!list.includes(id)) list.push(id);
      remote.set(host, list);
    }
    await Promise.all(valid.map((id) => rm(this.dirOf(id), { recursive: true, force: true }).catch(() => {})));
    await Promise.all(
      [...remote].map(async ([host, list]) => {
        for (const id of list) this.sent.delete(`${host}\0${id}`);
        const dirs = list.map((id) => `"$HOME"/${REMOTE_DIR}/${shq(id)}`).join(" ");
        await scriptOn(host, `rm -rf ${dirs}`).catch(() => {});
      }),
    );
  }

  /**
   * Delete attachment folders older than `minAgeMs` that `keep` doesn't list, here and on `hosts`.
   * The age keeps files you attached in a composer that isn't saved yet. Returns the ids removed here.
   */
  async sweep(keep: ReadonlySet<string>, hosts: Iterable<string> = [], minAgeMs = 24 * 60 * 60 * 1000): Promise<string[]> {
    const cutoff = Date.now() - minAgeMs;
    const removed: string[] = [];
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    for (const id of entries) {
      if (!isId(id) || keep.has(id)) continue;
      const info = await stat(this.dirOf(id)).catch(() => null);
      if (!info?.isDirectory() || info.mtimeMs > cutoff) continue;
      await rm(this.dirOf(id), { recursive: true, force: true }).catch(() => {});
      removed.push(id);
    }
    const minutes = Math.max(0, Math.floor(minAgeMs / 60_000));
    await Promise.all(
      [...new Set(hosts)].map(async (host) => {
        const listed = await scriptOn(
          host,
          `cd "$HOME"/${REMOTE_DIR} 2>/dev/null || exit 0; find . -mindepth 1 -maxdepth 1 -type d -mmin +${minutes} -print`,
        ).catch(() => null);
        if (!listed) return;
        const stale = listed.stdout
          .split("\n")
          .map((l) => l.trim().replace(/^\.\//, ""))
          .filter((id) => isId(id) && !keep.has(id));
        if (stale.length === 0) return;
        for (const id of stale) this.sent.delete(`${host}\0${id}`);
        await scriptOn(host, `rm -rf ${stale.map((id) => `"$HOME"/${REMOTE_DIR}/${shq(id)}`).join(" ")}`).catch(() => {});
      }),
    );
    return removed;
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

/** Names Windows refuses as files, whatever the extension (`nul.txt` too). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

export function safeName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const cleaned = base
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^\.+/, "")
    .slice(-120)
    .replace(/[. ]+$/, "") // Windows drops trailing dots and spaces
    .trim();
  // Case-insensitive file systems (macOS, Windows) would let `Meta.json` be overwritten by the metadata.
  if (!cleaned || cleaned.toLowerCase() === META) return "file";
  return WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
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
