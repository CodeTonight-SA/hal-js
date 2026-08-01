/**
 * Events parser tests — covers the 7 streaming types, the 2 v1.1 record
 * terminators, and NDJSON streaming.
 *
 * Goodhart-resistant: assertions check actual event values yielded by the
 * iterator, not parser call counts. A mutation that swaps `started` for
 * `completed` would still pass any "did the parser run?" check; here it
 * fails because we assert `events[0].type === "started"`.
 */

import { describe, it, expect } from "vitest";
import {
  decodeEvent,
  parseEvents,
  EVENT_TYPES,
  type HappiEvent,
} from "../src/events.js";
import { HAPPI_VERSION } from "../src/envelope.js";

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<HappiEvent[]> {
  const out: HappiEvent[] = [];
  for await (const event of parseEvents(stream)) out.push(event);
  return out;
}

describe("events / type registry", () => {
  it("recognises 7 streaming types plus the 2 v1.1 terminators", () => {
    // idr + context are non-streaming records emitted after the outcome.
    const required = [
      "started", "delta", "tool_call", "tool_result", "sub_request",
      "completed", "error", "idr", "context",
    ];
    expect([...EVENT_TYPES].sort()).toEqual(required.sort());
  });
});

describe("events / decodeEvent: simple events", () => {
  it("parses started", () => {
    const out = decodeEvent({ v: HAPPI_VERSION, id: "r1", type: "started", ts: 0 });
    expect(out?.type).toBe("started");
    expect(out?.id).toBe("r1");
  });

  it("parses delta with text", () => {
    const out = decodeEvent({
      v: HAPPI_VERSION,
      id: "r1",
      type: "delta",
      ts: 1,
      text: "hello",
    });
    expect(out?.type).toBe("delta");
    if (out?.type === "delta") expect(out.text).toBe("hello");
  });
});

describe("events / decodeEvent: tool events", () => {
  it("parses tool_call", () => {
    const out = decodeEvent({
      v: HAPPI_VERSION,
      id: "r1",
      type: "tool_call",
      ts: 2,
      name: "search",
      input: { q: "test" },
      call_id: "c1",
    });
    expect(out?.type).toBe("tool_call");
    if (out?.type === "tool_call") {
      expect(out.name).toBe("search");
      expect(out.call_id).toBe("c1");
    }
  });

  it("parses tool_result", () => {
    const out = decodeEvent({
      v: HAPPI_VERSION,
      id: "r1",
      type: "tool_result",
      ts: 3,
      name: "search",
      output: ["result-1"],
      call_id: "c1",
    });
    expect(out?.type).toBe("tool_result");
  });
});

describe("events / decodeEvent: sub_request and completed", () => {
  it("parses sub_request with embedded envelope", () => {
    const out = decodeEvent({
      v: HAPPI_VERSION,
      id: "r1",
      type: "sub_request",
      ts: 4,
      envelope: { v: HAPPI_VERSION, id: "sub-1", cmd: "version" },
    });
    expect(out?.type).toBe("sub_request");
    if (out?.type === "sub_request") {
      expect(out.envelope.id).toBe("sub-1");
    }
  });

  it("parses completed with usage", () => {
    const out = decodeEvent({
      v: HAPPI_VERSION,
      id: "r1",
      type: "completed",
      ts: 5,
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(out?.type).toBe("completed");
    if (out?.type === "completed") {
      expect(out.usage?.input_tokens).toBe(10);
    }
  });
});

describe("events / decodeEvent: error", () => {
  it("parses error with code+message", () => {
    const out = decodeEvent({
      v: HAPPI_VERSION,
      id: "r1",
      type: "error",
      ts: 6,
      code: "parse_error",
      message: "bad json",
    });
    expect(out?.type).toBe("error");
    if (out?.type === "error") {
      expect(out.code).toBe("parse_error");
      expect(out.message).toBe("bad json");
    }
  });
});

describe("events / decodeEvent: rejection", () => {
  it("rejects an out-of-range version", () => {
    // happi/0.9 sits below the accepted range, so it must still be refused.
    const out = decodeEvent({ v: "happi/0.9", id: "r1", type: "started", ts: 0 });
    expect(out).toBeNull();
  });

  it("rejects unknown type", () => {
    const out = decodeEvent({ v: HAPPI_VERSION, id: "r1", type: "unknown", ts: 0 });
    expect(out).toBeNull();
  });

  it("rejects non-finite ts", () => {
    const out = decodeEvent({ v: HAPPI_VERSION, id: "r1", type: "started", ts: NaN });
    expect(out).toBeNull();
  });
});

describe("events / parseEvents: basic streaming", () => {
  it("parses a 3-line NDJSON stream into 3 typed events", async () => {
    const ndjson =
      `{"v":"happi/1.0","id":"r1","type":"started","ts":0}\n` +
      `{"v":"happi/1.0","id":"r1","type":"delta","ts":1,"text":"hi"}\n` +
      `{"v":"happi/1.0","id":"r1","type":"completed","ts":2}\n`;
    const events = await collect(streamFromString(ndjson));
    expect(events.length).toBe(3);
    expect(events.map((e) => e.type)).toEqual(["started", "delta", "completed"]);
    if (events[1]?.type === "delta") expect(events[1].text).toBe("hi");
  });
});

describe("events / parseEvents: resilience", () => {
  it("ignores blank lines", async () => {
    const ndjson =
      `{"v":"happi/1.0","id":"r1","type":"started","ts":0}\n` +
      `\n\n` +
      `{"v":"happi/1.0","id":"r1","type":"completed","ts":1}\n`;
    expect((await collect(streamFromString(ndjson))).length).toBe(2);
  });

  it("handles a final line without trailing newline", async () => {
    const ndjson =
      `{"v":"happi/1.0","id":"r1","type":"started","ts":0}\n` +
      `{"v":"happi/1.0","id":"r1","type":"completed","ts":1}`;
    expect((await collect(streamFromString(ndjson))).length).toBe(2);
  });

  it("ignores malformed JSON instead of throwing", async () => {
    const ndjson =
      `{"v":"happi/1.0","id":"r1","type":"started","ts":0}\n` +
      `not-json\n` +
      `{"v":"happi/1.0","id":"r1","type":"completed","ts":1}\n`;
    const events = await collect(streamFromString(ndjson));
    expect(events.map((e) => e.type)).toEqual(["started", "completed"]);
  });
});

describe("events / parseEvents: chunked reassembly", () => {
  it("preserves event ordering across chunked stream", async () => {
    // Simulate a stream that arrives in arbitrary chunks, including
    // chunks that split a JSON line in half. Parser must reassemble.
    const lines = [
      `{"v":"happi/1.0","id":"r1","type":"started","ts":0}`,
      `{"v":"happi/1.0","id":"r1","type":"delta","ts":1,"text":"a"}`,
      `{"v":"happi/1.0","id":"r1","type":"delta","ts":2,"text":"b"}`,
      `{"v":"happi/1.0","id":"r1","type":"completed","ts":3}`,
    ];
    const wire = lines.join("\n") + "\n";
    // Split into 7-byte chunks to force mid-line reassembly.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(wire);
        for (let i = 0; i < bytes.length; i += 7) {
          controller.enqueue(bytes.slice(i, i + 7));
        }
        controller.close();
      },
    });
    const events = await collect(stream);
    expect(events.map((e) => e.type)).toEqual([
      "started", "delta", "delta", "completed",
    ]);
  });
});
