/**
 * Envelope round-trip + validation tests.
 *
 * Goodhart-resistant: every assertion checks an actual returned value,
 * never a mock call count. If the implementation is mutated, these tests
 * fail by virtue of producing wrong values — not by virtue of skipped calls.
 */

import { describe, it, expect } from "vitest";
import {
  HAPPI_VERSION,
  decode,
  encode,
  isEnvelope,
  makeEnvelope,
  type Envelope,
} from "../src/envelope.js";

describe("envelope", () => {
  it("HAPPI_VERSION is exactly 'happi/1.0'", () => {
    expect(HAPPI_VERSION).toBe("happi/1.0");
  });

  it("encode produces compact JSON without spaces", () => {
    const env: Envelope = { v: HAPPI_VERSION, id: "r1", cmd: "version" };
    const wire = encode(env);
    expect(wire).toBe('{"v":"happi/1.0","id":"r1","cmd":"version"}');
  });

  it("encode preserves args, flags, auth verbatim", () => {
    const env: Envelope = {
      v: HAPPI_VERSION,
      id: "r2",
      cmd: "echo",
      args: ["a", "b", 1, true, null],
      flags: { stream: true, max_tokens: 4096 },
      auth: { scheme: "apikey", token: "env:K" },
    };
    const wire = encode(env);
    const parsed = JSON.parse(wire);
    expect(parsed).toEqual(env);
  });

  it("decode rejects non-objects", () => {
    expect(decode(null)).toEqual({ error: "envelope must be a JSON object" });
    expect(decode([])).toEqual({ error: "envelope must be a JSON object" });
    expect(decode("string")).toEqual({ error: "envelope must be a JSON object" });
    expect(decode(42)).toEqual({ error: "envelope must be a JSON object" });
  });

  it("decode rejects wrong version", () => {
    const result = decode({ v: "happi/0.9", id: "r1", cmd: "version" });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/unsupported version/);
    }
  });

  it("decode rejects missing id", () => {
    const result = decode({ v: HAPPI_VERSION, cmd: "version" });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/missing or invalid 'id'/);
    }
  });

  it("decode rejects empty id", () => {
    const result = decode({ v: HAPPI_VERSION, id: "", cmd: "version" });
    expect("error" in result).toBe(true);
  });

  it("decode rejects missing cmd", () => {
    const result = decode({ v: HAPPI_VERSION, id: "r1" });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/missing or invalid 'cmd'/);
    }
  });

  it("decode passes valid envelope through", () => {
    const result = decode({ v: HAPPI_VERSION, id: "r1", cmd: "version" });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.v).toBe(HAPPI_VERSION);
      expect(result.id).toBe("r1");
      expect(result.cmd).toBe("version");
    }
  });

  it("decode forwards unknown fields unchanged (axiom: forward-compat)", () => {
    const result = decode({
      v: HAPPI_VERSION,
      id: "r1",
      cmd: "version",
      future_field: { nested: 42 },
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.future_field).toEqual({ nested: 42 });
    }
  });

  it("isEnvelope is a true type guard", () => {
    expect(isEnvelope({ v: HAPPI_VERSION, id: "r1", cmd: "x" })).toBe(true);
    expect(isEnvelope({ v: "wrong", id: "r1", cmd: "x" })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });

  it("makeEnvelope auto-fills v field", () => {
    const env = makeEnvelope({ id: "r1", cmd: "version" });
    expect(env.v).toBe(HAPPI_VERSION);
    expect(env.id).toBe("r1");
  });

  it("round-trips 10 different envelopes byte-stable", () => {
    const samples: Envelope[] = [
      makeEnvelope({ id: "1", cmd: "version" }),
      makeEnvelope({ id: "2", cmd: "echo", args: [] }),
      makeEnvelope({ id: "3", cmd: "echo", args: ["a"] }),
      makeEnvelope({ id: "4", cmd: "echo", args: ["a", "b", "c"] }),
      makeEnvelope({ id: "5", cmd: "spec.describe" }),
      makeEnvelope({ id: "6", cmd: "envelope.validate", flags: {} }),
      makeEnvelope({ id: "7", cmd: "x", flags: { a: 1 } }),
      makeEnvelope({ id: "8", cmd: "x", flags: { a: [1, 2, 3] } }),
      makeEnvelope({ id: "9", cmd: "x", auth: { scheme: "none" } }),
      makeEnvelope({
        id: "10",
        cmd: "anthropic.messages.create",
        args: ["Hello"],
        flags: { provider: "anthropic/claude-opus-4-7", max_tokens: 100 },
        auth: { scheme: "apikey", token: "env:ANTHROPIC_API_KEY" },
      }),
    ];
    for (const env of samples) {
      const wire = encode(env);
      const parsed = JSON.parse(wire);
      const decoded = decode(parsed);
      expect("error" in decoded).toBe(false);
      if (!("error" in decoded)) {
        expect(decoded).toEqual(env);
      }
    }
  });
});
