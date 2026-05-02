/**
 * HAPPI/1.0 client — `dispatch()`.
 *
 * The single public API for sending one envelope through a HAPPI runtime
 * subprocess and consuming the resulting NDJSON event stream as typed
 * `HappiEvent`s. This is the JS analogue of:
 *
 *   echo '<envelope-json>' | bash happi.md run
 *
 * but with the events parsed into a typed async iterator instead of raw
 * NDJSON lines.
 *
 * Reference: §axioms in /Users/lauriescheepers/.hal/happi.md — CLI (stdio)
 * is the canonical transport; everything else is a shim that maps to this
 * contract.
 */

import { encode, type Envelope } from "./envelope.js";
import { parseEvents, type HappiEvent } from "./events.js";
import { spawn, type SpawnOptions } from "./runtime.js";

export interface DispatchOptions {
  /**
   * argv to invoke the runtime. Defaults to `["bash", "happi.md", "run"]`
   * which assumes happi.md is on the cwd. Override for `["hal", "--happi-api"]`,
   * `["python3", "-m", "hal_py"]`, or any HAPPI-compliant runtime.
   */
  readonly cmd?: ReadonlyArray<string>;
  /** Working directory for the spawned runtime. */
  readonly cwd?: string;
  /** Extra env vars (merged onto current process env). */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * If true, copy stderr through to the parent process's stderr. Useful
   * during development; off by default to keep test output clean.
   */
  readonly inheritStderr?: boolean;
}

const DEFAULT_CMD: ReadonlyArray<string> = ["bash", "happi.md", "run"];

/**
 * Dispatch one envelope through a HAPPI runtime and return an async iterator
 * over typed events.
 *
 * Lifecycle:
 *   1. Spawn the runtime per `opts.cmd`.
 *   2. Write the envelope JSON to its stdin and close.
 *   3. Stream stdout, parsing each NDJSON line into a `HappiEvent`.
 *   4. Iterator terminates when the runtime closes stdout (always after
 *      `completed` or `error`).
 *
 * The caller MUST consume the iterator to completion; otherwise the child
 * may remain blocked waiting on stdout backpressure. This mirrors the
 * reference runtime's contract: stdout closes when the request finishes.
 */
export async function dispatch(
  envelope: Envelope,
  opts: DispatchOptions = {},
): Promise<AsyncGenerator<HappiEvent, void, void>> {
  const spawnOpts: SpawnOptions = {
    cmd: opts.cmd ?? DEFAULT_CMD,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };
  const proc = await spawn(spawnOpts);

  // Drain stderr in the background (avoid back-pressure deadlock). When
  // inheritStderr is true, mirror to console.error; otherwise discard.
  void drainStderr(proc.stderr, opts.inheritStderr === true);

  // Write envelope + EOF. The reference runtime reads stdin in one go.
  await proc.writeStdin(encode(envelope) + "\n");
  await proc.closeStdin();

  return parseEvents(proc.stdout);
}

/**
 * Convenience: collect all events from a dispatch into an array. Use this
 * for short-lived calls (version, echo) where streaming offers no benefit.
 */
export async function dispatchToArray(
  envelope: Envelope,
  opts: DispatchOptions = {},
): Promise<HappiEvent[]> {
  const iter = await dispatch(envelope, opts);
  const events: HappiEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

async function drainStderr(
  stream: ReadableStream<Uint8Array>,
  echo: boolean,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (echo && value !== undefined) {
        process.stderr.write(decoder.decode(value, { stream: true }));
      }
    }
  } finally {
    reader.releaseLock();
  }
}
