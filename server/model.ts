import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { AzureCliCredential, getBearerTokenProvider, ManagedIdentityCredential } from '@azure/identity';
import { z } from 'zod';
import { placementsFor } from '../shared/game.ts';
import type { Game } from '../shared/game.ts';
import { MAX_TOKEN_ALLOWANCE } from '../shared/protocol.ts';
import type { AiOptions, Insight } from '../shared/protocol.ts';
import type { AppConfig } from './config.ts';
import { buildPrompts, countTokens, normalizeUsage, tokenChips } from './tokens.ts';
import { lookaheadSnapshot, lookupFutureMoves, MAX_MCP_CONTEXT_TOKENS, McpLookupError, mcpPromptContext } from './mcp.ts';

export const POLICY = readFileSync(new URL('./policy.md', import.meta.url), 'utf8');
export const PREFIX_TOKENS = countTokens(POLICY);
export const MCP_GUIDANCE = '\n\nMCP LOOKAHEAD\nWith MCP enabled, the optional tool supplements the immediate engine facts with two-placement simulations. Read mcpLookup.analysis before selecting your current placementId. Every original current move is included, in original order. Use survivingReplies to detect next-turn traps. lowestHolesReply and mostClearsAlternative each describe ONE achievable future path, not independent minima to combine. When analysis.replies is present, non-null forecast entries in moves are zero-based indexes into that replies table; resolve them to the same replyColumns tuples. A zero survivingReplies means no enumerated next placement avoids game over. Prefer a current move with safe continuations; compare achievable future holes, clears and height against its immediate outcome. nextMoveId belongs to a hypothetical next board and MUST NOT be returned as the current placementId. This is only two-placement lookahead, not a guarantee of survival. You still select and return one current move.';
export const MAX_OUTPUT_TOKENS = 128;
export const MAX_REASONING_COMPLETION_TOKENS = 2048;
export const maxCompletionTokens = (options: AiOptions) => options.reasoning ? MAX_REASONING_COMPLETION_TOKENS : MAX_OUTPUT_TOKENS;
export const PLAYER_TOKEN_BUDGET = 160000;
export const ROOM_TOKEN_BUDGET = MAX_TOKEN_ALLOWANCE;
export const PLAYER_REQUEST_LIMIT = 40;
export const ROOM_REQUEST_LIMIT = 2000;
export const AI_COOLDOWN_MS = 8000;
export const AUTOPILOT_COOLDOWN_MS = 1000;
export const EVALUATION_INTERVAL_MS = 1000;
export const ROOM_EVALUATIONS_PER_SECOND = 8;

export interface ModelGateway {
  complete(game: Game, options: AiOptions, cacheBucket: string): Promise<Insight>;
}

export class RequestError extends Error {
  code: string;
  retryAfterMs: number;
  constructor(message: string, code = 'invalid', retryAfterMs = 0) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ModelGate {
  inFlight = 0;
  reserved = 0;
  private lastRequest = new Map<string, number>();
  private lastEvaluation = new Map<string, number>();
  private activePlayers = new Set<string>();
  private requestTimes: { time: number; tokens: number }[] = [];
  private evaluationTimes: number[] = [];

  // Rejects with in-memory checks before a caller spends CPU on prompt building.
  admit(playerId: string, now = Date.now(), autopilot = false) {
    if (this.activePlayers.has(playerId)) throw new RequestError('Luna is already choosing your move.', 'busy', 1000);
    const remaining = (autopilot ? AUTOPILOT_COOLDOWN_MS : AI_COOLDOWN_MS) - (now - (this.lastRequest.get(playerId) ?? -Infinity));
    if (remaining > 0) throw new RequestError('Luna is cooling down.', 'cooldown', remaining);
    const pacing = EVALUATION_INTERVAL_MS - (now - (this.lastEvaluation.get(playerId) ?? -Infinity));
    if (pacing > 0) throw new RequestError('Luna is cooling down.', 'cooldown', pacing);
    this.requestTimes = this.requestTimes.filter(entry => now - entry.time < 60000);
    if (this.inFlight >= 4 || this.requestTimes.length >= 90) throw new RequestError('The room is busy. Keep playing and try again shortly.', 'busy', 3000);
    this.evaluate(now);
    if (this.lastEvaluation.size > 1000) for (const [id, time] of this.lastEvaluation) if (now - time >= EVALUATION_INTERVAL_MS) this.lastEvaluation.delete(id);
    this.lastEvaluation.set(playerId, now);
  }

  evaluate(now = Date.now()) {
    this.evaluationTimes = this.evaluationTimes.filter(time => now - time < 1000);
    if (this.evaluationTimes.length >= ROOM_EVALUATIONS_PER_SECOND) throw new RequestError('The room is busy. Keep playing and try again shortly.', 'busy', 1000);
    this.evaluationTimes.push(now);
  }

  acquire(playerId: string, reservation: number, playerSpent: number, roomSpent: number, now = Date.now(), autopilot = false, playerBudget = PLAYER_TOKEN_BUDGET) {
    if (this.activePlayers.has(playerId)) throw new RequestError('Luna is already choosing your move.', 'busy', 1000);
    const remaining = (autopilot ? AUTOPILOT_COOLDOWN_MS : AI_COOLDOWN_MS) - (now - (this.lastRequest.get(playerId) ?? -Infinity));
    if (remaining > 0) throw new RequestError('Luna is cooling down.', 'cooldown', remaining);
    this.requestTimes = this.requestTimes.filter(entry => now - entry.time < 60000);
    const scheduledTokens = this.requestTimes.reduce((sum, entry) => sum + entry.tokens, 0);
    if (this.inFlight >= 4 || this.requestTimes.length >= 90 || scheduledTokens + reservation > 400000) throw new RequestError('The room is busy. Keep playing and try again shortly.', 'busy', 3000);
    if (playerSpent + reservation > playerBudget) throw new RequestError(`Not enough token credits in your AI allowance: ${Math.max(0, playerBudget - playerSpent).toLocaleString()} left; this request needs ${reservation.toLocaleString()}.`, 'budget');
    if (roomSpent + this.reserved + reservation > ROOM_TOKEN_BUDGET) throw new RequestError(`The shared room model token limit is reached: ${Math.max(0, ROOM_TOKEN_BUDGET - roomSpent - this.reserved).toLocaleString()} tokens available; ${reservation.toLocaleString()} needed. Manual play is still available.`, 'room-budget');
    this.inFlight += 1;
    this.reserved += reservation;
    this.activePlayers.add(playerId);
    this.lastRequest.set(playerId, now);
    this.requestTimes.push({ time: now, tokens: reservation });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.reserved -= reservation;
      this.activePlayers.delete(playerId);
    };
  }
}

const moveSchema = z.object({ placementId: z.string().max(20), tip: z.string().max(160) }).strict();

export class LunaGateway implements ModelGateway {
  private client: OpenAI;
  private deployment: string;

  constructor(config: AppConfig) {
    if (PREFIX_TOKENS < 1024) throw new Error('The reusable model policy is too short for prompt caching.');
    const credential = config.managedIdentityClientId
      ? new ManagedIdentityCredential({ clientId: config.managedIdentityClientId })
      : new AzureCliCredential({ tenantId: config.tenantId });
    this.client = new OpenAI({
      baseURL: `${config.endpoint.replace(/\/$/, '')}/openai/v1/`,
      apiKey: getBearerTokenProvider(credential, 'https://cognitiveservices.azure.com/.default'),
      maxRetries: 0,
      timeout: 20000,
    });
    this.deployment = config.deployment;
  }

  async complete(game: Game, options: AiOptions, cacheBucket: string): Promise<Insight> {
    const started = performance.now();
    const pieceId = game.pieceId;
    const placements = placementsFor(game);
    if (!placements.length) throw new RequestError('Start a new game before requesting a move.');
    let prompts = buildPrompts(game, placements);
    const mcpLookup = options.mcp ? await lookupFutureMoves(lookaheadSnapshot(game)) : undefined;
    const originalTokens = options.compression ? prompts.packedTokens : prompts.rawTokens;
    if (mcpLookup) {
      const context = mcpPromptContext(mcpLookup);
      const verbose = JSON.stringify({ ...JSON.parse(prompts.verbose), mcpLookup: context });
      const packed = JSON.stringify({ ...JSON.parse(prompts.packed), mcpLookup: context });
      prompts = { verbose, packed, rawTokens: countTokens(verbose), packedTokens: countTokens(packed) };
    }
    const prompt = options.compression ? prompts.packed : prompts.verbose;
    const systemPrompt = POLICY + (mcpLookup ? MCP_GUIDANCE : '');
    if (mcpLookup) {
      mcpLookup.addedInputTokens = countTokens(prompt) - originalTokens + countTokens(systemPrompt) - PREFIX_TOKENS;
      if (mcpLookup.addedInputTokens > MAX_MCP_CONTEXT_TOKENS) throw new McpLookupError('context');
    }
    const content = {
      type: 'text' as const,
      text: systemPrompt,
      ...(options.cache ? { prompt_cache_breakpoint: { mode: 'explicit' as const } } : {}),
    };
    const request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.deployment,
      reasoning_effort: options.reasoning ? 'low' : 'none',
      max_completion_tokens: maxCompletionTokens(options),
      store: false,
      prompt_cache_key: `tokenfall-policy-v4:${cacheBucket}${mcpLookup ? ':lookahead-v2' : ''}`,
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
      messages: [
        { role: 'system' as const, content: [content] },
        { role: 'user' as const, content: prompt },
      ],
      response_format: {
        type: 'json_schema' as const,
        json_schema: {
          name: 'tetris_move', strict: true,
          schema: { type: 'object', properties: { placementId: { type: 'string' }, tip: { type: 'string' } }, required: ['placementId', 'tip'], additionalProperties: false },
        },
      },
    };
    const result = await this.client.chat.completions.create(request, { timeout: options.reasoning ? 60000 : 20000 });
    const latencyMs = Math.round(performance.now() - started);
    const usage = normalizeUsage(result.usage);
    const outputText = result.choices[0]?.message.content ?? '';
    let selection: z.infer<typeof moveSchema> | null = null;
    try { selection = moveSchema.parse(JSON.parse(outputText)); } catch { selection = null; }
    const selected = placements.find(placement => placement.id === selection?.placementId);
    const allowedReasoning = options.reasoning || usage.reasoning === 0;
    const valid = selected && selection && allowedReasoning && result.choices[0]?.finish_reason === 'stop';
    return {
      id: randomUUID(), pieceId,
      placement: valid ? { column: selected.column, row: selected.row, rotation: selected.rotation, piece: selected.piece, useHold: selected.useHold } : null,
      tip: valid && selection ? selection.tip : !allowedReasoning ? 'The service did not confirm zero reasoning. This move was rejected.' : result.choices[0]?.finish_reason === 'length' ? `The reply hit its ${maxCompletionTokens(options).toLocaleString()}-token completion cap, not your total allowance. Usage was recorded; no move was applied.` : 'The model did not return a valid legal move.',
      status: valid ? 'ready' : 'invalid', usage, latencyMs,
      rawTokens: prompts.rawTokens, packedTokens: prompts.packedTokens,
      savedTokens: options.compression ? Math.max(0, prompts.rawTokens - prompts.packedTokens) : 0,
      compression: options.compression, cacheEnabled: options.cache, reasoningEnabled: Boolean(options.reasoning),
      ...(mcpLookup ? { mcpLookup } : {}),
      prompt, systemPrompt, outputText, inputChips: tokenChips(prompt), outputChips: tokenChips(outputText),
      promptComparison: { verbose: prompts.verbose, packed: prompts.packed },
    };
  }
}