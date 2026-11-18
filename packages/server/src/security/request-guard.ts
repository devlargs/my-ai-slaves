import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * No token: open http://localhost:<port> directly. Every HTTP and WebSocket request must still:
 *  - be addressed to localhost:<port> / 127.0.0.1:<port> (blocks DNS rebinding),
 *  - come from that origin if it carries an Origin header (blocks other websites; always set on WS),
 *  - not be marked cross-site by the browser (Sec-Fetch-Site), which also covers requests
 *    without an Origin header such as <img src> or links from other sites.
 * The server itself only listens on 127.0.0.1.
 */
export function createRequestGuard(port: number) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));

  return async function guard(request: FastifyRequest, reply: FastifyReply) {
    if (!hosts.has(request.headers.host ?? "")) {
      return reply.code(403).type("text/plain").send("Forbidden host.");
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      return reply.code(403).type("text/plain").send("Forbidden origin.");
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site" || fetchSite === "same-site") {
      return reply.code(403).type("text/plain").send("Forbidden: cross-site request.");
    }
  };
}
