/**
 * HAPPI/1.3 envelope — the wire-level contract.
 *
 * Reference: happi.md §envelope-schema — published at
 * https://gist.github.com/LaurieScheepers/2483d5c218c21ecc931130bcee7dee83
 *
 *   {"v":"happi/1.3","id":"<opaque>","cmd":"<dot.path>","args":[],"flags":{},"auth":{}}
 *
 * Forward-compatible: unknown fields are forwarded unchanged. We intentionally
 * keep `[k: string]: unknown` so that future protocol fields don't break
 * existing decoders. This mirrors the reference Python runtime's permissive
 * parsing and the OpenAPI `additionalProperties: true` declaration.
 */

/** Protocol version this library stamps on envelopes it builds. */
export const HAPPI_VERSION = "happi/1.3" as const;

/**
 * Versions this build has been explicitly tested against. Informational
 * only — see `isAcceptedVersion` for the actual acceptance rule. Do NOT use
 * this to gate acceptance: a hardcoded list only defers the break to the day
 * a runtime ships the next minor.
 */
export const KNOWN_VERSIONS = [
  "happi/1.0",
  "happi/1.1",
  "happi/1.2",
  "happi/1.3",
] as const;

/**
 * Any well-formed `happi/1.<minor>` version string, for any minor.
 *
 * A runtime stamps events with its OWN version, never the envelope's, so a
 * v1.0 request to a v1.3 runtime returns v1.3 events — checking for exact
 * equality against a single constant therefore only ever works against one
 * runtime build. HAPPI's compatibility promise is per MAJOR version: within
 * v1, changes are additive, so acceptance must not depend on a version being
 * listed — that only defers the same bug to the day a runtime ships
 * happi/1.4 and every client rejects it again for no reason. A different
 * major (happi/0.9, happi/2.0) is still rejected.
 */
export type HappiVersion = `happi/1.${number}`;

const HAPPI_V1_RE = /^happi\/1\.\d+$/;

/**
 * True iff `value` is a well-formed happi/1.x version string, for any minor.
 * Rejects a different major and malformed strings (`happi/1`, `happi/x.y`,
 * a bare `1.3`, empty).
 */
export function isAcceptedVersion(value: unknown): value is HappiVersion {
  return typeof value === "string" && HAPPI_V1_RE.test(value);
}

/**
 * The HAPPI envelope. `v`, `id`, `cmd` are required by the spec. The
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
  if (!isAcceptedVersion(v.v)) {
    return {
      error:
        `unsupported version: ${JSON.stringify(v.v)} ` +
        `(accepted: any happi/1.x)`,
    };
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
export interface MakeEnvelopeFields {
  readonly id: string;
  readonly cmd: string;
  /** Override the emitted version. Defaults to HAPPI_VERSION. */
  readonly v?: HappiVersion;
  readonly args?: ReadonlyArray<unknown>;
  readonly flags?: Readonly<Record<string, unknown>>;
  readonly auth?: Readonly<Record<string, unknown>>;
  readonly [k: string]: unknown;
}

export function makeEnvelope(fields: MakeEnvelopeFields): Envelope {
  // Spelled out rather than derived via Omit<Envelope, "v">: because Envelope
  // carries an index signature, Omit absorbs `id`/`cmd` into it and they stop
  // being required — which then fails to satisfy Envelope on return.
  return { ...fields, v: fields.v ?? HAPPI_VERSION };
}
