/**
 * Commit-graph avatars, fetched from Gravatar by the server (only when Settings → "Show author avatars" is
 * on), so the browser never contacts a third party and the page's CSP can keep `img-src 'self'`.
 * Kept in memory: a day for a picture, a few minutes after a failure, at most MAX_ENTRIES.
 */
export interface Avatar {
  type: string;
  body: Buffer;
}

type Fetch = (url: string, init: { signal: AbortSignal; redirect: "follow" }) => Promise<Response>;

const HASH = /^[0-9a-f]{64}$/;
/** Raster types only: never SVG or anything else the browser could run. */
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 2000;
const HIT_MS = 24 * 60 * 60 * 1000;
const MISS_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export class AvatarProxy {
  private readonly cache = new Map<string, { expires: number; avatar: Promise<Avatar | null> }>();

  constructor(
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {}

  /** A SHA-256 email hash (as GraphCommit.avatar) and a pixel size. */
  static valid(hash: string, size: number): boolean {
    return HASH.test(hash) && Number.isInteger(size) && size >= 16 && size <= 256;
  }

  get(hash: string, size: number): Promise<Avatar | null> {
    if (!AvatarProxy.valid(hash, size)) return Promise.resolve(null);
    const key = `${hash}:${size}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.avatar;
    if (hit) this.cache.delete(key);
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const entry = { expires: this.now() + HIT_MS, avatar: this.download(hash, size) };
    this.cache.set(key, entry);
    void entry.avatar.then((a) => {
      if (!a) entry.expires = this.now() + MISS_MS;
    });
    return entry.avatar;
  }

  private async download(hash: string, size: number): Promise<Avatar | null> {
    try {
      const res = await this.fetchImpl(`https://gravatar.com/avatar/${hash}?s=${size}&d=identicon`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!res.ok || !TYPES.has(type)) return null;
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0 || body.length > MAX_BYTES) return null;
      return { type, body };
    } catch {
      return null; // offline, timed out: the graph shows the author's initial instead
    }
  }
}
