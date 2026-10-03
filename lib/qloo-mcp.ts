// Long-lived client for the official `qloo mcp` stdio server (@qloo/qloo-harness).
// Server-only. One process is shared by all requests so the harness resolution cache works, and every
// tool call goes through one serial queue with spacing: a single qloo_rank fans out one HTTP lookup per
// uncached entity, and the hackathon key allows 5 requests/s (x-second-ratelimit-limit).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

export type Envelope = Record<string, unknown>;

export interface QlooMcpOptions {
  /** Executable for the MCP server. Defaults to the project-local harness, then `qloo` on PATH. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Minimum gap between tool calls. */
  paceMs?: number;
  /** Per-call timeout; the harness itself retries 429/5xx for up to ~30 s. */
  callTimeoutMs?: number;
}

const QLOO_ENV_KEYS = ["PATH", "HOME", "QLOO_API_KEY", "QLOO_BASE_URL", "QLOO_TRUSTED_BASE_URL", "QLOO_HOME"];

function defaultCommand(): string {
  const local = resolve("node_modules/.bin/qloo");
  return existsSync(local) ? local : "qloo";
}

/** Only Qloo settings reach the child process; model keys and other secrets stay in this process. */
function qlooEnv(): Record<string, string> {
  const env = Object.fromEntries(QLOO_ENV_KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
  return { QLOO_HOME: resolve(".qloo-home"), ...env };
}

export class QlooMcp {
  private proc?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, { ok: (v: Envelope) => void; fail: (e: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;
  private readonly opts: Required<Omit<QlooMcpOptions, "env">> & { env: Record<string, string> };

  constructor(options: QlooMcpOptions = {}) {
    this.opts = {
      command: options.command ?? process.env.QLOO_MCP_COMMAND ?? defaultCommand(),
      args: options.args ?? ["mcp"],
      env: options.env ?? qlooEnv(),
      paceMs: options.paceMs ?? 1500,
      callTimeoutMs: options.callTimeoutMs ?? 60_000,
    };
  }

  private start(): Promise<void> {
    // Cast: Next augments ProcessEnv with NODE_ENV, which this deliberately minimal env omits.
    const proc = spawn(this.opts.command, this.opts.args, { env: this.opts.env as NodeJS.ProcessEnv });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    proc.stderr.on("data", () => {}); // harness logs go to its own files; drain to avoid blocking
    proc.on("exit", (code, signal) => {
      // Fail in-flight calls loudly and let the next call spawn a fresh server.
      for (const w of this.pending.values()) w.fail(new Error(`qloo mcp exited (code ${code}, signal ${signal})`));
      this.pending.clear();
      if (this.proc === proc) {
        this.proc = undefined;
        this.ready = undefined;
      }
    });
    return this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "undercard", version: "0.1.0" },
    }).then(() => this.notify("notifications/initialized"));
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: Envelope; error?: { message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a JSON-RPC frame
    }
    const waiter = msg.id === undefined ? undefined : this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id!);
    if (msg.error) waiter.fail(new Error(`qloo mcp: ${msg.error.message}`));
    else waiter.ok(msg.result ?? {});
  }

  private notify(method: string): void {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  private rpc(method: string, params: Envelope): Promise<Envelope> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("qloo mcp is not running"));
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`qloo mcp ${method} timed out after ${this.opts.callTimeoutMs} ms`));
      }, this.opts.callTimeoutMs);
      this.pending.set(id, {
        ok: (v) => (clearTimeout(timer), ok(v)),
        fail: (e) => (clearTimeout(timer), fail(e)),
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private ensureStarted(): Promise<void> {
    this.ready ??= this.start().catch((e) => {
      this.ready = undefined;
      this.proc?.kill();
      throw e;
    });
    return this.ready;
  }

  /** Runs `fn` after all earlier calls, keeping at least `paceMs` between call starts. */
  private enqueue<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = async () => {
      signal?.throwIfAborted();
      const wait = this.lastCallAt + this.opts.paceMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      signal?.throwIfAborted();
      this.lastCallAt = Date.now();
      return fn();
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async listTools(): Promise<string[]> {
    await this.ensureStarted();
    const res = await this.rpc("tools/list", {});
    return ((res.tools as { name: string }[]) ?? []).map((t) => t.name);
  }

  /** Calls a workflow tool and returns the harness's normalized envelope (status ok/empty/needs_input/partial/degraded/error). */
  call(name: string, args: Envelope, signal?: AbortSignal): Promise<Envelope> {
    return this.enqueue(async () => {
      await this.ensureStarted();
      const res = await this.rpc("tools/call", { name, arguments: args });
      if (res.structuredContent) return res.structuredContent as Envelope;
      const text = (res.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text;
      if (!text) throw new Error(`${name}: response had no structured or text content`);
      return JSON.parse(text) as Envelope;
    }, signal);
  }

  close(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = undefined;
    this.ready = undefined;
  }
}

const globalForQloo = globalThis as unknown as { undercardQlooMcp?: QlooMcp };

/** Process-wide instance for the web server (survives dev hot reloads). */
export function sharedQlooMcp(): QlooMcp {
  globalForQloo.undercardQlooMcp ??= new QlooMcp();
  return globalForQloo.undercardQlooMcp;
}
