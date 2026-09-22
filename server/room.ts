import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Game, FPS, placementsFor } from '../shared/game.ts';
import { costForUsage, DEFAULT_TOKEN_ALLOWANCE, emptyMetrics, MAX_REQUEST_TOKENS, pointsPerCent, tokenAllowance } from '../shared/protocol.ts';
import type { AiOptions, InputAck, InputBatch, JoinResult, LeaderboardEntry, Metrics, PlayerUsage, PromptPreview, RoomResetMode, RoomResetPreview, RoomView, TokenPricing } from '../shared/protocol.ts';
import type { AppConfig } from './config.ts';
import { AI_COOLDOWN_MS, AUTOPILOT_COOLDOWN_MS, MAX_OUTPUT_TOKENS, maxCompletionTokens, ModelGate, PREFIX_TOKENS, ROOM_REQUEST_LIMIT, ROOM_TOKEN_BUDGET, RequestError } from './model.ts';
import type { ModelGateway } from './model.ts';
import { addUsage, buildPrompts, gameTokens } from './tokens.ts';
import { MAX_MCP_CONTEXT_TOKENS, McpLookupError } from './mcp.ts';
import { resetRoom } from '../scripts/reset-room.ts';

interface PlayerRecord {
  id: string;
  token_hash: string;
  name: string;
  best_score: number;
  best_lines: number;
  best_level: number;
  metrics: string;
  attempts: number;
  updated: number;
  token_text: string;
  token_limit: number;
}
export interface Player {
  record: PlayerRecord;
  metrics: Metrics;
  game: Game;
  runId: string;
  started: number;
  sequence: number;
  socketId: string | null;
  lastSeen: number;
  inputWindow: number;
  inputCount: number;
}

export class Room {
  database: DatabaseSync;
  players = new Map<string, Player>();
  code: string;
  gate = new ModelGate();
  pricing: TokenPricing = { status: 'loading', snapshot: null };
  private previewTimes = new Map<string, number>();
  private pendingTokens = new Map<string, number>();
  private resetting = false;
  private resetPreviews = new Map<string, { mode: RoomResetMode; expiresAt: number; fingerprint: string }>();
  config: AppConfig;
  gateway: ModelGateway;

  constructor(config: AppConfig, gateway: ModelGateway) {
    this.config = config;
    this.gateway = gateway;
    mkdirSync(config.dataDirectory, { recursive: true });
    this.database = new DatabaseSync(path.join(config.dataDirectory, 'tokenfall.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode = ${config.sqliteJournalMode ?? 'WAL'};
      PRAGMA synchronous = ${config.sqliteJournalMode === 'DELETE' ? 'FULL' : 'NORMAL'};
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        best_score INTEGER NOT NULL DEFAULT 0, best_lines INTEGER NOT NULL DEFAULT 0,
        best_level INTEGER NOT NULL DEFAULT 1, metrics TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL, token_text TEXT NOT NULL DEFAULT '', token_limit INTEGER NOT NULL DEFAULT 1000000
      );
    `);
    if (!this.database.prepare('PRAGMA table_info(players)').all().some(column => column.name === 'token_text')) this.database.exec("ALTER TABLE players ADD COLUMN token_text TEXT NOT NULL DEFAULT ''");
    if (!this.database.prepare('PRAGMA table_info(players)').all().some(column => column.name === 'token_limit')) this.database.exec('ALTER TABLE players ADD COLUMN token_limit INTEGER NOT NULL DEFAULT 1000000');
    const saved = this.database.prepare("SELECT value FROM settings WHERE key = 'room'").get() as { value: string } | undefined;
    this.code = saved?.value ?? randomBytes(3).toString('hex').toUpperCase();
    if (!saved) this.database.prepare("INSERT INTO settings (key, value) VALUES ('room', ?)").run(this.code);
  }

  get online() { return [...this.players.values()].filter(player => player.socketId !== null).length; }
  records() { return this.database.prepare('SELECT * FROM players ORDER BY best_score DESC, best_lines DESC, updated ASC').all() as unknown as PlayerRecord[]; }

  get maintenanceStatus() {
    return {
      online: this.online,
      activeGames: [...this.players.values()].filter(player => player.socketId && player.game.status === 'playing').length,
      pendingRequests: this.pendingTokens.size,
      resetting: this.resetting,
    };
  }

  private assertAvailable(player?: Player) {
    if (this.resetting) throw new RequestError('Room reset in progress. Try again shortly.', 'maintenance');
    if (player && this.players.get(player.record.id) !== player) throw new RequestError('Your previous session expired. Join again.', 'session');
  }

  private resetFingerprint() { return createHash('sha256').update(JSON.stringify(this.records())).digest('hex'); }

  previewReset(mode: RoomResetMode): RoomResetPreview {
    this.assertAvailable();
    const now = Date.now();
    for (const [id, preview] of this.resetPreviews) if (preview.expiresAt <= now) this.resetPreviews.delete(id);
    if (this.resetPreviews.size >= 20) this.resetPreviews.delete(this.resetPreviews.keys().next().value!);
    const confirmationId = randomUUID();
    const expiresAt = now + 120000;
    this.resetPreviews.set(confirmationId, { mode, expiresAt, fingerprint: this.resetFingerprint() });
    const records = this.records();
    const totals = this.totals();
    return { room: this.code, mode, confirmationId, expiresAt, before: { players: records.length, nonzeroScores: records.filter(record => record.best_score > 0).length, requests: totals.metrics.requests, usedTokens: totals.metrics.input + totals.metrics.output, attempts: totals.attempts } };
  }

  async reset(mode: RoomResetMode, confirmRoom: string, confirmationId?: string) {
    this.assertAvailable();
    if (confirmRoom !== this.code) throw new RequestError('Enter the current room code to confirm the reset.', 'validation');
    if (confirmationId !== undefined) {
      const preview = this.resetPreviews.get(confirmationId);
      this.resetPreviews.delete(confirmationId);
      if (!preview || preview.expiresAt <= Date.now() || preview.mode !== mode || preview.fingerprint !== this.resetFingerprint()) throw new RequestError('The room changed or this preview expired. Refresh the preview before resetting.', 'reset-preview');
    }
    const assertIdle = async () => {
      const status = this.maintenanceStatus;
      if (status.activeGames > 0) throw new RequestError('Pause all games before resetting the room.', 'room-active');
      if (status.pendingRequests > 0 || this.gate.reserved > 0) throw new RequestError('Wait for pending Luna requests before resetting the room.', 'room-active');
    };
    this.resetting = true;
    try {
      await assertIdle();
      const result = await resetRoom({ databasePath: path.join(this.config.dataDirectory, 'tokenfall.sqlite'), mode, apply: true, confirmRoom, assertIdle });
      this.players.clear();
      this.previewTimes.clear();
      this.resetPreviews.clear();
      return result;
    } finally { this.resetting = false; }
  }

  save(player: Player) {
    this.assertAvailable(player);
    player.record.metrics = JSON.stringify(player.metrics);
    const record = player.record;
    this.database.prepare(`INSERT INTO players (id, token_hash, name, best_score, best_lines, best_level, metrics, attempts, updated, token_text, token_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, best_score=excluded.best_score, best_lines=excluded.best_lines,
      best_level=excluded.best_level, metrics=excluded.metrics, attempts=excluded.attempts, updated=excluded.updated, token_text=excluded.token_text, token_limit=excluded.token_limit`)
      .run(record.id, record.token_hash, record.name, record.best_score, record.best_lines, record.best_level, record.metrics, record.attempts, record.updated, record.token_text, record.token_limit);
  }

  totals() {
    const metrics = emptyMetrics();
    let attempts = 0;
    for (const record of this.records()) {
      const saved = JSON.parse(record.metrics) as Metrics;
      for (const key of Object.keys(metrics) as (keyof Metrics)[]) metrics[key] += saved[key] ?? 0;
      attempts += record.attempts;
    }
    return { metrics, attempts };
  }

  gameFor(text: string) {
    try { return new Game(text ? `tokenfall:${this.code}` : randomUUID(), text ? gameTokens(text) : []); }
    catch { throw new RequestError('Use 1 to 500 characters and at most 256 tokens.', 'token-setup'); }
  }

  join(name: string, code: string, token: string | undefined, socketId: string, text?: string, classic = false): JoinResult {
    this.assertAvailable();
    if (code !== this.code) throw new RequestError('That room code is not active.', 'room');
    if (classic && text !== undefined) throw new RequestError('Classic games do not use token text.', 'validation');
    const now = Date.now();
    for (const [id, player] of this.players) if (!player.socketId && now - player.lastSeen > 15 * 60000) this.players.delete(id);
    const sessionToken = token ?? randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
    const boundPlayer = [...this.players.values()].find(candidate => candidate.socketId === socketId);
    if (boundPlayer && boundPlayer.record.token_hash !== tokenHash) throw new RequestError('This connection has already joined the room.', 'session-active');
    let record = this.database.prepare('SELECT * FROM players WHERE token_hash = ?').get(tokenHash) as unknown as PlayerRecord | undefined;
    if (token && !record) throw new RequestError('Your previous session expired. Join again.', 'session');
    let player = record ? this.players.get(record.id) : undefined;
    if (player?.socketId && player.socketId !== socketId) throw new RequestError('This player is already open in another tab.', 'session-active');
    if (!player?.socketId && this.online >= 50) throw new RequestError('The room has 50 players. A spot opens when someone leaves.', 'full');
    if (!record) {
      if (this.records().length >= 500) throw new RequestError('This workshop has reached its registration limit.', 'full');
      if (text !== undefined && text.length === 0) throw new RequestError('Enter some text to make your token blocks.', 'token-setup');
      record = { id: randomUUID(), token_hash: tokenHash, name, best_score: 0, best_lines: 0, best_level: 1, metrics: JSON.stringify(emptyMetrics()), attempts: 0, updated: now, token_text: text ?? '', token_limit: DEFAULT_TOKEN_ALLOWANCE };
    }
    if (!player) {
      player = { record, metrics: { ...emptyMetrics(), ...JSON.parse(record.metrics) }, game: this.gameFor(record.token_text), runId: randomUUID(), started: now, sequence: 0, socketId: null, lastSeen: now, inputWindow: now, inputCount: 0 };
      this.players.set(record.id, player);
    }
    if (classic && player.record.token_text) {
      player.game = this.gameFor('');
      player.record.token_text = '';
      player.runId = randomUUID();
      player.started = now;
      player.sequence = 0;
      player.inputWindow = now;
      player.inputCount = 0;
    }
    player.socketId = socketId;
    player.lastSeen = now;
    this.save(player);
    return this.joinResult(player, sessionToken);
  }

  joinResult(player: Player, token = ''): JoinResult {
    return { token, playerId: player.record.id, name: player.record.name, runId: player.runId, sequence: player.sequence, replay: player.game.replay(), ...this.usage(player), tokenText: player.record.token_text };
  }

  usage(player: Player): PlayerUsage {
    const unmeteredRequests = Math.max(0, player.record.attempts - player.metrics.requests);
    const reserved = this.pendingTokens.get(player.record.id) ?? 0;
    const unconfirmed = Math.max(0, unmeteredRequests - Number(reserved > 0)) * MAX_REQUEST_TOKENS;
    return { metrics: { ...player.metrics }, unmeteredRequests, allowance: tokenAllowance(player.record.token_limit, player.metrics, reserved, unconfirmed) };
  }

  roomAllowance(totals = this.totals()) {
    const unconfirmed = Math.max(0, totals.attempts - totals.metrics.requests - this.pendingTokens.size) * MAX_REQUEST_TOKENS;
    return tokenAllowance(ROOM_TOKEN_BUDGET, totals.metrics, this.gate.reserved, unconfirmed);
  }

  playerFor(socketId: string) {
    const player = [...this.players.values()].find(candidate => candidate.socketId === socketId);
    if (!player) throw new RequestError('Join the room first.', 'session');
    return player;
  }

  disconnect(socketId: string) {
    const player = [...this.players.values()].find(candidate => candidate.socketId === socketId);
    if (!player) return;
    if (player.game.status === 'playing') player.game.act('pause');
    player.socketId = null;
    player.lastSeen = Date.now();
    if (!this.resetting) this.save(player);
  }

  inputs(player: Player, batch: InputBatch, now = Date.now()): InputAck {
    this.assertAvailable(player);
    if (batch.runId !== player.runId) throw new RequestError('This input belongs to an earlier game. Reconnect to sync.', 'resync');
    if (batch.sequence <= player.sequence) return this.ack(player);
    if (batch.sequence !== player.sequence + 1) throw new RequestError('An input batch is missing. Reconnect to sync.', 'resync');
    if (batch.frame < player.game.frame || batch.frame - player.game.frame > FPS * 60 || batch.frame > Math.floor((now - player.started) * FPS / 1000) + 120) throw new RequestError('The game clock is out of sync.', 'resync');
    let previousFrame = player.game.frame;
    for (const event of batch.events) {
      if (event.frame < previousFrame || event.frame > batch.frame) throw new RequestError('Inputs must be ordered by game frame.', 'resync');
      previousFrame = event.frame;
    }
    if (player.game.events.length + batch.events.length > 20000) throw new RequestError('This game reached its input limit. Start a new game.', 'limit');
    if (now - player.inputWindow >= 10000) { player.inputWindow = now; player.inputCount = 0; }
    if (player.inputCount + batch.events.length > 600) throw new RequestError('Too many game inputs.', 'rate');
    player.inputCount += batch.events.length;
    for (const event of batch.events) { player.game.advanceTo(event.frame); player.game.act(event.action); }
    player.game.advanceTo(batch.frame);
    player.sequence = batch.sequence;
    player.lastSeen = now;
    if (player.game.score > player.record.best_score) {
      player.record.best_score = player.game.score;
      player.record.best_lines = player.game.lines;
      player.record.best_level = player.game.level;
      player.record.updated = now;
      this.save(player);
    }
    return this.ack(player);
  }

  ack(player: Player): InputAck {
    return { sequence: player.sequence, score: player.game.score, lines: player.game.lines, pieceId: player.game.pieceId, frame: player.game.frame };
  }

  restart(player: Player, text?: string) {
    this.assertAvailable(player);
    const now = Date.now();
    if (now - player.started < 2000) throw new RequestError('Wait a moment before restarting.', 'cooldown', 2000);
    if (text !== undefined && text.length === 0) throw new RequestError('Enter some text to make your token blocks.', 'token-setup');
    const tokenText = text ?? player.record.token_text;
    player.game = this.gameFor(tokenText);
    player.record.token_text = tokenText;
    player.runId = randomUUID();
    player.started = now;
    player.sequence = 0;
    player.inputCount = 0;
    player.inputWindow = now;
    this.save(player);
    return this.joinResult(player);
  }

  inspect(player: Player, now = Date.now()): PromptPreview {
    if (now - (this.previewTimes.get(player.record.id) ?? -Infinity) < 1000) throw new RequestError('Preview is cooling down. Try again in a moment.', 'cooldown', 1000);
    this.previewTimes.set(player.record.id, now);
    const prompts = buildPrompts(player.game, placementsFor(player.game));
    const overhead = PREFIX_TOKENS + MAX_OUTPUT_TOKENS + 1024;
    return {
      runId: player.runId, pieceId: player.game.pieceId, rawTokens: prompts.rawTokens,
      packedTokens: prompts.packedTokens, prefixTokens: PREFIX_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS,
      rawReservation: overhead + prompts.rawTokens, packedReservation: overhead + prompts.packedTokens,
    };
  }

  async assist(player: Player, options: AiOptions) {
    this.assertAvailable(player);
    if (player.game.status === 'over') throw new RequestError('Start a new game before asking Luna.', 'game-over');
    const totals = this.totals();
    if (totals.attempts >= ROOM_REQUEST_LIMIT) throw new RequestError(`The room AI request allowance is used: 0 of ${ROOM_REQUEST_LIMIT.toLocaleString()} requests left. Manual play is still available.`, 'room-requests');
    const prompts = buildPrompts(player.game, placementsFor(player.game));
    const reservation = PREFIX_TOKENS + (options.compression ? prompts.packedTokens : prompts.rawTokens) + maxCompletionTokens(options) + 1024 + (options.mcp ? MAX_MCP_CONTEXT_TOKENS : 0);
    const allowance = this.usage(player).allowance;
    const roomAllowance = this.roomAllowance(totals);
    const release = this.gate.acquire(player.record.id, reservation, allowance.used + allowance.unconfirmed, roomAllowance.used + roomAllowance.unconfirmed, Date.now(), options.autopilot, allowance.limit);
    const runId = player.runId;
    this.pendingTokens.set(player.record.id, reservation);
    player.record.attempts += 1;
    try {
      this.save(player);
      const bucket = parseInt(player.record.id.slice(0, 2), 16) % 8;
      const insight = await this.gateway.complete(player.game, options, `${this.code}:${bucket}`);
      player.metrics = addUsage(player.metrics, insight.usage, insight.savedTokens, options.cache);
      const current = player.game.view();
      if (insight.status === 'ready' && (runId !== player.runId || insight.pieceId !== current.pieceId || current.status === 'over')) insight.status = 'stale';
      this.save(player);
      this.pendingTokens.delete(player.record.id);
      release();
      return { insight, ...this.usage(player) };
    } catch (error) {
      if (error instanceof McpLookupError) {
        player.record.attempts -= 1;
        this.save(player);
        throw new RequestError(error.message, error.reason === 'context' ? 'mcp-context' : 'mcp');
      }
      throw error;
    } finally { this.pendingTokens.delete(player.record.id); release(); }
  }

  publicUrl() {
    let configured = this.config.publicUrl;
    const file = path.join(this.config.dataDirectory, 'public-url.json');
    if (existsSync(file)) {
      try { configured = JSON.parse(readFileSync(file, 'utf8')).url; } catch { configured = undefined; }
    }
    if (!configured) return null;
    try {
      const url = new URL(configured);
      if (!['http:', 'https:'].includes(url.protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
      url.pathname = '/';
      url.search = '';
      url.hash = '';
      url.searchParams.set('room', this.code);
      return url.toString();
    } catch { return null; }
  }

  view(): RoomView {
    const rates = this.pricing.snapshot?.usdPerMillion;
    const totals = this.totals();
    const entries: LeaderboardEntry[] = this.records().map(record => {
      const metrics: Metrics = { ...emptyMetrics(), ...JSON.parse(record.metrics) };
      const unmeteredRequests = Math.max(0, record.attempts - metrics.requests);
      const costUsd = rates ? costForUsage(metrics, rates).total : null;
      return {
        id: record.id, name: record.name, score: record.best_score, costUsd, unmeteredRequests,
        challengeScore: costUsd !== null && unmeteredRequests === 0 ? pointsPerCent(record.best_score, costUsd) : null,
        lines: record.best_lines, level: record.best_level, online: Boolean(this.players.get(record.id)?.socketId), metrics,
      };
    });
    const leaderboard = [...entries].sort((first, second) => (second.challengeScore ?? -1) - (first.challengeScore ?? -1) || second.score - first.score || second.lines - first.lines).slice(0, 50);
    const pointsLeaderboard = entries.sort((first, second) => second.score - first.score || second.lines - first.lines).slice(0, 50);
    return {
      code: this.code, online: this.online, capacity: 50, leaderboard, pointsLeaderboard, metrics: totals.metrics,
      joinUrl: this.publicUrl(), model: this.config.deployment, prefixTokens: PREFIX_TOKENS,
      tokenBudget: ROOM_TOKEN_BUDGET, playerTokenBudget: DEFAULT_TOKEN_ALLOWANCE,
      allowance: this.roomAllowance(totals), requestsRemaining: Math.max(0, ROOM_REQUEST_LIMIT - totals.attempts),
      pricing: this.pricing, unmeteredRequests: Math.max(0, totals.attempts - totals.metrics.requests),
      aiCooldownMs: AI_COOLDOWN_MS, autopilotCooldownMs: AUTOPILOT_COOLDOWN_MS,
      ...(this.config.localMaintenance ? { maintenance: this.maintenanceStatus } : {}),
    };
  }

  close() { this.database.close(); }
}

export { AI_COOLDOWN_MS };