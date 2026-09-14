import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { z } from 'zod';
import type { Game } from '../shared/game.ts';
import { MCP_LOOKUP_TIMEOUT_MS } from '../shared/protocol.ts';
import type { McpLookaheadInput, McpLookup } from '../shared/protocol.ts';
import { boardFactsSchema, boardInputSchema, lookaheadInputSchema, lookaheadOutputSchema, MCP_LOOKAHEAD_TOOL_NAME, MCP_SERVER_NAME, MCP_TOOL_NAME } from './mcp-server.ts';
import { countTokens, packBoard } from './tokens.ts';

export { MCP_LOOKUP_TIMEOUT_MS } from '../shared/protocol.ts';
export const MAX_MCP_CONTEXT_TOKENS = 2304;

export class McpLookupError extends Error {
  constructor() { super('MCP lookup failed before contacting Luna. Try again or switch MCP tools off.'); }
}

export function lookaheadSnapshot(game: Game): McpLookaheadInput {
  return {
    board: packBoard(game.well.toArray()),
    active: { piece: game.piece, column: game.active.x, row: game.active.y, rotation: game.active.rot ?? 0 },
    hold: game.hold, canHold: !game.usedHold, next: [...game.queue.peek()],
  };
}

async function callLookup<Result>(tool: string, args: McpLookup['arguments'], schema: z.ZodType<Result>, matchesSnapshot: (result: Result) => boolean): Promise<McpLookup> {
  const client = new Client({ name: 'luna-tetris', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./mcp-server.ts', import.meta.url))], stderr: 'ignore', maxBufferSize: 32768 });
  const request = { timeout: MCP_LOOKUP_TIMEOUT_MS, signal: AbortSignal.timeout(MCP_LOOKUP_TIMEOUT_MS) };
  const started = performance.now();
  try {
    await client.connect(transport, request);
    if (client.getServerVersion()?.name !== MCP_SERVER_NAME) throw new McpLookupError();
    const { tools } = await client.listTools({}, request);
    if (!tools.some(entry => entry.name === tool)) throw new McpLookupError();
    const response = await client.callTool({ name: tool, arguments: { ...args } }, undefined, request);
    if (response.isError) throw new McpLookupError();
    const parsed = schema.parse(response.structuredContent);
    if (!matchesSnapshot(parsed)) throw new McpLookupError();
    const result = JSON.stringify(parsed);
    const resultTokens = countTokens(result);
    if (resultTokens + 128 > MAX_MCP_CONTEXT_TOKENS) throw new McpLookupError();
    return { server: MCP_SERVER_NAME, tool, transport: 'stdio', arguments: args, result, resultTokens, durationMs: Math.round(performance.now() - started) };
  } catch { throw new McpLookupError(); }
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