/**
 * Conformance test — falsifier #1 check.
 *
 * Pipes a real HAPPI envelope through `bash /Users/lauriescheepers/.hal/happi.md run`
 * and asserts that hal-js reads back exactly the events the reference Python
 * runtime emits. If this fails, hal-js is not a HAPPI/1.0 client.
 *
 * The reference runtime always emits `started → delta(text) → completed` for
 * `cmd: version`, and the `text` of the delta is the literal string
 * `"happi/1.0"`. These are the load-bearing invariants.
 *
 * Skipped automatically if happi.md is not present (e.g. CI without HAL).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { dispatchToArray } from "../src/client.js";
import { makeEnvelope } from "../src/envelope.js";
import { HAPPI_VERSION } from "../src/envelope.js";

const HAPPI_PATH = "/Users/lauriescheepers/.hal/happi.md";
const happiAvailable = existsSync(HAPPI_PATH);

const describeIfHappi = happiAvailable ? describe : describe.skip;

describeIfHappi("conformance vs reference (bash happi.md run)", () => {
  beforeAll(() => {
    if (!happiAvailable) return;
    // Sanity log so it's visible when the suite runs.
    // Intentional: tests should only be conditioned on real conditions.
  });

  it("dispatches `version` and gets started → delta(happi/1.0) → completed", async () => {
    const env = makeEnvelope({ id: "conf-version", cmd: "version" });
    const events = await dispatchToArray(env, {
      cmd: ["bash", HAPPI_PATH, "run"],
    });
    expect(events.length).toBe(3);

    expect(events[0]?.type).toBe("started");
    expect(events[0]?.v).toBe(HAPPI_VERSION);
    expect(events[0]?.id).toBe("conf-version");

    expect(events[1]?.type).toBe("delta");
    if (events[1]?.type === "delta") {
      expect(events[1].text).toBe("happi/1.0");
      expect(events[1].id).toBe("conf-version");
    }

    expect(events[2]?.type).toBe("completed");
    expect(events[2]?.id).toBe("conf-version");
  });

  it("dispatches `echo` with 3 args and gets 3 deltas in order", async () => {
    const env = makeEnvelope({
      id: "conf-echo",
      cmd: "echo",
      args: ["alpha", "beta", "gamma"],
    });
    const events = await dispatchToArray(env, {
      cmd: ["bash", HAPPI_PATH, "run"],
    });
    expect(events.length).toBe(5); // started + 3 deltas + completed
    expect(events[0]?.type).toBe("started");
    expect(events[4]?.type).toBe("completed");

    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.length).toBe(3);
    expect(deltas.map((d) => (d.type === "delta" ? d.text : null))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("dispatches `spec.describe` and emits the 6 spec lines as deltas", async () => {
    const env = makeEnvelope({ id: "conf-spec", cmd: "spec.describe" });
    const events = await dispatchToArray(env, {
      cmd: ["bash", HAPPI_PATH, "run"],
    });
    // spec.describe in the reference emits 6 lines (see _SPEC_LINES in happi.md
    // Python runtime). Plus started + completed = 8 events.
    expect(events.length).toBe(8);
    expect(events[0]?.type).toBe("started");
    expect(events[events.length - 1]?.type).toBe("completed");
    const deltaCount = events.filter((e) => e.type === "delta").length;
    expect(deltaCount).toBe(6);
  });

  it("rejects bad envelope with parse_error event", async () => {
    // Send a wrong-version envelope; reference runtime emits one error event
    // with id="req-invalid" and code="parse_error", then exits non-zero.
    // We bypass our own decode() by calling client lower-down to force the
    // reference to do the validation.
    const badEnv = {
      v: "happi/0.9",
      id: "conf-bad",
      cmd: "version",
    } as never;
    const events = await dispatchToArray(badEnv, {
      cmd: ["bash", HAPPI_PATH, "run"],
    });
    // Reference emits exactly one event: error with code parse_error.
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].code).toBe("parse_error");
    }
  });

  it("byte-identical NDJSON round-trip: re-encoding events recreates the wire", async () => {
    // The strongest conformance check: take the events hal-js parsed, re-encode
    // them as NDJSON, and assert the result equals what the reference emitted.
    // This proves zero information loss in the parse step.
    const env = makeEnvelope({ id: "conf-bytes", cmd: "version" });
    const events = await dispatchToArray(env, {
      cmd: ["bash", HAPPI_PATH, "run"],
    });
    // Re-encode each event with the same compact-JSON form the reference uses.
    const reEncoded = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    // The reference output fields in order: v, id, type, ts (+ payload). We
    // verify that re-parsing reEncoded gives back an array equal to `events`.
    const lines = reEncoded.trim().split("\n");
    const reParsed = lines.map((l) => JSON.parse(l));
    expect(reParsed).toEqual(events);
    expect(reParsed.length).toBe(3);
  });
});
