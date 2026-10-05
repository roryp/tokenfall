import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { LunaGateway, MAX_REASONING_COMPLETION_TOKENS } from '../server/model.ts';
import { Room } from '../server/room.ts';

const exporter = new InMemorySpanExporter();
// Like Azure Monitor startup: the server modules are already loaded when the global provider is reset and replaced.
trace.disable();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();

function fixture() {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'tokenfall-tracing-'));
  const config = { port: 3100, endpoint: 'https://test.openai.azure.com', deployment: 'test-only', tenantId: 'test', dataDirectory };
  const gateway = new LunaGateway(config);
  return { dataDirectory, gateway, room: new Room(config, gateway) };
}

test('Luna requests export Foundry GenAI spans with provider token usage', async context => {
  exporter.reset();
  const { dataDirectory, gateway, room } = fixture();
  context.mock.method(gateway['client'].chat.completions, 'create', async (request: unknown) => {
    const prompt = JSON.parse(JSON.parse(JSON.stringify(request)).messages[1].content);
    return {
      id: 'chatcmpl-trace', model: 'gpt-5.6-luna-2026-07-09',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ placementId: prompt.placements[0].id, tip: 'Traced.' }) } }],
      usage: { prompt_tokens: 3000, completion_tokens: 90, total_tokens: 3090, prompt_tokens_details: { cached_tokens: 2048, cache_write_tokens: 128 }, completion_tokens_details: { reasoning_tokens: 60 } },
    };
  });
  try {
    room.join('Trace Player', room.code, undefined, 'trace');
    const player = room.playerFor('trace');
    const { insight } = await room.assist(player, { compression: true, cache: true, reasoning: true, mcp: true });
    assert.equal(insight.status, 'ready');
    const spans = exporter.getFinishedSpans();
    const agent = spans.find(span => span.name === 'invoke_agent Luna')!;
    const tool = spans.find(span => span.name === 'execute_tool analyze_future_moves')!;
    const chat = spans.find(span => span.name === 'chat test-only')!;
    assert.equal(spans.length, 3);
    assert.deepEqual([agent.kind, tool.kind, chat.kind], [SpanKind.SERVER, SpanKind.INTERNAL, SpanKind.CLIENT]);
    for (const child of [tool, chat]) {
      assert.equal(child.spanContext().traceId, agent.spanContext().traceId);
      assert.equal(child.parentSpanContext?.spanId, agent.spanContext().spanId);
      assert.equal(child.attributes['gen_ai.agent.name'], 'Luna');
      assert.equal(child.attributes['gen_ai.conversation.id'], player.runId);
    }
    const usage = {
      'gen_ai.usage.input_tokens': 3000, 'gen_ai.usage.output_tokens': 90, 'gen_ai.usage.cache_read.input_tokens': 2048,
      'gen_ai.usage.cache_creation.input_tokens': 128, 'gen_ai.usage.reasoning.output_tokens': 60,
    };
    assert.deepEqual({ input: insight.usage.input, output: insight.usage.output }, { input: 3000, output: 90 });
    for (const span of [agent, chat]) for (const [key, value] of Object.entries(usage)) assert.equal(span.attributes[key], value, `${span.name} ${key}`);
    assert.equal(agent.attributes['gen_ai.operation.name'], 'invoke_agent');
    assert.equal(agent.attributes['gen_ai.agent.id'], 'tokenfall-luna');
    assert.equal(agent.attributes['tokenfall.move.status'], 'ready');
    assert.equal(agent.attributes['tokenfall.ai.mcp'], true);
    assert.equal(agent.attributes['tokenfall.mcp.added_input_tokens'], insight.mcpLookup!.addedInputTokens);
    assert.equal(tool.attributes['gen_ai.tool.name'], 'analyze_future_moves');
    assert.equal(tool.attributes['tokenfall.mcp.result_tokens'], insight.mcpLookup!.resultTokens);
    assert.equal(chat.attributes['gen_ai.operation.name'], 'chat');
    assert.equal(chat.attributes['gen_ai.provider.name'], 'azure.ai.openai');
    assert.equal(chat.attributes['gen_ai.request.max_tokens'], MAX_REASONING_COMPLETION_TOKENS);
    assert.equal(chat.attributes['gen_ai.response.id'], 'chatcmpl-trace');
    assert.equal(chat.attributes['gen_ai.response.model'], 'gpt-5.6-luna-2026-07-09');
    assert.deepEqual(chat.attributes['gen_ai.response.finish_reasons'], ['stop']);
    assert.equal(chat.attributes['server.address'], 'test.openai.azure.com');
    assert.equal(chat.attributes['server.port'], 443);
  } finally {
    room.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('Failed Luna requests mark the agent and chat spans with the provider error', async context => {
  exporter.reset();
  const { dataDirectory, gateway, room } = fixture();
  context.mock.method(gateway['client'].chat.completions, 'create', async () => { throw Object.assign(new Error('Rate limit reached.'), { status: 429 }); });
  try {
    room.join('Trace Failure', room.code, undefined, 'failure');
    await assert.rejects(room.assist(room.playerFor('failure'), { compression: true, cache: false }), /Rate limit/);
    const spans = exporter.getFinishedSpans();
    assert.deepEqual(spans.map(span => span.name).sort(), ['chat test-only', 'invoke_agent Luna']);
    for (const span of spans) {
      assert.equal(span.status.code, SpanStatusCode.ERROR);
      assert.equal(span.attributes['error.type'], '429');
      assert.equal(span.attributes['gen_ai.usage.input_tokens'], undefined);
      assert.ok(span.events.some(event => event.name === 'exception'));
    }
  } finally {
    room.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
