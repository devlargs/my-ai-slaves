import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { appCsp, registerCsp } from "../src/security/csp";
import { AvatarProxy } from "../src/services/avatar-proxy";

const HASH = "a".repeat(64);
const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });

describe("AvatarProxy", () => {
  it("fetches from Gravatar once and serves the cached copy after", async () => {
    const urls: string[] = [];
    const proxy = new AvatarProxy(async (url) => {
      urls.push(url);
      return png();
    });
    const first = await proxy.get(HASH, 48);
    const second = await proxy.get(HASH, 48);
    expect(first?.type).toBe("image/png");
    expect(second).toBe(first);
    expect(urls).toEqual([`https://gravatar.com/avatar/${HASH}?s=48&d=identicon`]);
  });

  it("refuses bad hashes and sizes without fetching", async () => {
    let calls = 0;
    const proxy = new AvatarProxy(async () => {
      calls++;
      return png();
    });
    expect(await proxy.get("../etc", 48)).toBeNull();
    expect(await proxy.get(HASH.toUpperCase(), 48)).toBeNull();
    expect(await proxy.get(HASH, 4096)).toBeNull();
    expect(calls).toBe(0);
  });

  it("drops non-raster answers and failures, and retries a failure later", async () => {
    let now = 0;
    let calls = 0;
    const proxy = new AvatarProxy(async () => {
      calls++;
      if (calls === 1) return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
      if (calls === 2) throw new Error("offline");
      return png();
    }, () => now);
    expect(await proxy.get(HASH, 48)).toBeNull();
    expect(await proxy.get(HASH, 48)).toBeNull(); // cached miss
    expect(calls).toBe(1);
    now += 6 * 60 * 1000;
    expect(await proxy.get(HASH, 48)).toBeNull(); // offline
    now += 6 * 60 * 1000;
    expect((await proxy.get(HASH, 48))?.type).toBe("image/png");
    expect(calls).toBe(3);
  });
});

describe("app Content-Security-Policy", () => {
  it("allows only this server: no inline scripts, no third-party images", () => {
    const csp = appCsp(3005);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).not.toContain("gravatar");
    expect(csp).toContain("connect-src 'self' ws://localhost:3005 ws://127.0.0.1:3005");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("is sent on pages but leaves a route's own policy alone", async () => {
    const app = Fastify();
    registerCsp(app, 3005);
    app.get("/", async (_req, reply) => reply.type("text/html").send("<!doctype html>"));
    app.get("/own", async (_req, reply) => reply.header("Content-Security-Policy", "default-src 'none'; sandbox").send("x"));
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.headers["content-security-policy"]).toBe(appCsp(3005));
    const own = await app.inject({ method: "GET", url: "/own" });
    expect(own.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    await app.close();
  });
});
