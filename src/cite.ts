/**
 * HAPPI/1.3 `cite.verify` — deterministic citation provenance.
 *
 * The un-fakeable floor of grounded AI, lifted to protocol level. A cited
 * quote is verbatim-present in its source, or it is not — a deterministic
 * string match, not a judgement. A fabricated quote can never earn
 * `verified` or `fuzzy`; it resolves to `not_found`.
 *
 * This module is the typed surface: build the envelope, parse the provenance
 * record the runtime returns in `completed.usage`. The verification itself
 * happens in the runtime, never here — a client that graded its own citations
 * would be marking its own homework.
 *
 * What it proves: the quote is verbatim in the SUPPLIED source. What it does
 * not prove: that the source is authentic, or that the quote supports the
 * claim. Those stay the caller's responsibility.
 */

import { makeEnvelope, type Envelope } from "./envelope.js";
import type { CompletedEvent, HappiEvent } from "./events.js";

/** The runtime cmd this module targets. */
export const CITE_VERIFY_CMD = "cite.verify";

/** Quote located by exact substring match. */
export const STATUS_VERIFIED = "verified";

/**
 * Quote located after length-preserving normalisation of whitespace and
 * typographic variants (unicode dashes, smart quotes, nbsp).
 */
export const STATUS_FUZZY = "fuzzy";

/** Quote absent from its source. A fabricated citation always lands here. */
export const STATUS_NOT_FOUND = "not_found";

export const CITATION_STATUSES = [
  STATUS_VERIFIED,
  STATUS_FUZZY,
  STATUS_NOT_FOUND,
] as const;

export type CitationStatus = (typeof CITATION_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(CITATION_STATUSES);

/** Statuses that count as grounded. */
const GROUNDED: ReadonlySet<string> = new Set([STATUS_VERIFIED, STATUS_FUZZY]);

/** A document a citation may quote. */
export interface Source {
  readonly id: string;
  readonly text: string;
}

/** A claim's exact quoted words and which source they come from. */
export interface Citation {
  readonly id: string;
  readonly source_id: string;
  readonly quote: string;
}

/** Per-citation verdict. `start`/`end` are -1 when not found. */
export interface CitationResult {
  readonly id: string;
  readonly source_id: string;
  readonly status: CitationStatus;
  readonly start: number;
  readonly end: number;
}

export interface SourceDigest {
  readonly sha256: string;
  readonly chars: number;
  readonly [k: string]: unknown;
}

/**
 * The provenance record returned in `completed.usage`. Same shape as the
 * Python engine's, so the two interoperate; the per-source sha256 plus
 * per-citation offsets are exactly what an IDR or memory-chain leaf signs.
 */
export interface Provenance {
  readonly sources: Readonly<Record<string, SourceDigest>>;
  readonly citations: ReadonlyArray<CitationResult>;
  readonly tally: Readonly<Record<string, number>>;
  readonly grounding_rate: number;
}

export interface CiteVerifyOptions {
  readonly id: string;
  readonly sources: ReadonlyArray<Source>;
  readonly citations: ReadonlyArray<Citation>;
  /**
   * When true the runtime emits `error` (exit non-zero) if ANY citation is
   * not found — the build-gate form. Default false: the runtime emits
   * `completed` and the caller reads `grounding_rate`.
   */
  readonly strict?: boolean;
  readonly auth?: Readonly<Record<string, unknown>>;
}

/** Build a `cite.verify` envelope. */
export function makeCiteVerify(options: CiteVerifyOptions): Envelope {
  const { id, sources, citations, strict, auth } = options;
  if (sources.length === 0) {
    throw new Error("cite.verify requires at least one source");
  }
  if (citations.length === 0) {
    throw new Error("cite.verify requires at least one citation");
  }
  const flags: Record<string, unknown> = {
    sources: sources.map((s) => ({ id: s.id, text: s.text })),
    citations: citations.map((c) => ({
      id: c.id,
      source_id: c.source_id,
      quote: c.quote,
    })),
  };
  if (strict === true) flags.strict = true;
  return makeEnvelope(auth ? { id, cmd: CITE_VERIFY_CMD, flags, auth }
                           : { id, cmd: CITE_VERIFY_CMD, flags });
}

/** True if this citation's quote was located in its source. */
export function isGrounded(result: CitationResult): boolean {
  return GROUNDED.has(result.status);
}

/** Citations absent from their source — the fabricated ones. */
export function notFound(
  record: Provenance,
): ReadonlyArray<CitationResult> {
  return record.citations.filter((c) => c.status === STATUS_NOT_FOUND);
}

/** Citations located by exact match. */
export function verified(
  record: Provenance,
): ReadonlyArray<CitationResult> {
  return record.citations.filter((c) => c.status === STATUS_VERIFIED);
}

/**
 * True if every citation was located in its cited source. False for an empty
 * record: nothing was proven, so nothing is grounded.
 */
export function isFullyGrounded(record: Provenance): boolean {
  return record.citations.length > 0 && notFound(record).length === 0;
}

/** Parse the provenance record out of a `completed` event's usage field. */
export function decodeProvenance(usage: unknown): Provenance | null {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const u = usage as Record<string, unknown>;
  if (!Array.isArray(u.citations)) return null;
  const citations: CitationResult[] = [];
  for (const raw of u.citations) {
    const result = decodeCitationResult(raw);
    if (result === null) return null;
    citations.push(result);
  }
  return {
    sources: (u.sources ?? {}) as Readonly<Record<string, SourceDigest>>,
    citations,
    tally: (u.tally ?? {}) as Readonly<Record<string, number>>,
    grounding_rate:
      typeof u.grounding_rate === "number" ? u.grounding_rate : 0,
  };
}

function decodeCitationResult(value: unknown): CitationResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const c = value as Record<string, unknown>;
  const status = c.status;
  if (typeof status !== "string" || !STATUS_SET.has(status)) return null;
  return {
    id: typeof c.id === "string" ? c.id : "",
    source_id: typeof c.source_id === "string" ? c.source_id : "",
    status: status as CitationStatus,
    start: typeof c.start === "number" ? c.start : -1,
    end: typeof c.end === "number" ? c.end : -1,
  };
}

/**
 * Extract the provenance record from a dispatched event stream. Returns null
 * when the stream carried no `completed` event — including the strict-mode
 * case, where the runtime emits `error` instead.
 */
export function provenanceFromEvents(
  events: Iterable<HappiEvent>,
): Provenance | null {
  for (const event of events) {
    if (event.type === "completed") {
      return decodeProvenance((event as CompletedEvent).usage);
    }
  }
  return null;
}
