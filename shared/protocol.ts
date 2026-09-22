import type { GameView, InputEvent, Placement, Replay } from './game.ts';

export interface TokenChip { id: number; text: string }
export interface PromptPreview {
  runId: string;
  pieceId: number;
  rawTokens: number;
  packedTokens: number;
  prefixTokens: number;
  maxOutputTokens: number;
  rawReservation: number;
  packedReservation: number;
}
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
  cacheHits: number;
  cacheMisses: number;
  cacheBypassed: number;
}
export const emptyMetrics = (): Metrics => ({ requests: 0, input: 0, output: 0, cached: 0, cacheWrites: 0, reasoning: 0, compressionSaved: 0, cacheHits: 0, cacheMisses: 0, cacheBypassed: 0 });
export const tokenCreditsUsed = (usage: Pick<Usage, 'input' | 'output' | 'cached'>) => Math.max(0, usage.input - usage.cached) + usage.output;
export const MAX_REQUEST_TOKENS = 16000;
export const DEFAULT_TOKEN_ALLOWANCE = 1000000;
export const MAX_TOKEN_ALLOWANCE = 8000000;
export interface TokenAllowance {
  limit: number;
  used: number;
  reserved: number;
  unconfirmed: number;
  remaining: number;
}
export const reportedTokenBalance = (allowance: Pick<TokenAllowance, 'limit' | 'used'>) => Math.max(0, allowance.limit - allowance.used);
export function tokenAllowance(limit: number, usage: Pick<Metrics, 'input' | 'output'>, reserved = 0, unconfirmed = 0): TokenAllowance {
  const used = usage.input + usage.output;
  return { limit, used, reserved, unconfirmed, remaining: Math.max(0, limit - used - reserved - unconfirmed) };
}
export const MCP_LOOKUP_TIMEOUT_MS = 15000;
export interface McpLookaheadInput {
  board: string[];
  active: { piece: GameView['piece']; column: number; row: number; rotation: number };
  hold: GameView['hold'];
  canHold: boolean;
  next: GameView['next'];
}
export type McpContinuation = [moveId: string, piece: GameView['piece'], useHold: boolean, lines: number, holes: number, height: number];
export interface McpLookaheadResult {
  depth: 2;
  source: 'shared/game.ts:placementsFor';
  snapshotHash: string;
  candidatesEvaluated: number;
  continuationsEvaluated: number;
  moveColumns: string[];
  replyColumns: string[];
  moves: (readonly [moveId: string, replies: number, surviving: number, lowestHoles: McpContinuation | null, mostClears: McpContinuation | null])[];
}
export interface McpLookup {
  server: string;
  tool: string;
  transport: 'stdio';
  arguments: { board: string[] } | McpLookaheadInput;
  result: string;
  resultTokens: number;
  addedInputTokens?: number;
  durationMs: number;
}
export interface Insight {
  id: string;
  pieceId: number;
  placement: (Pick<Placement, 'column' | 'row' | 'rotation'> & Partial<Pick<Placement, 'piece' | 'useHold'>>) | null;
  tip: string;
  status: 'ready' | 'stale' | 'invalid';
  usage: Usage;
  latencyMs: number;
  rawTokens: number;
  packedTokens: number;
  savedTokens: number;
  compression: boolean;
  cacheEnabled: boolean;
  reasoningEnabled?: boolean;
  mcpLookup?: McpLookup;
  prompt: string;
  systemPrompt?: string;
  promptComparison?: { verbose: string; packed: string };
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
export type RoomResetMode = 'all' | 'scores';
export interface RoomMaintenanceStatus { online: number; activeGames: number; pendingRequests: number; resetting: boolean }
export interface RoomResetSummary { players: number; nonzeroScores: number; requests: number; usedTokens: number; attempts: number }
export interface RoomResetPreview {
  room: string;
  mode: RoomResetMode;
  confirmationId: string;
  expiresAt: number;
  before: RoomResetSummary;
}
export interface RoomResetResult {
  id: string;
  room: string;
  mode: RoomResetMode;
  before: RoomResetSummary;
  after: RoomResetSummary;
  backup: string;
}
export interface RoomView {
  code: string;
  online: number;
  capacity: number;
  leaderboard: LeaderboardEntry[];
  pointsLeaderboard: LeaderboardEntry[];
  metrics: Metrics;
  joinUrl: string | null;
  model: string;
  prefixTokens: number;
  tokenBudget: number;
  playerTokenBudget: number;
  allowance: TokenAllowance;
  requestsRemaining: number;
  pricing: TokenPricing;
  unmeteredRequests: number;
  aiCooldownMs: number;
  autopilotCooldownMs: number;
  maintenance?: RoomMaintenanceStatus;
}
export interface PlayerUsage {
  metrics: Metrics;
  unmeteredRequests: number;
  allowance: TokenAllowance;
}
export interface JoinResult extends PlayerUsage {
  token: string;
  playerId: string;
  runId: string;
  sequence: number;
  replay: Replay;
  name: string;
  tokenText: string;
}
export interface InputBatch { runId: string; sequence: number; frame: number; events: InputEvent[] }
export interface InputAck { sequence: number; score: number; lines: number; pieceId: number; frame: number }
export interface AiOptions { cache: boolean; compression: boolean; reasoning?: boolean; mcp?: boolean; autopilot?: boolean }
export type Reply<Value> = { ok: true; data: Value } | { ok: false; error: string; code?: string; retryAfterMs?: number };
export interface ServerEvents {
  room: (room: RoomView) => void;
  usage: (usage: PlayerUsage) => void;
  notice: (message: string) => void;
  roomReset: (reset: { id: string; mode: RoomResetMode }) => void;
}
export interface ClientEvents {
  join: (data: { name: string; room: string; token?: string; text?: string; classic?: boolean; tokenLimit?: number }, reply: (result: Reply<JoinResult>) => void) => void;
  inputs: (data: InputBatch, reply: (result: Reply<InputAck>) => void) => void;
  restart: (reply: (result: Reply<JoinResult>) => void) => void;
  configure: (data: { text: string; tokenLimit?: number }, reply: (result: Reply<JoinResult>) => void) => void;
  allowance: (data: { tokenLimit: number }, reply: (result: Reply<PlayerUsage>) => void) => void;
  inspect: (reply: (result: Reply<PromptPreview>) => void) => void;
  assist: (options: AiOptions, reply: (result: Reply<{ insight: Insight } & PlayerUsage>) => void) => void;
}
export type { GameView };