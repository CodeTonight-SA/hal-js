/**
 * Tests for the hal-js HAPPI runtime (`src/cli.ts`).
 *
 * `dispatch` returns the event lines and the exit code rather than writing to
 * stdout, so everything here is testable in-process.
 */
import { describe, expect, it } from "vitest";

import { contentAddr, dispatch, verifyQuote } from "../src/cli.js";
import { HAPPI_VERSION } from "../src/envelope.js";

type Event = Record<string, any>;

function run(envelope: unknown): { events: Event[]; code: number } {
  const { lines, code } = dispatch(JSON.stringify(envelope));
  return { events: lines.map((l) => JSON.parse(l)), code };
}

const typesOf = (events: Event[]) => events.map((e) => e.type);
const last = (events: Event[]) => events[events.length - 1];

const SOURCE = "The Limitation Act 1980 bars the claim after six years.";
const GROUNDED = "bars the claim after six years";

const citeEnvelope = (quote: string, strict = false) => ({
  v: "happi/1.3",
  id: "cv",
  cmd: "cite.verify",
  flags: {
    sources: [{ id: "s1", text: SOURCE }],
    citations: [{ id: "c1", source_id: "s1", quote }],
    ...(strict ? { strict: true } : {}),
  },
});

const citationOf = (events: Event[]) => last(events).usage.citations[0];

const AUDITED = {
  v: "happi/1.1",
  id: "a",
  cmd: "echo",
  args: ["x"],
  flags: { audit: true, model_versions: ["test-model"] },
};

describe("version reporting", () => {
  it("reports the runtime's own version, never the envelope's", () => {
    // The single most important version property, and the one whose absence
    // caused every SDK breakage this release fixes.
    const { events, code } = run({ v: "happi/1.0", id: "v", cmd: "version" });
    expect(code).toBe(0);
    expect(new Set(events.map((e) => e.v))).toEqual(new Set([HAPPI_VERSION]));
    expect(events[1].text).toBe(HAPPI_VERSION);
  });
});

describe("version acceptance", () => {
  it.each(["happi/1.0", "happi/1.1", "happi/1.2", "happi/1.3", "happi/1.7", "happi/1.42"])(
    "accepts %s — a runtime newer than this library is the normal case",
    (version) => {
      expect(run({ v: version, id: "v", cmd: "version" }).code).toBe(0);
    },
  );

  it.each(["happi/0.9", "happi/2.0", "happi/", "happi/1", "1.3", "junk", ""])(
    "rejects %s",
    (version) => {
      const { events, code } = run({ v: version, id: "v", cmd: "version" });
      expect(code).not.toBe(0);
      expect(typesOf(events)).toEqual(["error"]);
    },
  );
});

describe("stream shape", () => {
  it("emits exactly one outcome event", () => {
    const { events } = run({ v: "happi/1.3", id: "o", cmd: "echo", args: ["a", "b"] });
    expect(typesOf(events).filter((t) => t === "completed" || t === "error")).toHaveLength(1);
  });

  it("streams one delta per argument", () => {
    const { events } = run({ v: "happi/1.3", id: "e", cmd: "echo", args: ["one", "two"] });
    expect(events.filter((e) => e.type === "delta").map((e) => e.text)).toEqual(["one", "two"]);
  });

  it("reports an unknown command as unsupported_cmd", () => {
    const { events, code } = run({ v: "happi/1.3", id: "u", cmd: "no.such.cmd" });
    expect(code).not.toBe(0);
    expect(last(events).code).toBe("unsupported_cmd");
  });
});

describe("failure paths", () => {
  it.each([
    ['{"v":"happi/1.3","id":"a","cmd":"no.such.cmd"}', "unknown command"],
    ['{"v":"happi/9.9","id":"b","cmd":"version"}', "wrong major"],
    ['{"v":"happi/1.3","id":"c","cmd":"context.append"}', "missing body"],
    ['{"v":"happi/1.3","id":"d","cmd":"cite.verify","flags":{}}', "missing citations"],
    ["not json at all", "malformed input"],
  ])("emits an error event AND fails for %s (%s)", (raw) => {
    // An error event and a non-zero exit must never come apart: a caller that
    // checks only one of them would otherwise miss half the failures.
    const { lines, code } = dispatch(raw);
    expect(typesOf(lines.map((l) => JSON.parse(l))).includes("error")).toBe(code !== 0);
  });
});

describe("audit terminator", () => {
  it("appends an idr AFTER the outcome", () => {
    const { events } = run(AUDITED);
    const kinds = typesOf(events);
    expect(kinds[kinds.length - 1]).toBe("idr");
    expect(kinds.indexOf("completed")).toBeLessThan(kinds.indexOf("idr"));
    expect(last(events).idr_ref.model_versions).toEqual(["test-model"]);
  });

  it("hashes the same envelope and stream identically", () => {
    const first = last(run(AUDITED).events).idr_ref.sha256;
    expect(last(run(AUDITED).events).idr_ref.sha256).toBe(first);
  });

  it("emits no idr when audit is not requested", () => {
    const { events } = run({ v: "happi/1.3", id: "a", cmd: "echo", args: ["x"] });
    expect(typesOf(events)).not.toContain("idr");
  });
});

describe("context event ordering", () => {
  it("emits context AFTER the outcome, following the spec over the fixture", () => {
    // HAPPI.md calls context "a non-streaming terminator emitted after
    // completed/error" and names the reverse order as a falsifier. The
    // reference emits it BEFORE, so this runtime fails the recorded fixture
    // rather than copy the violation. This test pins the correct order so
    // nobody resolves that mismatch by adopting the bug. See issue #2.
    const { events, code } = run({
      v: "happi/1.3",
      id: "c",
      cmd: "context.append",
      args: ['{"decision":"d","rationale":"r"}'],
      flags: { kind: "context-delta", model_versions: ["m"] },
    });
    expect(code).toBe(0);
    const kinds = typesOf(events);
    expect(kinds).toContain("context");
    expect(kinds.indexOf("completed")).toBeLessThan(kinds.indexOf("context"));
  });

  it("rejects a non-object decision body", () => {
    const { events, code } = run({
      v: "happi/1.3",
      id: "c",
      cmd: "context.append",
      args: ['"just a string"'],
    });
    expect(code).not.toBe(0);
    expect(last(events).code).toBe("parse_error");
  });
});

describe("content addressing", () => {
  it("ignores volatile fields", () => {
    // That equality IS the dedup coordinate: without it the same belief
    // recorded twice would occupy two chain nodes.
    expect(contentAddr({ decision: "accept", rationale: "because" })).toBe(
      contentAddr({ decision: "accept", rationale: "because", id: "xyz", ts: 999, audit: true }),
    );
  });

  it("changes when the meaning changes", () => {
    expect(contentAddr({ decision: "accept" })).not.toBe(contentAddr({ decision: "reject" }));
  });

  it("is independent of key order", () => {
    expect(contentAddr({ a: 1, b: 2 })).toBe(contentAddr({ b: 2, a: 1 }));
  });

  it("matches the address the reference, hal-py and hal-go produce", () => {
    // If this drifts, context chains written by hal-js stop de-duplicating
    // against chains written by any other runtime — the exact failure the
    // content address exists to prevent, invisible until two chains merge.
    expect(
      contentAddr({
        decision: "Accept happi/1.0 through happi/1.3 rather than one exact version",
        rationale: "A runtime stamps events with its own version, never the envelope's",
      }),
    ).toBe("sha256:84c0b0be810d70c7d1eb86e3609cbf0df9697a7a3b145e349332c8bb8133136f");
  });
});

describe("cite.verify — grounded quotes", () => {
  it("verifies a verbatim quote with offsets that round-trip", () => {
    const { events, code } = run(citeEnvelope(GROUNDED));
    expect(code).toBe(0);
    const c = citationOf(events);
    expect(c.status).toBe("verified");
    expect(Array.from(SOURCE).slice(c.start, c.end).join("")).toBe(GROUNDED);
  });

  it("passes strict mode when everything is grounded", () => {
    expect(run(citeEnvelope(GROUNDED, true)).code).toBe(0);
  });
});

describe("cite.verify — fabricated quotes", () => {
  it.each([
    "bars the claim after three years",
    "permits the claim after six years",
    "The Limitation Act 1990 bars the claim",
    "an entirely unrelated sentence",
  ])("never verifies %s", (fabricated) => {
    // The entire guarantee. A caller uses this to decide whether a claim is
    // grounded, so a false positive here is the one failure that matters.
    expect(citationOf(run(citeEnvelope(fabricated)).events).status).toBe("not_found");
  });

  it("turns an unverified citation into a failed build under strict", () => {
    const { events, code } = run(citeEnvelope("bars the claim after three years", true));
    expect(code).not.toBe(0);
    expect(last(events).code).toBe("runtime_error");
    expect(last(events).message).toContain("NOT verbatim");
  });
});

describe("cite.verify — provenance record", () => {
  it("reports the proportion verified", () => {
    const { events } = run({
      v: "happi/1.3",
      id: "cv",
      cmd: "cite.verify",
      flags: {
        sources: [{ id: "s1", text: SOURCE }],
        citations: [
          { id: "c1", source_id: "s1", quote: GROUNDED },
          { id: "c2", source_id: "s1", quote: "bars the claim after three years" },
        ],
      },
    });
    expect(last(events).usage.tally).toEqual({ verified: 1, fuzzy: 0, not_found: 1 });
    expect(last(events).usage.grounding_rate).toBe(0.5);
  });

  it("counts characters, not bytes, in the source digest", () => {
    // The other runtimes report code points; a byte count would differ for
    // any non-ASCII source, and differ silently.
    const text = "café — naïve";
    const { events } = run({
      v: "happi/1.3",
      id: "cv",
      cmd: "cite.verify",
      flags: {
        sources: [{ id: "s1", text }],
        citations: [{ id: "c1", source_id: "s1", quote: "café" }],
      },
    });
    expect(last(events).usage.sources.s1.chars).toBe(Array.from(text).length);
  });
});

describe("verifyQuote — regex safety", () => {
  it("matches a quote of regex metacharacters literally", () => {
    // The tolerant pass builds a regex from the quote, so leaving it
    // unescaped would let a caller inject a pattern instead of searching for
    // the text they wrote.
    const source = "literal (a+)+$ here";
    const { status, start, end } = verifyQuote("(a+)+$", source);
    expect(status).toBe("verified");
    expect(Array.from(source).slice(start, end).join("")).toBe("(a+)+$");
  });

  it("does not let an escaped metacharacter quote match everything", () => {
    expect(verifyQuote(".*", "no wildcards here").status).toBe("not_found");
  });
});

describe("verifyQuote — bounded work", () => {
  it("stays bounded on a pathological quote", () => {
    const started = Date.now();
    const { status } = verifyQuote(
      Array(400).fill("a").join(" "),
      `${Array(399).fill("a").join(" ")} b`,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(status).toBe("not_found");
  });

  it("skips fuzzing past the token limit but still matches exactly", () => {
    // Past the limit the tolerant pass is skipped; the exact pass still runs,
    // so a genuinely present long quotation is still verified and an absent
    // one errs toward not_found rather than a false verified.
    const long = Array(600).fill("word").join(" ");
    expect(verifyQuote(long, `prefix ${long} suffix`).status).toBe("verified");
    expect(verifyQuote(long, "nothing like it here").status).toBe("not_found");
  });
});

describe("verifyQuote — offsets and edge cases", () => {
  it("returns not_found for an empty quote rather than matching everything", () => {
    expect(verifyQuote("", "any text at all").status).toBe("not_found");
    expect(verifyQuote("   ", "any text at all").status).toBe("not_found");
  });

  it("keeps fuzzy offsets pointing into the original source", () => {
    // The folding rewrites multi-byte characters to single-byte ASCII. Since
    // it maps one character to one character, code-point offsets survive.
    const source = "so it's well‐known now";
    const { status, start, end } = verifyQuote("it’s well-known", source);
    expect(status).toBe("fuzzy");
    expect(Array.from(source).slice(start, end).join("")).toBe("it's well‐known");
  });
});
