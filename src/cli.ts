/**
 * A HAPPI/1.3 runtime: one envelope in on stdin, one NDJSON event stream out
 * on stdout.
 *
 * Until now hal-js could speak TO a HAPPI runtime but could not BE one, so the
 * cross-language conformance suite had nothing to point at for JavaScript.
 *
 *     echo '{"v":"happi/1.3","id":"1","cmd":"echo","args":["hi"]}' | node dist/cli.js
 *
 * Not to be confused with `src/runtime.ts`, which is the cross-runtime process
 * SPAWN abstraction (Node/Deno/Bun) used by the client. This file is the
 * protocol runtime.
 *
 * One deliberate divergence from the reference runtime
 * ----------------------------------------------------
 * For `context.append` this emits the `context` event AFTER the outcome event.
 * The reference emits it BEFORE. The spec is explicit that after is correct —
 * HAPPI.md calls `context` "a non-streaming terminator emitted after
 * completed/error" and lists the reverse ordering as a named falsifier of the
 * design.
 *
 * The consequence is worth stating plainly: this runtime FAILS the recorded
 * fixture for context.append, because that fixture was recorded from the
 * reference and so records the reference's ordering. Following the recording
 * would mean writing a known spec violation into a third implementation.
 * Tracked as hal-conformance issue #2; when the reference is fixed and the
 * fixture re-recorded, this will match it with no change.
 */
import { createHash } from "node:crypto";

import { HAPPI_VERSION, isAcceptedVersion } from "./envelope.js";
import {
  CITE_VERIFY_CMD,
  STATUS_FUZZY,
  STATUS_NOT_FOUND,
  STATUS_VERIFIED,
  type CitationStatus,
} from "./cite.js";

/** A decoded envelope. Deliberately loose: unknown fields round-trip. */
interface Envelope {
  v: string;
  id: string;
  cmd: string;
  args?: unknown[];
  flags?: Record<string, unknown>;
}

/** Per-dispatch state: the sink for events, plus the audit buffer. */
interface Session {
  lines: string[];
  audit: boolean;
  models: string[];
  emitted: string[];
}

const MAX_FLEXIBLE_TOKENS = 512;

// --- emitters ---------------------------------------------------------------

function emit(s: Session, id: string, type: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ v: HAPPI_VERSION, id, type, ts: 0, ...extra });
  s.lines.push(line);
  if (s.audit) s.emitted.push(line);
}

function delta(s: Session, id: string, text: string): void {
  emit(s, id, "delta", { text });
}

function completed(s: Session, id: string, usage?: Record<string, unknown>): void {
  emit(s, id, "completed", usage === undefined ? {} : { usage });
}

/**
 * Emit a terminal error and report failure. Every failure path goes through
 * here, so an error event and a non-zero exit can never come apart — a caller
 * that checks only one of them would otherwise miss half the failures.
 */
function fail(s: Session, id: string, code: string, message: string): number {
  emit(s, id, "error", { code, message });
  return 1;
}

// --- content addressing -----------------------------------------------------

/** JSON with sorted keys and no spaces, matching Python's json.dumps. */
function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Content address of a decision body: sha256 over canonical JSON, excluding
 * the volatile id/ts/audit fields.
 *
 * Byte-identical to the reference runtime, hal-py and hal-go for the same
 * body. That equality is the whole point — it is what lets a memory chain
 * written by one runtime be recognised and de-duplicated by another, so two
 * records with the same meaning but different id or timestamp share one
 * address.
 */
export function contentAddr(body: Record<string, unknown>): string {
  const addressed: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (key === "id" || key === "ts" || key === "audit") continue;
    addressed[key] = body[key];
  }
  const digest = createHash("sha256").update(canonicalJSON(addressed), "utf8").digest("hex");
  return `sha256:${digest}`;
}

// --- citation verification --------------------------------------------------

/**
 * Length-preserving typographic folding: each mapping is one character to one
 * character, so an offset found in folded text still indexes the ORIGINAL
 * source. A folding that changed length would report positions into a string
 * the caller never sees.
 */
const TYPOGRAPHY: Record<string, string> = {
  "‐": "-", "‑": "-", "‒": "-",
  "–": "-", "—": "-", "―": "-",
  "‘": "'", "’": "'", "‛": "'",
  "“": '"', "”": '"', "‟": '"',
  " ": " ", " ": " ", " ": " ", " ": " ",
};

function fold(text: string): string {
  return Array.from(text).map((ch) => TYPOGRAPHY[ch] ?? ch).join("");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locate `quote` in `sourceText`. Returns its status and offsets.
 *
 * A deterministic ladder with no judgement anywhere in it: exact substring,
 * then a whitespace- and typography-tolerant match, then not found. That
 * determinism IS the guarantee — a quote absent from the source cannot come
 * back verified, because nothing here is capable of deciding it is close
 * enough.
 *
 * Offsets are code-point offsets, matching the reference runtime, hal-py and
 * hal-go, so all four agree on the numbers for non-ASCII sources.
 *
 * Every word is regex-escaped, so a quote made of regex metacharacters is
 * searched for as the literal text the user wrote rather than interpreted as
 * a pattern.
 */
export function verifyQuote(
  quote: string,
  sourceText: string,
): { status: CitationStatus; start: number; end: number } {
  const needle = (quote ?? "").trim();
  if (!needle) return { status: STATUS_NOT_FOUND, start: -1, end: -1 };

  const exact = sourceText.indexOf(needle);
  if (exact !== -1) {
    const start = Array.from(sourceText.slice(0, exact)).length;
    return { status: STATUS_VERIFIED, start, end: start + Array.from(needle).length };
  }

  const words = fold(needle).split(/\s+/).filter(Boolean);
  // Past the limit the tolerant pass is skipped. The exact pass above already
  // ran, so not_found errs toward "unproven" and can never yield a false
  // verified. hal-py and hal-go use the same limit: a quote one runtime
  // fuzzes and another refuses would make them disagree about groundedness.
  if (words.length === 0 || words.length > MAX_FLEXIBLE_TOKENS) {
    return { status: STATUS_NOT_FOUND, start: -1, end: -1 };
  }
  const pattern = new RegExp(words.map(escapeRegex).join("\\s+"), "u");
  const folded = fold(sourceText);
  const match = pattern.exec(folded);
  if (!match) return { status: STATUS_NOT_FOUND, start: -1, end: -1 };
  // fold maps one character to one character, so an index into the folded
  // string is the same index into the original.
  const start = Array.from(folded.slice(0, match.index)).length;
  return { status: STATUS_FUZZY, start, end: start + Array.from(match[0]).length };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// --- commands ---------------------------------------------------------------

const SPEC_LINES = [
  "HAPPI/1.3 - Harnessed-AI Polyglot Protocol Interface",
  "One JSON envelope in (stdin), one NDJSON event stream out (stdout).",
  "Envelope: {v, id, cmd, args?, flags?, auth?}",
  "Events: started -> (delta|tool_call|tool_result|sub_request)* -> completed|error -> [idr]",
  "v1.1: flags.audit=true emits idr terminator with sha256 of envelope+events",
  "v1.1: cmd context.append emits a context terminator content-addressing a decision body (excl id/ts/audit)",
  "v1.3: cmd cite.verify deterministically checks each citation quote is verbatim in its source (un-fakeable provenance floor)",
  "Cmds (this runtime): version, echo, spec.describe, envelope.validate, idr.emit, context.append, cite.verify",
  "Implementation: hal-js  Reference: happi.md",
];

type Handler = (s: Session, env: Envelope) => number;

/**
 * Report the version of THIS runtime, never the envelope's. A runtime that
 * echoed the envelope's version back would turn every version check into a
 * tautology and hide a mismatch rather than expose it.
 */
const cmdVersion: Handler = (s, env) => {
  delta(s, env.id, HAPPI_VERSION);
  completed(s, env.id);
  return 0;
};

const cmdEcho: Handler = (s, env) => {
  for (const arg of env.args ?? []) delta(s, env.id, String(arg));
  completed(s, env.id);
  return 0;
};

const cmdSpecDescribe: Handler = (s, env) => {
  for (const line of SPEC_LINES) delta(s, env.id, line);
  completed(s, env.id);
  return 0;
};

/** Succeeds by construction: dispatch validates before command lookup. */
const cmdEnvelopeValidate: Handler = (s, env) => {
  delta(s, env.id, "envelope OK: passed schema validation");
  completed(s, env.id, { validated: true });
  return 0;
};

const cmdIdrEmit: Handler = (s, env) => {
  completed(s, env.id);
  return 0;
};

function decodeBody(arg: unknown): Record<string, unknown> | null {
  if (arg && typeof arg === "object" && !Array.isArray(arg)) {
    return arg as Record<string, unknown>;
  }
  if (typeof arg !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(arg);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const cmdContextAppend: Handler = (s, env) => {
  const args = env.args ?? [];
  if (args.length === 0) {
    return fail(s, env.id, "parse_error", "context.append: requires args[0] = decision body JSON");
  }
  const body = decodeBody(args[0]);
  if (body === null) {
    return fail(s, env.id, "parse_error", "context.append: decision body must be a JSON object");
  }
  const flags = env.flags ?? {};
  completed(s, env.id, { content_addr: contentAddr(body) });
  emit(s, env.id, "context", {
    context_ref: {
      sha256: contentAddr(body),
      predecessor_context: flags.predecessor_context ?? null,
      snapshot_ref: flags.snapshot_ref ?? null,
      kind: typeof flags.kind === "string" && flags.kind ? flags.kind : "context-delta",
      model_versions: stringList(flags.model_versions),
    },
  });
  return 0;
};

interface SourceIndex {
  byId: Map<string, string>;
  citations: Array<Record<string, unknown>>;
}

function citeInputs(flags: Record<string, unknown>): SourceIndex | null {
  const sources = flags.sources;
  const citations = flags.citations;
  if (!Array.isArray(sources) || !Array.isArray(citations)) return null;
  const byId = new Map<string, string>();
  for (const raw of sources) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Record<string, unknown>;
    if (typeof source.id !== "string" || typeof source.text !== "string") return null;
    byId.set(source.id, source.text);
  }
  return { byId, citations: citations as Array<Record<string, unknown>> };
}

const cmdCiteVerify: Handler = (s, env) => {
  const flags = env.flags ?? {};
  const input = citeInputs(flags);
  if (input === null) {
    return fail(s, env.id, "parse_error", "cite.verify: requires flags.sources[] and flags.citations[]");
  }
  const tally: Record<CitationStatus, number> = { verified: 0, fuzzy: 0, not_found: 0 };
  const results = input.citations.map((citation) => {
    const id = typeof citation.id === "string" ? citation.id : "";
    const sourceId = typeof citation.source_id === "string" ? citation.source_id : "";
    const quote = typeof citation.quote === "string" ? citation.quote : "";
    const text = input.byId.get(sourceId);
    const outcome =
      text === undefined
        ? { status: STATUS_NOT_FOUND as CitationStatus, start: -1, end: -1 }
        : verifyQuote(quote, text);
    tally[outcome.status] += 1;
    delta(s, env.id, `${id} ${outcome.status}`);
    return { id, source_id: sourceId, status: outcome.status, start: outcome.start, end: outcome.end };
  });

  const sources: Record<string, unknown> = {};
  for (const [id, text] of Array.from(input.byId.entries()).sort()) {
    // Character count, not byte count — the other runtimes report code
    // points, and a byte count would differ for any non-ASCII source.
    sources[id] = { sha256: sha256Hex(text), chars: Array.from(text).length };
  }
  const grounded = tally.verified + tally.fuzzy;
  const record = {
    sources,
    citations: results,
    tally,
    grounding_rate: Math.round((grounded / Math.max(results.length, 1)) * 1000) / 1000,
  };

  if (flags.strict === true && tally.not_found > 0) {
    return fail(
      s,
      env.id,
      "runtime_error",
      `${tally.not_found} citation(s) NOT verbatim in source — unproven`,
    );
  }
  completed(s, env.id, record);
  return 0;
};

/** Command lookup. A map keeps dispatch flat and O(1). */
const COMMANDS = new Map<string, Handler>([
  ["version", cmdVersion],
  ["echo", cmdEcho],
  ["spec.describe", cmdSpecDescribe],
  ["envelope.validate", cmdEnvelopeValidate],
  ["idr.emit", cmdIdrEmit],
  ["context.append", cmdContextAppend],
  [CITE_VERIFY_CMD, cmdCiteVerify],
]);

// --- dispatch ---------------------------------------------------------------

function parseEnvelope(raw: string): { env?: Envelope; error?: string } {
  if (!raw.trim()) return { error: "empty stdin" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `invalid JSON: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "envelope must be a JSON object" };
  }
  const env = parsed as Partial<Envelope>;
  if (!isAcceptedVersion(env.v)) {
    return { error: `unsupported version: ${JSON.stringify(env.v)} (accepted: happi/1.x)` };
  }
  if (typeof env.id !== "string" || !env.id) return { error: "missing or invalid 'id'" };
  if (typeof env.cmd !== "string" || !env.cmd) return { error: "missing or invalid 'cmd'" };
  return { env: env as Envelope };
}

/**
 * Run one envelope. Returns the event lines and the process exit code, so the
 * behaviour can be tested without spawning a process.
 */
export function dispatch(raw: string): { lines: string[]; code: number } {
  const s: Session = { lines: [], audit: false, models: [], emitted: [] };
  const { env, error } = parseEnvelope(raw);
  if (!env) {
    // No id is available on a malformed envelope, so the error carries the
    // empty id rather than inventing one.
    const code = fail(s, "", "parse_error", error ?? "unparseable envelope");
    return { lines: s.lines, code };
  }
  const flags = env.flags ?? {};
  if (flags.audit === true) {
    s.audit = true;
    s.models = stringList(flags.model_versions);
  }
  emit(s, env.id, "started");
  const handler = COMMANDS.get(env.cmd);
  const code = handler
    ? handler(s, env)
    : fail(s, env.id, "unsupported_cmd", `cmd not implemented: ${env.cmd}`);
  if (s.audit) {
    const digest = createHash("sha256").update(raw, "utf8");
    for (const line of s.emitted) digest.update(line, "utf8");
    emit(s, env.id, "idr", {
      idr_ref: {
        sha256: digest.digest("hex"),
        cid: null,
        model_versions: s.models,
        block_anchor: null,
      },
    });
  }
  return { lines: s.lines, code };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const { lines, code } = dispatch(raw);
  process.stdout.write(lines.map((l) => `${l}\n`).join(""));
  process.exitCode = code;
}

// Only run when executed directly, so importing this module for tests does
// not block on stdin.
if (process.argv[1] && /cli\.(js|cjs|ts)$/.test(process.argv[1])) {
  void main();
}
