import type { ServerResponse } from "node:http";

import { RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { parseRunCursor, type RunEventPage, type RunQueryStore } from "../../agent-runtime/runs/query-store.js";

interface Subscriber {
  principal: RunPrincipal;
  response: ServerResponse;
  cursor: string;
  blocked: boolean;
  closed: boolean;
  lastWriteAt: number;
  timer?: NodeJS.Timeout;
  onDrain: () => void;
  close: () => void;
}
interface Group { subjectId: string; tenantId: string; runId: string; subscribers: Set<Subscriber> }

/** In-memory fanout only. Every history/live page is read from PostgreSQL. */
export class RunEventStreamHub {
  private readonly groups = new Map<string, Group>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;
  private connections = 0;

  constructor(private readonly queries: Pick<RunQueryStore, "events">,
    private readonly options = { pollMs: 1000, keepaliveMs: 15_000, drainTimeoutMs: 10_000,
      maxBufferBytes: 256 * 1024, maxConnections: 1024, maxConnectionsPerPrincipal: 64 },
    private readonly assertPrincipalCurrent: (principal: RunPrincipal) => void = () => {}) {}

  async open(principal: RunPrincipal, runId: string, cursor: string | undefined, response: ServerResponse): Promise<void> {
    if (this.stopped) throw new RunControlError("SHUTTING_DOWN", 503, "Run streams are shutting down");
    this.assertCapacity(principal);
    this.assertPrincipalCurrent(principal);
    // Authorize and validate cursor before committing HTTP 200/SSE headers.
    const initial = await this.queries.events(principal, runId, cursor, 100);
    this.assertPrincipalCurrent(principal);
    if (this.stopped || response.destroyed) throw new RunControlError("SHUTTING_DOWN", 503, "Run stream is unavailable");
    this.assertCapacity(principal);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
      connection: "keep-alive", "x-accel-buffering": "no" });
    response.flushHeaders();
    const key = `${principal.tenantId}:${principal.integrationId}:${principal.subjectId}:${runId}`;
    const group = this.groups.get(key) ?? { subjectId: principal.subjectId, tenantId: principal.tenantId,
      runId, subscribers: new Set<Subscriber>() };
    this.groups.set(key, group);
    const subscriber: Subscriber = {
      principal, response, cursor: cursor || `${runId}:0`, blocked: false, closed: false, lastWriteAt: Date.now(),
      onDrain: () => { subscriber.blocked = false; clearTimeout(subscriber.timer); subscriber.timer = undefined; },
      close: () => {
        if (subscriber.closed) return;
        subscriber.closed = true;
        clearTimeout(subscriber.timer);
        response.off("drain", subscriber.onDrain);
        response.off("close", subscriber.close);
        response.off("error", subscriber.close);
        group.subscribers.delete(subscriber);
        this.connections -= 1;
        if (group.subscribers.size === 0) this.groups.delete(key);
        if (!response.destroyed && !response.writableEnded) response.end();
        if (this.connections === 0) { clearInterval(this.timer); this.timer = undefined; }
      },
    };
    group.subscribers.add(subscriber);
    this.connections += 1;
    response.on("close", subscriber.close);
    response.on("error", subscriber.close);
    this.sendPage(subscriber, initial);
    if (!this.timer && !subscriber.closed) {
      this.timer = setInterval(() => { void this.poll(); }, this.options.pollMs);
      this.timer.unref();
    }
    // Poll immediately after registration. An event between initial read and
    // registration remains in the durable history and cannot fall through a gap.
    void this.poll();
  }

  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const groups = [...this.groups.values()];
      let next = 0;
      const consume = async () => {
        while (next < groups.length && !this.stopped) {
          const group = groups[next++]!;
          const ready = [...group.subscribers].filter((subscriber) => this.authorized(subscriber) && !subscriber.blocked);
          if (ready.length === 0) continue;
          const minimum = ready.reduce((left, right) => parseRunCursor(group.runId, left.cursor)
            < parseRunCursor(group.runId, right.cursor) ? left : right);
          try {
            const page = await this.queries.events(minimum.principal, group.runId, minimum.cursor, 100);
            for (const subscriber of ready) {
              this.sendPage(subscriber, page);
              if (!subscriber.closed && !subscriber.blocked && Date.now() - subscriber.lastWriteAt >= this.options.keepaliveMs) {
                this.write(subscriber, ": keepalive\n\n");
              }
            }
          } catch (error) {
            // Binding revocation/cursor expiry are observable without exposing DB/provider errors.
            for (const subscriber of group.subscribers) {
              if (error instanceof RunControlError) this.write(subscriber, `event: stream_error\ndata: ${JSON.stringify({ code: error.code })}\n\n`);
              subscriber.close();
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, groups.length) }, consume));
    } finally {
      this.polling = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const group of this.groups.values()) {
      for (const subscriber of group.subscribers) subscriber.close();
    }
    while (this.polling) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private assertCapacity(principal: RunPrincipal): void {
    const principalCount = [...this.groups.values()].filter((group) => group.subjectId === principal.subjectId
      && group.tenantId === principal.tenantId).reduce((sum, group) => sum + group.subscribers.size, 0);
    if (this.connections >= this.options.maxConnections || principalCount >= this.options.maxConnectionsPerPrincipal) {
      throw new RunControlError("STREAM_CAPACITY", 429, "Run event stream capacity is exhausted");
    }
  }

  private sendPage(subscriber: Subscriber, page: RunEventPage): void {
    if (subscriber.closed || subscriber.blocked) return;
    const runId = page.snapshot.id;
    let current = parseRunCursor(runId, subscriber.cursor);
    for (const event of page.events) {
      if (event.sequence <= current) continue;
      if (!this.write(subscriber, `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) return;
      subscriber.cursor = event.id;
      current = event.sequence;
      if (subscriber.blocked) return;
    }
    if (parseRunCursor(runId, page.cursor) > current) {
      if (this.write(subscriber, `id: ${page.cursor}\nevent: cursor\ndata: ${JSON.stringify({ cursor: page.cursor })}\n\n`)) subscriber.cursor = page.cursor;
    }
    if (!subscriber.blocked && subscriber.cursor === page.highWater
        && ["succeeded", "failed", "cancelled"].includes(page.snapshot.status)) {
      this.write(subscriber, `event: complete\ndata: ${JSON.stringify({ status: page.snapshot.status, cursor: subscriber.cursor })}\n\n`);
      subscriber.close();
    }
  }

  private write(subscriber: Subscriber, chunk: string): boolean {
    if (!this.authorized(subscriber) || subscriber.response.destroyed || subscriber.response.writableEnded) return false;
    if (subscriber.blocked || subscriber.response.writableLength + Buffer.byteLength(chunk) > this.options.maxBufferBytes) {
      subscriber.close();
      return false;
    }
    try {
      const ready = subscriber.response.write(chunk);
      subscriber.lastWriteAt = Date.now();
      if (!ready) {
        subscriber.blocked = true;
        subscriber.response.once("drain", subscriber.onDrain);
        subscriber.timer = setTimeout(subscriber.close, this.options.drainTimeoutMs);
        subscriber.timer.unref();
      }
      return true; // false from write means accepted into Node's bounded buffer.
    } catch {
      subscriber.close();
      return false;
    }
  }

  private authorized(subscriber: Subscriber): boolean {
    if (subscriber.closed) return false;
    try { this.assertPrincipalCurrent(subscriber.principal); return true; }
    catch { subscriber.close(); return false; }
  }
}
