import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { AzureCliCredential, getBearerTokenProvider, ManagedIdentityCredential } from '@azure/identity';
import { z } from 'zod';
import { placementsFor } from '../shared/game.ts';
import type { Game } from '../shared/game.ts';
import type { AiOptions, Insight } from '../shared/protocol.ts';
import type { AppConfig } from './config.ts';
import { buildPrompts, countTokens, normalizeUsage, tokenChips } from './tokens.ts';

export const POLICY = readFileSync(new URL('./policy.md', import.meta.url), 'utf8');
export const PREFIX_TOKENS = countTokens(POLICY);
export const MAX_OUTPUT_TOKENS = 128;
export const PLAYER_TOKEN_BUDGET = 16000;
export const ROOM_TOKEN_BUDGET = 2000000;
export const AI_COOLDOWN_MS = 8000;
export const AUTOPILOT_COOLDOWN_MS = 1000;

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
  private activePlayers = new Set<string>();
  private requestTimes: { time: number; tokens: number }[] = [];

  acquire(playerId: string, reservation: number, playerSpent: number, roomSpent: number, now = Date.now(), autopilot = false) {
    if (this.activePlayers.has(playerId)) throw new RequestError('Luna is already choosing your move.', 'busy', 1000);
    const remaining = (autopilot ? AUTOPILOT_COOLDOWN_MS : AI_COOLDOWN_MS) - (now - (this.lastRequest.get(playerId) ?? -Infinity));
    if (remaining > 0) throw new RequestError('Luna is cooling down.', 'cooldown', remaining);
    this.requestTimes = this.requestTimes.filter(entry => now - entry.time < 60000);
    const scheduledTokens = this.requestTimes.reduce((sum, entry) => sum + entry.tokens, 0);
    if (this.inFlight >= 4 || this.requestTimes.length >= 90 || scheduledTokens + reservation > 400000) throw new RequestError('The room is busy. Keep playing and try again shortly.', 'busy', 3000);
    if (reservation > 16000 || playerSpent + reservation > PLAYER_TOKEN_BUDGET) throw new RequestError('Not enough token credits for this request. Compression lowers the cost; manual play is still available.', 'budget');
    if (roomSpent + this.reserved + reservation > ROOM_TOKEN_BUDGET) throw new RequestError('The room model token limit is reached. Manual play is still available.', 'budget');
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
    const pieceId = game.pieceId;
    const placements = placementsFor(game);
    if (!placements.length) throw new RequestError('Start a new game before requesting a move.');
    const prompts = buildPrompts(game, placements);
    const prompt = options.compression ? prompts.packed : prompts.verbose;
    const content = {
      type: 'text' as const,
      text: POLICY,
      ...(options.cache ? { prompt_cache_breakpoint: { mode: 'explicit' as const } } : {}),
    };
    const request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.deployment,
      reasoning_effort: 'none' as const,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      store: false,
      prompt_cache_key: `tokenfall-policy-v2:${cacheBucket}`,
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
    const started = performance.now();
    const result = await this.client.chat.completions.create(request);
    const latencyMs = Math.round(performance.now() - started);
    const usage = normalizeUsage(result.usage);
    const outputText = result.choices[0]?.message.content ?? '';
    let selection: z.infer<typeof moveSchema> | null = null;
    try { selection = moveSchema.parse(JSON.parse(outputText)); } catch { selection = null; }
    const selected = placements.find(placement => placement.id === selection?.placementId);
    const valid = selected && selection && usage.reasoning === 0 && result.choices[0]?.finish_reason === 'stop';
    return {
      id: randomUUID(), pieceId,
      placement: valid ? { column: selected.column, row: selected.row, rotation: selected.rotation } : null,
      tip: valid && selection ? selection.tip : usage.reasoning !== 0 ? 'The service did not confirm zero reasoning. This move was rejected.' : 'The model did not return a valid legal move.',
      status: valid ? 'ready' : 'invalid', usage, latencyMs,
      rawTokens: prompts.rawTokens, packedTokens: prompts.packedTokens,
      savedTokens: options.compression ? Math.max(0, prompts.rawTokens - prompts.packedTokens) : 0,
      compression: options.compression, cacheEnabled: options.cache,
      prompt, outputText, inputChips: tokenChips(prompt), outputChips: tokenChips(outputText),
    };
  }
}