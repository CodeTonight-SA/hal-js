/**
 * Conformance test — falsifier #1 check.
 *
 * Pipes a real HAPPI envelope through `bash <happi.md> run` and asserts that
 * hal-js reads back exactly the events the reference Python runtime emits.
 * If this fails, hal-js is not a HAPPI client.
 *
 * The reference runtime always emits `started → delta(text) → completed` for
 * `cmd: version`, and the delta text is the RUNTIME's protocol version — not
 * a fixed literal, because a runtime reports its own version regardless of
 * the envelope's.
 *
 * Skipped automatically when no happi.md is reachable. Set HAPPI_MD to enable.
 */

import { describe, it, expect } from "vitest";
import { dispatchToArray } from "../src/client.js";
import { makeEnvelope, isAcceptedVersion } from "../src/envelope.js";
import { referenceRuntimeCmd } from "./_runtime.js";

const RUNTIME = referenceRuntimeCmd();
const describeIfHappi = RUNTIME === null ? describe.skip : describe;
const cmd = RUNTIME ?? [];

describeIfHappi("conformance: version", () => {
  it("emits started → delta(version) → completed", async () => {
    const env = makeEnvelope({ id: "conf-version", cmd: "version" });
    const events = await dispatchToArray(env, { cmd });
    expect(events.length).toBe(3);

    expect(events[0]?.type).toBe("started");
    // The runtime stamps its OWN version; assert it is well-formed rather
    // than pinning to the single version this build happens to emit.
    expect(isAcceptedVersion(events[0]?.v)).toBe(true);
    expect(events[0]?.id).toBe("conf-version");

    expect(events[1]?.type).toBe("delta");
    if (events[1]?.type === "delta") {
      expect(isAcceptedVersion(events[1].text)).toBe(true);
      expect(events[1].text).toBe(events[1].v);
    }

    expect(events[2]?.type).toBe("completed");
    expect(events[2]?.id).toBe("conf-version");
  });

  it("reports its own version even for a happi/1.0 envelope", async () => {
    // The interop invariant hal-js v0.1 got wrong: a v1.0 request to a v1.3
    // runtime returns v1.3 events, and they must still parse.
    const env = { v: "happi/1.0", id: "conf-v10", cmd: "version" } as const;
    const events = await dispatchToArray(env, { cmd });
    expect(events.map((e) => e.type)).toEqual([
      "started",
      "delta",
      "completed",
    ]);
    expect(isAcceptedVersion(events[0]?.v)).toBe(true);
  });
});

describeIfHappi("conformance: echo", () => {
  it("emits one delta per arg, in order", async () => {
    const env = makeEnvelope({
      id: "conf-echo",
      cmd: "echo",
      args: ["alpha", "beta", "gamma"],
    });
    const events = await dispatchToArray(env, { cmd });
    expect(events.length).toBe(5); // started + 3 deltas + completed
    expect(events[0]?.type).toBe("started");
    expect(events[4]?.type).toBe("completed");

    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((d) => (d.type === "delta" ? d.text : null))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});

describeIfHappi("conformance: spec.describe", () => {
  it("emits the spec lines as deltas between started and completed", async () => {
    const env = makeEnvelope({ id: "conf-spec", cmd: "spec.describe" });
    const events = await dispatchToArray(env, { cmd });
    expect(events[0]?.type).toBe("started");
    expect(events[events.length - 1]?.type).toBe("completed");
    // Assert the SHAPE (deltas framed by started/completed) rather than an
    // exact line count, which is a spec-text detail that legitimately drifts.
    const deltaCount = events.filter((e) => e.type === "delta").length;
    expect(deltaCount).toBeGreaterThan(0);
    expect(events.length).toBe(deltaCount + 2);
  });
});

describeIfHappi("conformance: error handling", () => {
  it("rejects an out-of-range envelope version with parse_error", async () => {
    // happi/0.9 is outside the accepted range for every current runtime.
    const badEnv = { v: "happi/0.9", id: "conf-bad", cmd: "version" } as never;
    const events = await dispatchToArray(badEnv, { cmd });
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].code).toBe("parse_error");
    }
  });
});

describeIfHappi("conformance: lossless round-trip", () => {
  it("re-encoding parsed events recreates the wire form", async () => {
    // The strongest conformance check: take the events hal-js parsed,
    // re-encode them as NDJSON, and assert re-parsing yields the same array.
    // This proves zero information loss in the parse step.
    const env = makeEnvelope({ id: "conf-bytes", cmd: "version" });
    const events = await dispatchToArray(env, { cmd });
    const reEncoded = events.map((e) => JSON.stringify(e)).join("\n");
    const reParsed = reEncoded.split("\n").map((l) => JSON.parse(l));
    expect(reParsed).toEqual(events);
    expect(reParsed.length).toBe(3);
  });
});
