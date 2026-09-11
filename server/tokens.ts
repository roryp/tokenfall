import { getEncoding } from 'js-tiktoken';
import { z } from 'zod';
import { HEIGHT, HIDDEN_ROWS, WIDTH } from '../shared/game.ts';
import type { Cell, Game, Placement } from '../shared/game.ts';
import type { Metrics, TokenChip, Usage } from '../shared/protocol.ts';

const encoding = getEncoding('o200k_base');
const symbols = new Set(['I', 'O', 'T', 'S', 'Z', 'J', 'L']);

export const countTokens = (text: string) => encoding.encode(text, [], []).length;
export const decodeTokens = (ids: number[]) => encoding.decode(ids);
export function tokenChips(text: string, limit = 96): TokenChip[] {
  return encoding.encode(text, [], []).slice(0, limit).map(id => {
    const decoded = encoding.decode([id]);
    return { id, text: decoded.includes('\uFFFD') ? '[byte]' : decoded };
  });
}

export function gameTokens(text: string): TokenChip[] {
  if (text.length < 1 || text.length > 500 || countTokens(text) > 256) throw new Error('Use 1 to 500 characters and at most 256 tokens.');
  return tokenChips(text, 256);
}

export function packBoard(board: Cell[]): string[] {
  if (board.length !== WIDTH * HEIGHT || board.some(cell => cell !== null && !symbols.has(cell))) throw new Error('Invalid board.');
  return Array.from({ length: HEIGHT }, (_, row) => board.slice(row * WIDTH, (row + 1) * WIDTH).map(cell => cell ?? '.').join(''));
}

export function unpackBoard(rows: string[]): Cell[] {
  if (rows.length !== HEIGHT || rows.some(row => row.length !== WIDTH || [...row].some(cell => cell !== '.' && !symbols.has(cell)))) throw new Error('Invalid packed board.');
  return rows.flatMap(row => [...row].map(cell => cell === '.' ? null : cell as Cell));
}

export function buildPrompts(game: Game, placements: Placement[]) {
  const common = {
    width: WIDTH, height: HEIGHT, hiddenRows: HIDDEN_ROWS,
    active: { type: game.piece, column: game.active.x, row: game.active.y, rotation: game.active.rot ?? 0 },
    hold: game.hold, canHold: !game.usedHold, next: game.queue.peek(), level: game.level,
    placements: placements.map(({ path: _path, ...placement }) => placement),
  };
  const board = game.well.toArray();
  const verbose = JSON.stringify({ ...common, board: board.map((value, index) => ({ row: Math.floor(index / WIDTH), column: index % WIDTH, value })) }, null, 2);
  const packed = JSON.stringify({ ...common, board: packBoard(board) });
  return { verbose, packed, rawTokens: countTokens(verbose), packedTokens: countTokens(packed) };
}

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative(), cache_write_tokens: z.number().int().nonnegative() }),
  completion_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).optional(),
});

export function normalizeUsage(value: unknown): Usage {
  const parsed = usageSchema.parse(value);
  if (parsed.total_tokens !== parsed.prompt_tokens + parsed.completion_tokens) throw new Error('Provider usage totals do not match.');
  if (parsed.prompt_tokens_details.cached_tokens + parsed.prompt_tokens_details.cache_write_tokens > parsed.prompt_tokens) throw new Error('Provider cache counts exceed input.');
  return {
    input: parsed.prompt_tokens, output: parsed.completion_tokens, total: parsed.total_tokens,
    cached: parsed.prompt_tokens_details.cached_tokens, cacheWrites: parsed.prompt_tokens_details.cache_write_tokens,
    reasoning: parsed.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

export function addUsage(metrics: Metrics, usage: Usage, savedTokens: number): Metrics {
  return {
    requests: metrics.requests + 1, input: metrics.input + usage.input, output: metrics.output + usage.output,
    cached: metrics.cached + usage.cached, cacheWrites: metrics.cacheWrites + usage.cacheWrites,
    reasoning: metrics.reasoning + (usage.reasoning ?? 0), compressionSaved: metrics.compressionSaved + Math.max(0, savedTokens),
  };
}