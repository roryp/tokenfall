import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TETROMINOES } from 'miaoda-game-fallblock-core';
import { Grid } from 'miaoda-game-grid-core';
import { z } from 'zod';
import { boardMetrics, Game, HEIGHT, HIDDEN_ROWS, placementsFor, WIDTH } from '../shared/game.ts';
import type { Cell, Placement } from '../shared/game.ts';
import type { McpContinuation, McpLookaheadResult } from '../shared/protocol.ts';

export const MCP_SERVER_NAME = 'tetris-board-facts';
export const MCP_TOOL_NAME = 'lookup_board_facts';
export const MCP_LOOKAHEAD_TOOL_NAME = 'analyze_future_moves';
export const boardInputSchema = z.object({ board: z.array(z.string().regex(/^[.IOTSZJL]{10}$/)).length(HEIGHT) }).strict();
export const boardFactsSchema = z.object({
  source: z.literal('shared/game.ts:boardMetrics'),
  boardHash: z.string().regex(/^[a-f0-9]{64}$/),
  coordinateOrder: z.literal('[column,row]'),
  hiddenRows: z.literal(HIDDEN_ROWS),
  holes: z.number().int().min(0).max(WIDTH * HEIGHT),
  columnHeights: z.array(z.number().int().min(0).max(HEIGHT)).length(WIDTH),
  maxHeight: z.number().int().min(0).max(HEIGHT),
  holeCells: z.array(z.tuple([z.number().int().min(0).max(WIDTH - 1), z.number().int().min(0).max(HEIGHT - 1)])).max(WIDTH * HEIGHT),
  rowGaps: z.array(z.object({ row: z.number().int().min(0).max(HEIGHT - 1), columns: z.array(z.number().int().min(0).max(WIDTH - 1)).max(WIDTH - 1) }).strict()).max(HEIGHT),
}).strict();

export const lookaheadInputSchema = boardInputSchema.extend({
  active: z.object({ piece: z.enum(TETROMINOES), column: z.number().int().min(-4).max(WIDTH), row: z.number().int().min(-4).max(HEIGHT - 1), rotation: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
  hold: z.enum(TETROMINOES).nullable(), canHold: z.boolean(),
  next: z.array(z.enum(TETROMINOES)).length(5),
}).strict();

type LookaheadInput = z.infer<typeof lookaheadInputSchema>;
const continuationSchema = z.tuple([z.string(), z.enum(TETROMINOES), z.boolean(), z.number().int().min(0).max(8), z.number().int().min(0).max(WIDTH * HEIGHT), z.number().int().min(0).max(HEIGHT)]);
export const lookaheadOutputSchema = z.object({
  depth: z.literal(2), source: z.literal('shared/game.ts:placementsFor'),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidatesEvaluated: z.number().int().min(0).max(3600),
  continuationsEvaluated: z.number().int().min(0),
  moveColumns: z.array(z.string()).length(5), replyColumns: z.array(z.string()).length(6),
  moves: z.array(z.tuple([z.string(), z.number().int().min(0), z.number().int().min(0), continuationSchema.nullable(), continuationSchema.nullable()])),
}).strict();

function analysisGame(input: LookaheadInput) {
  const pieces = [input.active.piece, ...input.next];
  const game = new Game('mcp-lookahead', pieces.map(piece => ({ id: TETROMINOES.indexOf(piece), text: '' })));
  game.well.fill(({ x: column, y: row }) => input.board[row][column] === '.' ? null : input.board[row][column] as Cell);
  game.active.x = input.active.column;
  game.active.y = input.active.row;
  game.active.rot = input.active.rotation;
  game.active.cells = game.active.orientations![input.active.rotation];
  game.held = input.hold ? game.newPiece(input.hold) : null;
  game.heldTokenIndex = input.hold ? 0 : null;
  game.usedHold = !input.canHold;
  return game;
}

export function analyzeFutureMoves(input: LookaheadInput): McpLookaheadResult {
  const candidates = placementsFor(analysisGame(input));
  let continuationsEvaluated = 0;
  const moves = candidates.map(candidate => {
    const branch = analysisGame(input);
    for (const action of candidate.path) branch.act(action);
    const replies = placementsFor(branch);
    continuationsEvaluated += replies.length;
    const surviving = replies.filter(reply => !reply.gameOver);
    const byHoles = [...surviving].sort((first, second) => first.holes - second.holes || first.maxHeight - second.maxHeight || second.clearedLines - first.clearedLines || first.bumpiness - second.bumpiness);
    const byClears = [...surviving].sort((first, second) => second.clearedLines - first.clearedLines || first.holes - second.holes || first.maxHeight - second.maxHeight || first.bumpiness - second.bumpiness);
    const outcome = (reply: Placement | undefined): McpContinuation | null => reply ? [reply.id, reply.piece, reply.useHold, candidate.clearedLines + reply.clearedLines, reply.holes, reply.maxHeight] : null;
    return [candidate.id, replies.length, surviving.length, outcome(byHoles[0]), byClears[0]?.id !== byHoles[0]?.id ? outcome(byClears[0]) : null] as const;
  });
  return {
    depth: 2 as const,
    source: 'shared/game.ts:placementsFor' as const,
    snapshotHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    candidatesEvaluated: candidates.length, continuationsEvaluated,
    moveColumns: ['firstMoveId', 'legalReplies', 'survivingReplies', 'lowestHolesReply', 'mostClearsAlternative'],
    replyColumns: ['nextMoveId', 'piece', 'useHold', 'linesAcrossBothMoves', 'holesAfterBoth', 'heightAfterBoth'],
    moves,
  };
}

export function createBoardMcpServer() {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '2.0.0' });
  server.registerTool(MCP_LOOKAHEAD_TOOL_NAME, {
    title: 'Analyze the next two Tetris placements',
    description: 'Simulate every legal current placement, then its legal next placements including Hold. Report survival counts and achievable low-hole and line-clearing continuations. Uses only the known preview, does not execute moves or select the current move.',
    inputSchema: lookaheadInputSchema,
    outputSchema: lookaheadOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => {
    const analysis = analyzeFutureMoves(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(analysis) }], structuredContent: { ...analysis } };
  });
  server.registerTool(MCP_TOOL_NAME, {
    title: 'Look up Tetris board facts',
    description: 'Inspect all 22 board rows for exact covered-hole coordinates, column heights, and gaps in occupied rows. Returns facts only; does not rank or choose moves, access player data, or change the game.',
    inputSchema: boardInputSchema,
    outputSchema: boardFactsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ board }) => {
    const well = new Grid<Cell>({ width: WIDTH, height: HEIGHT, empty: null }).fill(({ x: column, y: row }) => board[row][column] === '.' ? null : board[row][column] as Cell);
    const metrics = boardMetrics(well);
    const holeCells: [number, number][] = [];
    for (const [column, height] of metrics.columnHeights.entries()) {
      for (let row = HEIGHT - height; row < HEIGHT; row += 1) if (well.get(column, row) === null) holeCells.push([column, row]);
    }
    const rowGaps = board.flatMap((cells, row) => {
      if (cells === '.'.repeat(WIDTH) || !cells.includes('.')) return [];
      return [{ row, columns: [...cells].flatMap((cell, column) => cell === '.' ? [column] : []) }];
    });
    const facts = {
      source: 'shared/game.ts:boardMetrics' as const,
      boardHash: createHash('sha256').update(board.join('\n')).digest('hex'),
      coordinateOrder: '[column,row]' as const, hiddenRows: HIDDEN_ROWS,
      holes: metrics.holes, columnHeights: metrics.columnHeights, maxHeight: metrics.maxHeight,
      holeCells, rowGaps,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(facts) }], structuredContent: facts };
  });
  return server;
}

if (import.meta.main) await createBoardMcpServer().connect(new StdioServerTransport());