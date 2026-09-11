import type { GameView, InputEvent, Placement, Replay } from './game.ts';

export interface TokenChip { id: number; text: string }
export interface Usage {
  input: number;
  output: number;
  cached: number;
  cacheWrites: number;
  reasoning: number | null;
  total: number;
}
export interface Metrics {
  requests: number;
  input: number;
  output: number;
  cached: number;
  cacheWrites: number;
  reasoning: number;
  compressionSaved: number;
}
export const emptyMetrics = (): Metrics => ({ requests: 0, input: 0, output: 0, cached: 0, cacheWrites: 0, reasoning: 0, compressionSaved: 0 });
export interface Insight {
  id: string;
  pieceId: number;
  placement: Pick<Placement, 'column' | 'row' | 'rotation'> | null;
  tip: string;
  status: 'ready' | 'stale' | 'invalid';
  usage: Usage;
  latencyMs: number;
  rawTokens: number;
  packedTokens: number;
  savedTokens: number;
  compression: boolean;
  cacheEnabled: boolean;
  prompt: string;
  outputText: string;
  inputChips: TokenChip[];
  outputChips: TokenChip[];
}
export interface LeaderboardEntry {
  id: string;
  name: string;
  score: number;
  lines: number;
  level: number;
  online: boolean;
  metrics: Metrics;
}
export interface RoomView {
  code: string;
  online: number;
  capacity: number;
  leaderboard: LeaderboardEntry[];
  metrics: Metrics;
  joinUrl: string | null;
  model: string;
  prefixTokens: number;
  tokenBudget: number;
  playerTokenBudget: number;
}
export interface JoinResult {
  token: string;
  playerId: string;
  runId: string;
  sequence: number;
  replay: Replay;
  metrics: Metrics;
  name: string;
}
export interface InputBatch { runId: string; sequence: number; frame: number; events: InputEvent[] }
export interface InputAck { sequence: number; score: number; lines: number; pieceId: number; frame: number }
export interface AiOptions { cache: boolean; compression: boolean }
export type Reply<Value> = { ok: true; data: Value } | { ok: false; error: string; code?: string; retryAfterMs?: number };
export interface ServerEvents {
  room: (room: RoomView) => void;
  notice: (message: string) => void;
}
export interface ClientEvents {
  join: (data: { name: string; room: string; token?: string }, reply: (result: Reply<JoinResult>) => void) => void;
  inputs: (data: InputBatch, reply: (result: Reply<InputAck>) => void) => void;
  restart: (reply: (result: Reply<JoinResult>) => void) => void;
  assist: (options: AiOptions, reply: (result: Reply<{ insight: Insight; metrics: Metrics }>) => void) => void;
}
export type { GameView };