// The two chat endpoints, POST /v1/chat/completions (OpenAI format) and POST /v1/messages (Anthropic
// format). Both run the shared flow in ./forward.ts with their own protocol, and both know the other one:
// a request routed to a provider of the other format is sent and read with that format's protocol.

import type { RouteContext } from '../server/router.ts';
import { ANTHROPIC_PROTOCOL } from './anthropic.ts';
import { forwardRequest, type ProxyProtocols } from './forward.ts';
import { OPENAI_PROTOCOL } from './openai.ts';

const PROTOCOLS: ProxyProtocols = { openai: OPENAI_PROTOCOL, anthropic: ANTHROPIC_PROTOCOL };

/** Handles POST /v1/chat/completions. */
export function handleChatCompletions(context: RouteContext): Promise<void> {
  return forwardRequest(context, OPENAI_PROTOCOL, PROTOCOLS);
}

/** Handles POST /v1/messages. */
export function handleMessages(context: RouteContext): Promise<void> {
  return forwardRequest(context, ANTHROPIC_PROTOCOL, PROTOCOLS);
}
