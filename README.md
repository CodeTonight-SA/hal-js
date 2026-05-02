# hal-js

HAPPI/1.0 client library for JavaScript and TypeScript. Zero-dependency core. Runs natively under Node 20+, Deno, and Bun.

> **AI is a syscall.** Every call to a model is an envelope through stdin and a stream of seven canonical events back through stdout. `hal-js` is the JS idiom that talks to any HAPPI/1.0 runtime — the canonical bash one, the Python reference, or any future implementation — without locking you to a specific provider, transport, or runtime.

## Why HAPPI

A HAPPI request is a single JSON envelope:

```json
{"v":"happi/1.0","id":"r1","cmd":"version"}
```

A HAPPI response is a sequence of NDJSON events drawn from exactly seven types:
`started`, `delta`, `tool_call`, `tool_result`, `sub_request`, `completed`, `error`.

Whatever the model does, it does so through this contract. Provider lock-in becomes a deployment concern, not an architecture one.

Reference: `~/.hal/happi.md` (the canonical, polyglot, self-hosting runtime).

## Install

```bash
npm install hal-js
# optional, only if you want the Anthropic provider adapter
npm install @anthropic-ai/sdk
```

## Quickstart — talk to the canonical runtime

```ts
import { makeEnvelope } from "hal-js/envelope";
import { dispatch } from "hal-js/client";

const env = makeEnvelope({ id: "r1", cmd: "version" });
const events = await dispatch(env, {
  cmd: ["bash", "/Users/you/.hal/happi.md", "run"],
});

for await (const event of events) {
  if (event.type === "delta") process.stdout.write(event.text);
  if (event.type === "completed") break;
}
```

That is the whole API. Spawn a HAPPI runtime, write one envelope, read events back.

## Quickstart — Anthropic adapter

```ts
import Anthropic from "@anthropic-ai/sdk";
import { makeEnvelope } from "hal-js/envelope";
import { adapt } from "hal-js/providers/anthropic";

const client = new Anthropic();
const env = makeEnvelope({
  id: "r2",
  cmd: "anthropic.messages.create",
  args: ["Write a haiku about syscalls."],
  flags: { provider: "anthropic/claude-sonnet-4-5", max_tokens: 256 },
});

for await (const event of adapt(env, client)) {
  if (event.type === "delta") process.stdout.write(event.text);
}
```

The adapter does not perform a network call until you pass a real client. Pass a mock conforming to `AnthropicLike` to test offline.

## Cross-runtime support

`spawn()` detects Bun, Deno, and Node at import time and uses each runtime's native child-process API. The hot path (NDJSON streaming through `ReadableStream<Uint8Array>`) is identical across all three.

| Runtime | Status      | Notes                                |
| ------- | ----------- | ------------------------------------ |
| Node 20+| Supported   | Uses `node:child_process` + `Readable.toWeb` |
| Deno    | Supported   | Uses `Deno.Command` with piped stdio |
| Bun     | Supported   | Uses `Bun.spawn`                     |

There are no Node-specific APIs in the core. The only Node import is gated behind `detectRuntime() === "node"` in `runtime.ts`.

## Modules

- `hal-js/envelope` — `Envelope` type, `decode`, `encode`, `makeEnvelope`, `isEnvelope`
- `hal-js/events` — seven event types, `parseEvents` (NDJSON → typed async iterator)
- `hal-js/client` — `dispatch`, `dispatchToArray` (the syscall)
- `hal-js/providers/anthropic` — Anthropic SDK adapter (peer dep, optional)

## Test

```bash
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

The `tests/conformance.test.ts` suite spawns the canonical bash runtime at `~/.hal/happi.md` and verifies byte-identical event streams. It auto-skips if the runtime is not present (e.g. CI without HAL).

## Versioning

`v0.1.x` is the initial release. The protocol is stable at `happi/1.0`; the JS API surface may evolve until `v1.0.0`. Forward compatibility on the wire is unconditional — unknown envelope and event fields are forwarded unchanged.

## Licence

MIT. See `LICENSE`.
