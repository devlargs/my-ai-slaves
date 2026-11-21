import type { RawLine, ServerMessage, StreamEvent } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { type OutputBuffer, pushRawCapped } from "../src/services/queue-service";
import { WsHub } from "../src/ws/hub";

/** A socket that records what the hub sends and lets the test play the browser's side. */
function fakeSocket() {
  const sent: ServerMessage[] = [];
  const handlers = new Map<string, (data?: unknown) => void>();
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (json: string) => sent.push(JSON.parse(json) as ServerMessage),
    on: (event: string, handler: (data?: unknown) => void) => handlers.set(event, handler),
  } as unknown as WebSocket;
  const say = async (message: object) => {
    handlers.get("message")?.(JSON.stringify(message));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { socket, sent, say, types: () => sent.map((m) => m.type) };
}

const events: StreamEvent[] = [{ kind: "message", text: "Working on it" }];
const kept: RawLine[] = [{ src: "stdout", line: '{"type":"assistant"}' }];

function hubWith(...clients: ReturnType<typeof fakeSocket>[]) {
  const hub = new WsHub();
  hub.setSources({ listQueue: async () => [], listAccounts: async () => [], replay: () => ({ events, raw: kept }) });
  for (const client of clients) hub.handle(client.socket);
  return hub;
}

describe("task output over the socket", () => {
  it("replays a task's events without its raw lines", async () => {
    const browser = fakeSocket();
    hubWith(browser);
    await browser.say({ type: "subscribe", topic: "task", taskId: "t1" });
    expect(browser.sent).toEqual([{ type: "task.replay", taskId: "t1", events }]);
  });

  it("sends raw lines only to a view that asked for them, and stops when it closes", async () => {
    const browser = fakeSocket();
    const hub = hubWith(browser);
    const line: RawLine = { src: "stdout", line: "token" };
    await browser.say({ type: "subscribe", topic: "task", taskId: "t1" });
    hub.taskRaw("t1", line);
    hub.taskEvent("t1", events[0] as StreamEvent);
    expect(browser.types()).toEqual(["task.replay", "task.event"]);

    await browser.say({ type: "subscribe", topic: "task-raw", taskId: "t1" });
    hub.taskRaw("t1", line);
    expect(browser.sent.slice(2)).toEqual([
      { type: "task.raw-replay", taskId: "t1", raw: kept },
      { type: "task.raw", taskId: "t1", raw: line },
    ]);

    await browser.say({ type: "unsubscribe", topic: "task-raw", taskId: "t1" });
    hub.taskRaw("t1", line);
    hub.taskEvent("t1", events[0] as StreamEvent);
    expect(browser.types().slice(4)).toEqual(["task.event"]);
  });

  it("ends the raw lines too when the task's view closes", async () => {
    const browser = fakeSocket();
    const hub = hubWith(browser);
    await browser.say({ type: "subscribe", topic: "task", taskId: "t1" });
    await browser.say({ type: "subscribe", topic: "task-raw", taskId: "t1" });
    await browser.say({ type: "unsubscribe", topic: "task", taskId: "t1" });
    browser.sent.length = 0;
    hub.taskRaw("t1", { src: "stdout", line: "token" });
    hub.taskEvent("t1", events[0] as StreamEvent);
    expect(browser.sent).toEqual([]);
  });

  it("keeps one browser's raw view from sending raw lines to another", async () => {
    const watching = fakeSocket();
    const other = fakeSocket();
    const hub = hubWith(watching, other);
    for (const browser of [watching, other]) await browser.say({ type: "subscribe", topic: "task", taskId: "t1" });
    await watching.say({ type: "subscribe", topic: "task-raw", taskId: "t1" });
    hub.taskRaw("t1", { src: "stderr", line: "warn" });
    expect(watching.types()).toContain("task.raw");
    expect(other.types()).toEqual(["task.replay"]);
  });
});

describe("the raw line buffer", () => {
  const buffer = (): OutputBuffer => ({ events: [], raw: [], rawChars: 0 });
  const line = (text: string): RawLine => ({ src: "stdout", line: text });

  it("drops the oldest lines past the line limit", () => {
    const b = buffer();
    for (const text of ["a", "b", "c", "d"]) pushRawCapped(b, line(text), 3, 1000);
    expect(b.raw.map((r) => r.line)).toEqual(["b", "c", "d"]);
    expect(b.rawChars).toBe(3);
  });

  it("drops the oldest lines past the size limit, however few lines that leaves", () => {
    const b = buffer();
    pushRawCapped(b, line("x".repeat(40)), 100, 100);
    pushRawCapped(b, line("y".repeat(40)), 100, 100);
    pushRawCapped(b, line("z".repeat(40)), 100, 100);
    expect(b.raw.map((r) => r.line[0])).toEqual(["y", "z"]);
    expect(b.rawChars).toBe(80);
  });

  it("always keeps the newest line, even one bigger than the limit", () => {
    const b = buffer();
    pushRawCapped(b, line("small"), 100, 100);
    pushRawCapped(b, line("x".repeat(500)), 100, 100);
    expect(b.raw).toHaveLength(1);
    expect(b.rawChars).toBe(500);
  });
});
