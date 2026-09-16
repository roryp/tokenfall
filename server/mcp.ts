import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { z } from 'zod';
import type { Game } from '../shared/game.ts';
import { MCP_LOOKUP_TIMEOUT_MS } from '../shared/protocol.ts';
import type { McpContinuation, McpLookaheadInput, McpLookup } from '../shared/protocol.ts';
import { boardFactsSchema, boardInputSchema, lookaheadInputSchema, lookaheadOutputSchema, MCP_LOOKAHEAD_TOOL_NAME, MCP_SERVER_NAME, MCP_TOOL_NAME } from './mcp-server.ts';
import { countTokens, packBoard } from './tokens.ts';

export { MCP_LOOKUP_TIMEOUT_MS } from '../shared/protocol.ts';
export const MAX_MCP_CONTEXT_TOKENS = 2304;

type McpFailure = 'connection' | 'timeout' | 'tool' | 'response' | 'snapshot' | 'context';

export class McpLookupError extends Error {
  reason: McpFailure;
  constructor(reason: McpFailure = 'tool', cause?: unknown) {
    const details = {
      connection: 'The tool process could not connect.',
      timeout: 'The tool exceeded its 15-second deadline.',
      tool: 'The tool could not complete the analysis.',
      response: 'The tool returned an invalid response.',
      snapshot: 'The tool response did not match the current board.',
      context: 'The complete analysis cannot fit the MCP context allowance. Turn off MCP for this position.',
    };
    super(`MCP lookup failed before contacting Luna. ${details[reason]}`, { cause });
    this.reason = reason;
  }
}

export function lookaheadSnapshot(game: Game): McpLookaheadInput {
  return {
    board: packBoard(game.well.toArray()),
    active: { piece: game.piece, column: game.active.x, row: game.active.y, rotation: game.active.rot ?? 0 },
    hold: game.hold, canHold: !game.usedHold, next: [...game.queue.peek()],
  };
}

export function mcpPromptContext(lookup: Pick<McpLookup, 'server' | 'tool' | 'result'>) {
  const context = { server: lookup.server, tool: lookup.tool, analysis: JSON.parse(lookup.result) };
  const tokens = countTokens(JSON.stringify(context));
  if (lookup.tool !== MCP_LOOKAHEAD_TOOL_NAME || tokens + 256 <= MAX_MCP_CONTEXT_TOKENS) return context;
  const analysis = lookaheadOutputSchema.parse(context.analysis);
  const replies: McpContinuation[] = [];
  const references = new Map<string, number>();
  const reference = (reply: McpContinuation | null) => {
    if (!reply) return null;
    const key = JSON.stringify(reply);
    const existing = references.get(key);
    if (existing !== undefined) return existing;
    const index = replies.length;
    replies.push(reply);
    references.set(key, index);
    return index;
  };
  const packed = { ...context, analysis: { ...analysis, replies, moves: analysis.moves.map(([id, legal, surviving, holes, clears]) => [id, legal, surviving, reference(holes), reference(clears)]) } };
  return countTokens(JSON.stringify(packed)) < tokens ? packed : context;
}

async function callLookup<Result>(tool: string, args: McpLookup['arguments'], schema: z.ZodType<Result>, matchesSnapshot: (result: Result) => boolean): Promise<McpLookup> {
  const client = new Client({ name: 'luna-tetris', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./mcp-server.ts', import.meta.url))], stderr: 'ignore', maxBufferSize: 32768 });
  const request = { timeout: MCP_LOOKUP_TIMEOUT_MS, signal: AbortSignal.timeout(MCP_LOOKUP_TIMEOUT_MS) };
  const started = performance.now();
  let stage = 'connect';
  try {
    await client.connect(transport, request);
    if (client.getServerVersion()?.name !== MCP_SERVER_NAME) throw new McpLookupError('response');
    stage = 'discovery';
    const { tools } = await client.listTools({}, request);
    if (!tools.some(entry => entry.name === tool)) throw new McpLookupError();
    stage = 'call';
    const response = await client.callTool({ name: tool, arguments: { ...args } }, undefined, request);
    if (response.isError) throw new McpLookupError();
    stage = 'validate';
    const validation = schema.safeParse(response.structuredContent);
    if (!validation.success) throw new McpLookupError('response');
    const parsed = validation.data;
    if (!matchesSnapshot(parsed)) throw new McpLookupError('snapshot');
    const result = JSON.stringify(parsed);
    const resultTokens = countTokens(result);
    const lookup: McpLookup = { server: MCP_SERVER_NAME, tool, transport: 'stdio', arguments: args, result, resultTokens, durationMs: Math.round(performance.now() - started) };
    const contextTokens = tool === MCP_LOOKAHEAD_TOOL_NAME ? countTokens(JSON.stringify(mcpPromptContext(lookup))) + 256 : resultTokens + 128;
    if (contextTokens > MAX_MCP_CONTEXT_TOKENS) throw new McpLookupError('context');
    return lookup;
  } catch (error) {
    const failure = error instanceof McpLookupError ? error : new McpLookupError(request.signal.aborted ? 'timeout' : stage === 'connect' ? 'connection' : 'tool', error);
    console.warn('MCP lookup failed', { tool, stage, reason: failure.reason, durationMs: Math.round(performance.now() - started) });
    throw failure;
  }
  finally { await client.close().catch(() => transport.close()); }
}

export async function lookupBoardFacts(board: string[]): Promise<McpLookup> {
  const parsed = boardInputSchema.safeParse({ board });
  if (!parsed.success) throw new McpLookupError();
  return callLookup(MCP_TOOL_NAME, parsed.data, boardFactsSchema, result => result.boardHash === createHash('sha256').update(parsed.data.board.join('\n')).digest('hex'));
}

export async function lookupFutureMoves(input: McpLookaheadInput): Promise<McpLookup> {
  const parsed = lookaheadInputSchema.safeParse(input);
  if (!parsed.success) throw new McpLookupError();
  return callLookup(MCP_LOOKAHEAD_TOOL_NAME, parsed.data, lookaheadOutputSchema, result => result.snapshotHash === createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex'));
}