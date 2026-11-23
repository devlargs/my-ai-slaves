import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentStore } from "../src/storage/attachment-store";
import { tempDir } from "./helpers";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("AttachmentStore", () => {
  it("stores the file outside any repo with a readable meta.json", async () => {
    const store = new AttachmentStore(join(await tempDir(), "attachments"));
    const a = await store.save(PNG, "Screen Shot 1.png", "image/png");
    expect(a).toMatchObject({ name: "Screen Shot 1.png", mime: "image/png", size: PNG.length });
    expect(await readFile(store.pathOf(a))).toEqual(PNG);
    const meta = await readFile(join(store.dirOf(a.id), "meta.json"), "utf8");
    expect(meta).toBe(`${JSON.stringify(a, null, 2)}\n`);
    expect((await stat(store.pathOf(a))).mode & 0o777).toBe(0o600);
    expect(await store.find(a.id)).toEqual(a);
  });

  it("only trusts image types proven by the bytes", async () => {
    const store = new AttachmentStore(join(await tempDir(), "attachments"));
    expect((await store.save(Buffer.from("<svg onload=alert(1)>"), "x.svg", "image/svg+xml")).mime).toBe(
      "application/octet-stream",
    );
    expect((await store.save(Buffer.from("<html>"), "x.html", "text/html")).mime).toBe("application/octet-stream");
    expect((await store.save(Buffer.from("%PDF-1.7"), "spec.pdf", "application/pdf")).mime).toBe("application/pdf");
  });

  it("sanitises names and rejects empty or unknown files", async () => {
    const store = new AttachmentStore(join(await tempDir(), "attachments"));
    expect((await store.save(Buffer.from("x"), "../../etc/passwd", "text/plain")).name).toBe("passwd");
    expect((await store.save(Buffer.from("x"), "meta.json", "text/plain")).name).toBe("file");
    expect((await store.save(Buffer.from("x"), "META.Json", "text/plain")).name).toBe("file");
    await expect(store.save(Buffer.alloc(0), "e.txt", "text/plain")).rejects.toThrow("empty");
    expect(await store.find("../../etc")).toBeNull();
    await expect(store.resolve(["11111111-1111-4111-8111-111111111111"])).rejects.toThrow("missing");
  });
});
