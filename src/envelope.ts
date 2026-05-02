/**
 * HAPPI/1.0 envelope — the wire-level contract.
 *
 * Reference: /Users/lauriescheepers/.hal/happi.md (canonical) §envelope-schema.
 *
 *   {"v":"happi/1.0","id":"<opaque>","cmd":"<dot.path>","args":[],"flags":{},"auth":{}}
 *
 * Forward-compatible: unknown fields are forwarded unchanged. We intentionally
 * keep `[k: string]: unknown` so that future protocol fields don't break
 * existing decoders. This mirrors the reference Python runtime's permissive
 * parsing and the OpenAPI `additionalProperties: true` declaration.
 */

export const HAPPI_VERSION = "happi/1.0" as const;

export type HappiVersion = typeof HAPPI_VERSION;

/**
 * The HAPPI/1.0 envelope. `v`, `id`, `cmd` are required by the spec. The
 * remaining fields are optional and opaque-pass-through.
 */
export interface Envelope {
  readonly v: HappiVersion;
  readonly id: string;
  readonly cmd: string;
  readonly args?: ReadonlyArray<unknown>;
  readonly flags?: Readonly<Record<string, unknown>>;
  readonly auth?: Readonly<Record<string, unknown>>;
  readonly [k: string]: unknown;
}

/**
 * Validation failure — discriminated by `error` field for narrowing.
 */
export interface EnvelopeError {
  readonly error: string;
}

/**
 * Decode + structurally validate an envelope from a parsed JSON value.
 * Returns the envelope on success or `EnvelopeError` on failure.
 *
 * Mirrors `parse_envelope` in the reference Python runtime
 * (happi.md lines 279–295). Same invariants, same error vocabulary.
 */
export function decode(value: unknown): Envelope | EnvelopeError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: "envelope must be a JSON object" };
  }
  const v = value as Record<string, unknown>;
  if (v.v !== HAPPI_VERSION) {
    return { error: `unsupported version: ${JSON.stringify(v.v)}` };
  }
  if (typeof v.id !== "string" || v.id.length === 0) {
    return { error: "missing or invalid 'id' (must be non-empty string)" };
  }
  if (typeof v.cmd !== "string" || v.cmd.length === 0) {
    return { error: "missing or invalid 'cmd' (must be non-empty string)" };
  }
  // Cast is sound: we just verified the three required fields above and the
  // index signature accepts arbitrary additional properties.
  return v as unknown as Envelope;
}

/**
 * Encode an envelope to its canonical JSON-string form. Compact separators —
 * matches the reference runtime's `json.dumps(separators=(",", ":"))` so that
 * round-tripping through bash/python is byte-stable.
 */
export function encode(env: Envelope): string {
  return JSON.stringify(env);
}

/**
 * Type guard. Returns true iff the value is a valid HAPPI envelope.
 */
export function isEnvelope(value: unknown): value is Envelope {
  const result = decode(value);
  return !("error" in result);
}

/**
 * Convenience constructor — fills in `v` automatically.
 *
 *   makeEnvelope({ id: "r1", cmd: "version" })
 */
export function makeEnvelope(
  fields: Omit<Envelope, "v"> & Partial<Pick<Envelope, "v">>,
): Envelope {
  return { v: HAPPI_VERSION, ...fields };
}
