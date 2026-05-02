/**
 * Cross-runtime spawn abstraction — the polyglot answer.
 *
 * Node.js, Deno, and Bun each ship a different child-process API. This
 * module detects the runtime at import time and exposes a single `spawn()`
 * function that returns:
 *
 *   - a writable byte sink for stdin (closeable),
 *   - a readable byte stream for stdout (Web-standard `ReadableStream`),
 *   - a promise that resolves to the exit code.
 *
 * One source, three runtimes — that is what makes hal-js a JS-polyglot HAPPI
 * client rather than a Node-only adapter. The contract was chosen so that
 * the hottest path (stdout NDJSON streaming) is identical across runtimes:
 * a `ReadableStream<Uint8Array>` consumed by `events.parseEvents`.
 *
 * Falsifier #4 (Node-only APIs without runtime detection) is checked by
 * `tests/runtime.test.ts` — under each runtime, `detectRuntime()` returns
 * the expected tag and `spawn()` produces a working stream pair.
 */

export type RuntimeTag = "node" | "deno" | "bun";

export interface SpawnOptions {
  readonly cmd: ReadonlyArray<string>; // argv, e.g. ["bash", "happi.md", "run"]
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface SpawnedProcess {
  /** Web-standard byte stream for stdout. NDJSON consumers attach here. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Web-standard byte stream for stderr. Diagnostics; usually printed. */
  readonly stderr: ReadableStream<Uint8Array>;
  /** Send bytes to stdin. */
  writeStdin(data: Uint8Array | string): Promise<void>;
  /** Close stdin (signals EOF to the child). */
  closeStdin(): Promise<void>;
  /** Resolves when the process exits. */
  readonly exitCode: Promise<number>;
}

/**
 * Detect the JS runtime executing this code. Order matters: Bun and Deno
 * both expose `process` for Node-compatibility, so we check their distinctive
 * globals first.
 */
export function detectRuntime(): RuntimeTag {
  // @ts-expect-error - Bun global is runtime-only
  if (typeof Bun !== "undefined") return "bun";
  // @ts-expect-error - Deno global is runtime-only
  if (typeof Deno !== "undefined") return "deno";
  return "node";
}

/**
 * Spawn a child process. Returns a uniform `SpawnedProcess` regardless of
 * the host runtime. The implementation dispatches by `detectRuntime()`.
 */
export async function spawn(opts: SpawnOptions): Promise<SpawnedProcess> {
  const tag = detectRuntime();
  if (tag === "bun") return spawnBun(opts);
  if (tag === "deno") return spawnDeno(opts);
  return spawnNode(opts);
}

/* ─── Node ──────────────────────────────────────────────────────────── */

async function spawnNode(opts: SpawnOptions): Promise<SpawnedProcess> {
  const { spawn: nodeSpawn } = await import("node:child_process");
  const { Readable } = await import("node:stream");
  const [bin, ...args] = opts.cmd;
  if (bin === undefined) throw new Error("spawn: empty cmd");
  const child = nodeSpawn(bin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  // Node ≥18 ships Readable.toWeb; we narrow to Web ReadableStream for
  // cross-runtime consumers. The cast through unknown is required because
  // Node's Web stream type is not literally identical to the global.
  const stdout = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
  const stderr = Readable.toWeb(child.stderr!) as unknown as ReadableStream<Uint8Array>;
  const exitCode = new Promise<number>((resolve, reject) => {
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", reject);
  });
  return {
    stdout,
    stderr,
    async writeStdin(data) {
      const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
      await new Promise<void>((resolve, reject) => {
        child.stdin!.write(buf, (err) => (err ? reject(err) : resolve()));
      });
    },
    async closeStdin() {
      await new Promise<void>((resolve) => child.stdin!.end(resolve));
    },
    exitCode,
  };
}

/* ─── Deno ──────────────────────────────────────────────────────────── */

async function spawnDeno(opts: SpawnOptions): Promise<SpawnedProcess> {
  // @ts-expect-error - Deno global, present at runtime
  const DenoNs = Deno;
  const [bin, ...args] = opts.cmd;
  if (bin === undefined) throw new Error("spawn: empty cmd");
  const command = new DenoNs.Command(bin, {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    async writeStdin(data) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      await writer.write(bytes);
    },
    async closeStdin() {
      await writer.close();
    },
    exitCode: child.status.then((s: { code: number }) => s.code),
  };
}

/* ─── Bun ───────────────────────────────────────────────────────────── */

async function spawnBun(opts: SpawnOptions): Promise<SpawnedProcess> {
  // @ts-expect-error - Bun global, present at runtime
  const BunNs = Bun;
  const proc = BunNs.spawn({
    cmd: [...opts.cmd],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    async writeStdin(data) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      proc.stdin.write(bytes);
      await proc.stdin.flush();
    },
    async closeStdin() {
      await proc.stdin.end();
    },
    exitCode: proc.exited,
  };
}
