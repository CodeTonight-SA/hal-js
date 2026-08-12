# hal-js

HAPPI/1.3 client library for JavaScript and TypeScript. Zero-dependency core. Runs natively under Node 20+, Deno, and Bun.

> **AI is a syscall.** Every call to a model is an envelope through stdin and a stream of canonical events back through stdout. `hal-js` is the JS idiom that talks to any HAPPI runtime — the canonical bash one, the Python reference, or any future implementation — without locking you to a specific provider, transport, or runtime.

## Why HAPPI

A HAPPI request is a single JSON envelope:

```json
{"v":"happi/1.3","id":"r1","cmd":"version"}
```

A HAPPI response is a sequence of NDJSON events drawn from seven streaming types:
`started`, `delta`, `tool_call`, `tool_result`, `sub_request`, `completed`, `error` —
plus two non-streaming records added in v1.1, `idr` and `context`, which follow
the outcome event.

Whatever the model does, it does so through this contract. Provider lock-in becomes a deployment concern, not an architecture one.

## Protocol versions

`hal-js` **emits** `happi/1.3` and **accepts any** `happi/1.x` (any minor, same
major).

A runtime always stamps events with *its own* version, never the envelope's. So a
`happi/1.0` request sent to a `happi/1.3` runtime comes back as `happi/1.3`
events — meaning a client that checks for exact version equality can only ever
talk to one runtime build. HAPPI's compatibility promise is per MAJOR version —
within v1, changes are additive — so acceptance is a major-version rule, not a
hardcoded list: a hardcoded list only defers the same bug to the day a runtime
ships `happi/1.4`. A different major (`happi/0.9`, `happi/2.0`) is still
rejected, as is a malformed version string.

Reference: the canonical polyglot runtime, published at
<https://gist.github.com/LaurieScheepers/2483d5c218c21ecc931130bcee7dee83>.

## Citation provenance (v1.3)

`cite.verify` checks that every cited quote is verbatim-present in its source. The
check is a deterministic string match, so a fabricated quote can never earn
`verified` — it resolves to `not_found`.

```ts
import { makeCiteVerify, decodeProvenance, notFound } from "hal-js/cite";
import { dispatchToArray } from "hal-js/client";

const env = makeCiteVerify({
  id: "cv-1",
  sources: [{ id: "s1", text: "The Act bars the claim after six years." }],
  citations: [
    { id: "c1", source_id: "s1", quote: "bars the claim after six years" },   // real
    { id: "c2", source_id: "s1", quote: "bars the claim after three years" }, // invented
  ],
});

const events = await dispatchToArray(env, { cmd: ["bash", "happi.md", "run"] });
const record = decodeProvenance(events.find((e) => e.type === "completed")?.usage);

console.log(record?.grounding_rate);            // 0.5
console.log(notFound(record!).map((c) => c.id)); // ['c2']
```

Pass `strict: true` to make the runtime exit non-zero on any unverified citation —
a build gate. Note what this proves: the quote really is in the *supplied* source.
It does **not** prove the source is authentic, nor that the quote supports the claim.

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

The `tests/conformance.test.ts` suite spawns a real bash runtime and verifies
byte-identical event streams. It resolves the runtime from `$HAPPI_MD`, then
`~/.hal/happi.md`, and auto-skips when none is reachable. Fetch the published
reference to run conformance anywhere:

```bash
curl -fsSL "https://gist.githubusercontent.com/LaurieScheepers/2483d5c218c21ecc931130bcee7dee83/raw/happi.md" -o /tmp/happi.md
HAPPI_MD=/tmp/happi.md npm test
```

## Versioning

`v0.2.x` tracks `happi/1.3`; the JS API surface may evolve until `v1.0.0`.
Forward compatibility on the wire is unconditional — unknown envelope and event
fields are forwarded unchanged.

## Licence

AGPL-3.0-only. See `LICENSE`.

Copyright (C) 2024-2026 Lourens Cornelius Scheepers / CodeTonight (Pty) Ltd

Under the AGPL, running a modified version of this software as a network
service counts as distribution: users interacting with it over a network are
entitled to the corresponding source.

**Commercial licences.** If the AGPL's network-use obligation does not fit your
deployment, a commercial licence is available — contact licensing@codetonight.co.za.
