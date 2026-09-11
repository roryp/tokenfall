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
export interface TokenRates {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}
export interface TokenPriceSnapshot {
  model: string;
  region: string;
  sku: 'GlobalStandard';
  currency: 'USD';
  usdPerMillion: TokenRates;
  checkedAt: string;
  sourceUrl: string;
  meters: Record<keyof TokenRates, { id: string; name: string; effectiveFrom: string }>;
}
export interface TokenPricing {
  status: 'loading' | 'live' | 'stale' | 'unavailable';
  snapshot: TokenPriceSnapshot | null;
}
export interface UsageCost {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  total: number;
}
export function costForUsage(usage: Pick<Usage, 'input' | 'output' | 'cached' | 'cacheWrites'>, usdPerMillion: TokenRates): UsageCost {
  const counts = [usage.input, usage.output, usage.cached, usage.cacheWrites];
  if (counts.some(value => !Number.isSafeInteger(value) || value < 0) || usage.cached + usage.cacheWrites > usage.input) throw new Error('Invalid token usage for pricing.');
  if (Object.values(usdPerMillion).some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid token rates.');
  const input = (usage.input - usage.cached - usage.cacheWrites) * usdPerMillion.input / 1000000;
  const cachedInput = usage.cached * usdPerMillion.cachedInput / 1000000;
  const cacheWrite = usage.cacheWrites * usdPerMillion.cacheWrite / 1000000;
  const output = usage.output * usdPerMillion.output / 1000000;
  return { input, cachedInput, cacheWrite, output, total: input + cachedInput + cacheWrite + output };
}
export const pointsPerCent = (score: number, costUsd: number) => costUsd > 0 && Number.isFinite(costUsd) ? score * 0.01 / costUsd : null;
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
export const tokenCreditsUsed = (usage: Pick<Usage, 'input' | 'output' | 'cached'>) => Math.max(0, usage.input - usage.cached) + usage.output;
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
  challengeScore: number | null;
  costUsd: number | null;
  unmeteredRequests: number;
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
  pricing: TokenPricing;
  unmeteredRequests: number;
  aiCooldownMs: number;
  autopilotCooldownMs: number;
}
export interface JoinResult {
  token: string;
  playerId: string;
  runId: string;
  sequence: number;
  replay: Replay;
  metrics: Metrics;
  name: string;
  tokenText: string;
}
export interface InputBatch { runId: string; sequence: number; frame: number; events: InputEvent[] }
export interface InputAck { sequence: number; score: number; lines: number; pieceId: number; frame: number }
export interface AiOptions { cache: boolean; compression: boolean; autopilot?: boolean }
export type Reply<Value> = { ok: true; data: Value } | { ok: false; error: string; code?: string; retryAfterMs?: number };
export interface ServerEvents {
  room: (room: RoomView) => void;
  notice: (message: string) => void;
}
export interface ClientEvents {
  join: (data: { name: string; room: string; token?: string; text?: string }, reply: (result: Reply<JoinResult>) => void) => void;
  inputs: (data: InputBatch, reply: (result: Reply<InputAck>) => void) => void;
  restart: (reply: (result: Reply<JoinResult>) => void) => void;
  configure: (data: { text: string }, reply: (result: Reply<JoinResult>) => void) => void;
  assist: (options: AiOptions, reply: (result: Reply<{ insight: Insight; metrics: Metrics }>) => void) => void;
}
export type { GameView };