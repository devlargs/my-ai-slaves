import type { FastifyInstance } from "fastify";

/**
 * Content-Security-Policy for the built app (production only; Vite's dev server injects inline scripts).
 * Everything comes from this server: scripts (no inline ones), images (avatars are proxied, see
 * AvatarProxy), fonts and the WebSocket. Inline styles stay allowed for React / Radix `style` props.
 */
export function appCsp(port: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Sends appCsp on every response that doesn't set its own (attachment previews and avatars do). */
export function registerCsp(app: FastifyInstance, port: number): void {
  const policy = appCsp(port);
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", policy);
    return payload;
  });
}
