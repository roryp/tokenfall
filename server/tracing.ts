import { context, createContextKey, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes, Span } from '@opentelemetry/api';
import type { AiOptions, Insight, Usage } from '../shared/protocol.ts';

// Attribute names follow the OpenTelemetry GenAI semantic conventions that Foundry reads from Application Insights.
export const LUNA_AGENT = { name: 'Luna', id: 'tokenfall-luna' } as const;
const PROVIDER = 'azure.ai.openai';
// Resolved per span: Azure Monitor resets the global provider on startup, orphaning tracers created at import time.
const tracer = () => trace.getTracer('tokenfall');
// Child spans repeat the agent and conversation so Foundry can correlate them without reading the parent span.
const agentAttributes = createContextKey('tokenfall.gen_ai.agent');

export const usageAttributes = (usage: Usage): Attributes => ({
  'gen_ai.usage.input_tokens': usage.input,
  'gen_ai.usage.output_tokens': usage.output,
  'gen_ai.usage.cache_read.input_tokens': usage.cached,
  'gen_ai.usage.cache_creation.input_tokens': usage.cacheWrites,
  ...(usage.reasoning === null ? {} : { 'gen_ai.usage.reasoning.output_tokens': usage.reasoning }),
});

function errorType(error: unknown) {
  const details = error as { code?: unknown; reason?: unknown; status?: unknown } | null | undefined;
  for (const value of [details?.code, details?.reason, details?.status]) if (typeof value === 'string' || typeof value === 'number') return String(value);
  return error instanceof Error ? error.name : '_OTHER';
}

function inSpan<T>(name: string, kind: SpanKind, attributes: Attributes, run: (span: Span) => Promise<T>): Promise<T> {
  const inherited = context.active().getValue(agentAttributes) as Attributes | undefined;
  return tracer().startActiveSpan(name, { kind, attributes: { ...inherited, ...attributes } }, async span => {
    try { return await run(span); }
    catch (error) {
      span.setAttribute('error.type', errorType(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : undefined });
      if (error instanceof Error) span.recordException(error);
      throw error;
    } finally { span.end(); }
  });
}

export function traceLunaRequest<T>(conversationId: string, model: string, options: AiOptions, reservation: number, run: (span: Span) => Promise<T>) {
  const agent = { 'gen_ai.agent.name': LUNA_AGENT.name, 'gen_ai.agent.id': LUNA_AGENT.id, 'gen_ai.conversation.id': conversationId };
  // INTERNAL (an in-process agent, per the GenAI conventions) lands in the dependencies table that the Application Insights agent views read.
  return context.with(context.active().setValue(agentAttributes, agent), () => inSpan(`invoke_agent ${LUNA_AGENT.name}`, SpanKind.INTERNAL, {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.provider.name': PROVIDER,
    'gen_ai.request.model': model,
    'tokenfall.ai.cache': options.cache,
    'tokenfall.ai.compression': options.compression,
    'tokenfall.ai.reasoning': Boolean(options.reasoning),
    'tokenfall.ai.mcp': Boolean(options.mcp),
    'tokenfall.ai.autopilot': Boolean(options.autopilot),
    'tokenfall.tokens.reserved': reservation,
  }, run));
}

export function recordLunaResult(span: Span, insight: Insight) {
  span.setAttributes({
    ...usageAttributes(insight.usage),
    'tokenfall.move.status': insight.status,
    'tokenfall.tokens.compression_saved': insight.savedTokens,
    ...(insight.mcpLookup?.addedInputTokens === undefined ? {} : { 'tokenfall.mcp.added_input_tokens': insight.mcpLookup.addedInputTokens }),
  });
}

export function traceTool<T>(name: string, run: (span: Span) => Promise<T>) {
  return inSpan(`execute_tool ${name}`, SpanKind.INTERNAL, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name, 'gen_ai.tool.type': 'extension' }, run);
}

export function traceChat<T>(model: string, maxTokens: number, baseUrl: string, run: (span: Span) => Promise<T>) {
  const server = new URL(baseUrl);
  return inSpan(`chat ${model}`, SpanKind.CLIENT, {
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': PROVIDER,
    'gen_ai.request.model': model,
    'gen_ai.request.max_tokens': maxTokens,
    'gen_ai.output.type': 'json',
    'server.address': server.hostname,
    'server.port': Number(server.port) || (server.protocol === 'http:' ? 80 : 443),
  }, run);
}

export function recordChatResponse(span: Span, response: { id?: string; model?: string; choices?: { finish_reason?: string | null }[] }, usage: Usage) {
  span.setAttributes({
    ...(response.id ? { 'gen_ai.response.id': response.id } : {}),
    ...(response.model ? { 'gen_ai.response.model': response.model } : {}),
    'gen_ai.response.finish_reasons': (response.choices ?? []).flatMap(choice => choice.finish_reason ? [choice.finish_reason] : []),
    ...usageAttributes(usage),
  });
}
