/**
 * HAPPI/1.3 — version negotiation, v1.1 record terminators, cite.verify.
 *
 * Regression anchors for a real interop break: hal-js v0.1 checked
 * `v.v !== HAPPI_VERSION` in decodeEvent and returned null on mismatch. Once
 * the reference runtime advanced to happi/1.3, every event was dropped —
 * SILENTLY, because a null decode is skipped by the stream parser rather
 * than raised. The symptom was an empty event stream, not an error.
 */

import { describe, it, expect } from "vitest";
import {
  KNOWN_VERSIONS,
  HAPPI_VERSION,
  decode,
  isAcceptedVersion,
} from "../src/envelope.js";
import {
  EVENT_TYPES,
  STREAMING_EVENT_TYPES,
  decodeEvent,
  isOutcome,
  isPostTerminator,
  type ContextEvent,
  type IdrEvent,
} from "../src/events.js";
import {
  decodeProvenance,
  isFullyGrounded,
  makeCiteVerify,
  notFound,
  verified,
  type Provenance,
} from "../src/cite.js";
import { dispatchToArray } from "../src/client.js";
import { referenceRuntimeCmd } from "./_runtime.js";

/* ── fixtures ───────────────────────────────────────────────────────────── */

const ALL_VERSIONS = ["happi/1.0", "happi/1.1", "happi/1.2", "happi/1.3"];
// No runtime has shipped these yet. Still accepted: HAPPI's compatibility
// promise is per MAJOR version, so a client must not reject a future minor.
const FUTURE_MINOR_VERSIONS = ["happi/1.4", "happi/1.99"];
const BAD_VERSIONS = [
  "happi/0.9",
  "happi/2.0",
  "happi/1",
  "happi/1.",
  "happi/x.y",
  "",
  "1.3",
];

const IDR_RAW = {
  v: "happi/1.3",
  id: "r",
  type: "idr",
  ts: 7,
  idr_ref: {
    sha256: "abc123",
    cid: null,
    model_versions: ["claude-opus-4-7"],
    block_anchor: null,
  },
};

const CONTEXT_RAW = {
  v: "happi/1.3",
  id: "r",
  type: "context",
  ts: 8,
  context_ref: {
    sha256: "sha256:def456",
    predecessor_context: "r-prev",
    snapshot_ref: null,
    kind: "context-delta",
    model_versions: ["claude-opus-4-7"],
  },
};

const SOURCE = {
  id: "s1",
  text: "The Limitation Act 1980 bars the claim after six years.",
};
const REAL = { id: "c1", source_id: "s1", quote: "bars the claim after six years" };
const FAKE = { id: "c2", source_id: "s1", quote: "bars the claim after three years" };

const USAGE = {
  sources: { s1: { sha256: "deadbeef", chars: 55 } },
  citations: [
    { id: "c1", source_id: "s1", status: "verified", start: 24, end: 54 },
    { id: "c2", source_id: "s1", status: "not_found", start: -1, end: -1 },
  ],
  tally: { verified: 1, fuzzy: 0, not_found: 1 },
  grounding_rate: 0.5,
};

/* ── version negotiation ────────────────────────────────────────────────── */

describe("version constants", () => {
  it("emits happi/1.3", () => {
    expect(HAPPI_VERSION).toBe("happi/1.3");
  });

  it("lists the versions this build has been tested against", () => {
    // KNOWN_VERSIONS is informational only — it does not gate acceptance
    // (see "accepting any happi/1.x minor" below). Named explicitly so a
    // mutation narrowing the tuple fails rather than trivially agreeing
    // with itself.
    expect([...KNOWN_VERSIONS]).toEqual(ALL_VERSIONS);
  });
});

describe("accepting the supported range", () => {
  it.each(ALL_VERSIONS)("decodes a %s envelope", (v) => {
    expect("error" in decode({ v, id: "r", cmd: "version" })).toBe(false);
  });

  it.each(ALL_VERSIONS)("decodes a %s event", (v) => {
    const event = decodeEvent({ v, id: "r", type: "started", ts: 0 });
    expect(event?.v).toBe(v);
  });
});

describe("parsing a 1.3 runtime stream", () => {
  it("decodes every line", () => {
    // Verbatim shape of what `bash happi.md run` emits for cmd `version`.
    const parsed = [
      { v: "happi/1.3", id: "p", type: "started", ts: 0 },
      { v: "happi/1.3", id: "p", type: "delta", ts: 0, text: "happi/1.3" },
      { v: "happi/1.3", id: "p", type: "completed", ts: 0 },
    ].map(decodeEvent);

    expect(parsed.every((e) => e !== null)).toBe(true);
    expect(parsed.map((e) => e?.type)).toEqual(["started", "delta", "completed"]);
  });
});

describe("accepting any happi/1.x minor (per-major compatibility)", () => {
  it.each(FUTURE_MINOR_VERSIONS)(
    "accepts %s even though no runtime has shipped it yet",
    (v) => {
      expect(isAcceptedVersion(v)).toBe(true);
      expect("error" in decode({ v, id: "r", cmd: "version" })).toBe(false);
    },
  );
});

describe("rejecting out-of-range versions", () => {
  it.each(BAD_VERSIONS)("rejects %s", (bad) => {
    expect(isAcceptedVersion(bad)).toBe(false);
    expect("error" in decode({ v: bad, id: "r", cmd: "version" })).toBe(true);
    expect(decodeEvent({ v: bad, id: "r", type: "started", ts: 0 })).toBeNull();
  });
});

/* ── v1.1 record terminators ────────────────────────────────────────────── */

describe("event type registry", () => {
  it("exposes 7 streaming types plus idr and context", () => {
    expect([...STREAMING_EVENT_TYPES]).toHaveLength(7);
    expect([...EVENT_TYPES]).toHaveLength(9);
    expect([...EVENT_TYPES]).toContain("idr");
    expect([...EVENT_TYPES]).toContain("context");
  });
});

describe("idr event", () => {
  it("decodes with its audit ref intact", () => {
    const event = decodeEvent(IDR_RAW) as IdrEvent | null;
    expect(event?.type).toBe("idr");
    expect(event?.idr_ref.sha256).toBe("abc123");
    expect(event?.idr_ref.model_versions).toEqual(["claude-opus-4-7"]);
  });
});

describe("context event", () => {
  it("decodes with its chain link intact", () => {
    const event = decodeEvent(CONTEXT_RAW) as ContextEvent | null;
    expect(event?.type).toBe("context");
    expect(event?.context_ref.kind).toBe("context-delta");
    expect(event?.context_ref.predecessor_context).toBe("r-prev");
  });
});

describe("terminator classification", () => {
  it("separates outcome events from post-terminators", () => {
    const completed = decodeEvent({
      v: "happi/1.3", id: "r", type: "completed", ts: 5,
    })!;
    const idr = decodeEvent(IDR_RAW)!;
    expect([isOutcome(completed), isPostTerminator(completed)]).toEqual([true, false]);
    expect([isOutcome(idr), isPostTerminator(idr)]).toEqual([false, true]);
  });
});

/* ── cite.verify ────────────────────────────────────────────────────────── */

describe("cite.verify envelope", () => {
  it("builds the documented shape", () => {
    const env = makeCiteVerify({ id: "cv-1", sources: [SOURCE], citations: [REAL, FAKE] });
    expect(env.cmd).toBe("cite.verify");
    expect(env.v).toBe("happi/1.3");
    expect(env.flags?.sources).toEqual([SOURCE]);
    // Default is non-strict: the caller reads grounding_rate instead.
    expect(env.flags?.strict).toBeUndefined();
  });

  it("sets strict when requested", () => {
    const env = makeCiteVerify({
      id: "cv-2", sources: [SOURCE], citations: [REAL], strict: true,
    });
    expect(env.flags?.strict).toBe(true);
  });
});

describe("cite.verify input validation", () => {
  it("rejects empty sources or citations", () => {
    expect(() => makeCiteVerify({ id: "x", sources: [], citations: [REAL] })).toThrow();
    expect(() => makeCiteVerify({ id: "x", sources: [SOURCE], citations: [] })).toThrow();
  });
});

describe("provenance record", () => {
  it("separates fabricated citations from verified ones", () => {
    const record = decodeProvenance(USAGE) as Provenance;
    expect(record.grounding_rate).toBe(0.5);
    expect(verified(record).map((c) => c.id)).toEqual(["c1"]);
    expect(notFound(record).map((c) => c.id)).toEqual(["c2"]);
    expect(isFullyGrounded(record)).toBe(false);
  });

  it("rejects an unknown status", () => {
    const bad = { citations: [{ id: "c1", source_id: "s1", status: "probably" }] };
    expect(decodeProvenance(bad)).toBeNull();
  });
});

describe("empty provenance", () => {
  it("is not grounded, because nothing was proven", () => {
    const empty: Provenance = {
      sources: {}, citations: [], tally: {}, grounding_rate: 0,
    };
    expect(isFullyGrounded(empty)).toBe(false);
  });
});

/* ── live cross-runtime conformance (skipped when no happi.md) ──────────── */

const RUNTIME = referenceRuntimeCmd();
const describeIfHappi = RUNTIME === null ? describe.skip : describe;
const cmd = RUNTIME ?? [];

describeIfHappi("live cite.verify", () => {
  it("resolves a fabricated quote to not_found", async () => {
    const env = makeCiteVerify({
      id: "live-cv", sources: [SOURCE], citations: [REAL, FAKE],
    });
    const events = await dispatchToArray(env, { cmd });
    const completed = events.find((e) => e.type === "completed");
    const record = decodeProvenance(
      (completed as { usage?: unknown } | undefined)?.usage,
    ) as Provenance;

    expect(notFound(record).map((c) => c.id)).toEqual(["c2"]);
    expect(record.grounding_rate).toBe(0.5);
  });
});
