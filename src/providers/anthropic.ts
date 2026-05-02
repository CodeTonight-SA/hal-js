/**
 * Anthropic provider adapter — pure-translation layer.
 *
 * Maps a HAPPI envelope (cmd: "anthropic.messages.create") to the
 * `@anthropic-ai/sdk` Messages API and back into the seven canonical
 * HAPPI events. This is the SAME shape every adapter in any language
 * implements: input = envelope, output = HappiEvent[].
 *
 * No network is performed by this module unless the caller passes a real
 * SDK client. The adapter is a thin pure function; testability via the
 * "mock the wire, not the SDK" pattern (§8.2 of the possibilities paper).
 *
 * Peer dependency: `@anthropic-ai/sdk` ^0.30. Importing this module without
 * the SDK installed will fail at the first `client.messages.create` call,
 * not at module load — the type import is structural only.
 */

import { HAPPI_VERSION } from "../envelope.js";
import type { Envelope } from "../envelope.js";
import type { HappiEvent, DeltaEvent, StartedEvent, CompletedEvent, ErrorEvent } from "../events.js";

/**
 * Minimal duck-type for the Anthropic SDK client. Avoids a hard import-time
 * dependency; any object with this shape will work, including mocks.
 */
export interface AnthropicLike {
  readonly messages: {
    create(params: {
      model: string;
      max_tokens: number;
      messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
      stream?: boolean;
    }): AsyncIterable<{
      type: string;
      delta?: { type?: string; text?: string };
      message?: { usage?: Record<string, unknown> };
    }>;
  };
}

/**
 * Adapt one HAPPI envelope to a stream of typed events using the supplied
 * Anthropic client. Returns an async generator yielding events in the
 * same order the reference runtime would emit them: started → delta* → completed
 * (or error on failure).
 */
export async function* adapt(
  envelope: Envelope,
  client: AnthropicLike,
): AsyncGenerator<HappiEvent, void, void> {
  const id = envelope.id;
  const ts = (): number => 0; // adapter-side timestamps; matches reference semantics
  const started: StartedEvent = { v: HAPPI_VERSION, id, type: "started", ts: ts() };
  yield started;

  try {
    const params = buildParams(envelope);
    const stream = client.messages.create({ ...params, stream: true });
    let usage: Record<string, unknown> | undefined;
    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta?.text !== undefined) {
        const delta: DeltaEvent = {
          v: HAPPI_VERSION,
          id,
          type: "delta",
          ts: ts(),
          text: chunk.delta.text,
        };
        yield delta;
      }
      if (chunk.type === "message_delta" && chunk.message?.usage !== undefined) {
        usage = chunk.message.usage;
      }
    }
    const completed: CompletedEvent = {
      v: HAPPI_VERSION,
      id,
      type: "completed",
      ts: ts(),
      ...(usage !== undefined ? { usage } : {}),
    };
    yield completed;
  } catch (err) {
    const error: ErrorEvent = {
      v: HAPPI_VERSION,
      id,
      type: "error",
      ts: ts(),
      code: "runtime_error",
      message: err instanceof Error ? err.message : String(err),
    };
    yield error;
  }
}

interface MessagesParams {
  model: string;
  max_tokens: number;
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
}

function buildParams(envelope: Envelope): MessagesParams {
  const flags = (envelope.flags ?? {}) as Record<string, unknown>;
  const provider = typeof flags.provider === "string" ? flags.provider : "anthropic/claude-3-5-sonnet-latest";
  const model = provider.includes("/") ? provider.split("/")[1]! : provider;
  const maxTokens = typeof flags.max_tokens === "number" ? flags.max_tokens : 4096;
  const args = (envelope.args ?? []) as ReadonlyArray<unknown>;
  const userText = args.map(String).join("\n");
  return {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: userText }],
  };
}
