import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Game, FPS, placementsFor } from '../shared/game.ts';
import { emptyMetrics } from '../shared/protocol.ts';
import type { AiOptions, InputAck, InputBatch, JoinResult, LeaderboardEntry, Metrics, RoomView } from '../shared/protocol.ts';
import type { AppConfig } from './config.ts';
import { AI_COOLDOWN_MS, MAX_OUTPUT_TOKENS, ModelGate, PLAYER_TOKEN_BUDGET, PREFIX_TOKENS, ROOM_TOKEN_BUDGET, RequestError } from './model.ts';
import type { ModelGateway } from './model.ts';
import { addUsage, buildPrompts } from './tokens.ts';

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
  config: AppConfig;
  gateway: ModelGateway;

  constructor(config: AppConfig, gateway: ModelGateway) {
    this.config = config;
    this.gateway = gateway;
    mkdirSync(config.dataDirectory, { recursive: true });
    this.database = new DatabaseSync(path.join(config.dataDirectory, 'tokenfall.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        best_score INTEGER NOT NULL DEFAULT 0, best_lines INTEGER NOT NULL DEFAULT 0,
        best_level INTEGER NOT NULL DEFAULT 1, metrics TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL
      );
    `);
    const saved = this.database.prepare("SELECT value FROM settings WHERE key = 'room'").get() as { value: string } | undefined;
    this.code = saved?.value ?? randomBytes(3).toString('hex').toUpperCase();
    if (!saved) this.database.prepare("INSERT INTO settings (key, value) VALUES ('room', ?)").run(this.code);
  }

  get online() { return [...this.players.values()].filter(player => player.socketId !== null).length; }
  records() { return this.database.prepare('SELECT * FROM players ORDER BY best_score DESC, best_lines DESC, updated ASC').all() as unknown as PlayerRecord[]; }

  save(player: Player) {
    player.record.metrics = JSON.stringify(player.metrics);
    const record = player.record;
    this.database.prepare(`INSERT INTO players (id, token_hash, name, best_score, best_lines, best_level, metrics, attempts, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, best_score=excluded.best_score, best_lines=excluded.best_lines,
      best_level=excluded.best_level, metrics=excluded.metrics, attempts=excluded.attempts, updated=excluded.updated`)
      .run(record.id, record.token_hash, record.name, record.best_score, record.best_lines, record.best_level, record.metrics, record.attempts, record.updated);
  }

  totals() {
    const metrics = emptyMetrics();
    let attempts = 0;
    for (const record of this.records()) {
      const saved = JSON.parse(record.metrics) as Metrics;
      for (const key of Object.keys(metrics) as (keyof Metrics)[]) metrics[key] += saved[key];
      attempts += record.attempts;
    }
    return { metrics, attempts };
  }

  join(name: string, code: string, token: string | undefined, socketId: string): JoinResult {
    if (code !== this.code) throw new RequestError('That room code is not active.', 'room');
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
      record = { id: randomUUID(), token_hash: tokenHash, name, best_score: 0, best_lines: 0, best_level: 1, metrics: JSON.stringify(emptyMetrics()), attempts: 0, updated: now };
    }
    if (!player) {
      player = { record, metrics: JSON.parse(record.metrics), game: new Game(`tokenfall:${this.code}`), runId: randomUUID(), started: now, sequence: 0, socketId: null, lastSeen: now, inputWindow: now, inputCount: 0 };
      this.players.set(record.id, player);
    }
    player.socketId = socketId;
    player.lastSeen = now;
    this.save(player);
    return this.joinResult(player, sessionToken);
  }

  joinResult(player: Player, token = ''): JoinResult {
    return { token, playerId: player.record.id, name: player.record.name, runId: player.runId, sequence: player.sequence, replay: player.game.replay(), metrics: { ...player.metrics } };
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
    this.save(player);
  }

  inputs(player: Player, batch: InputBatch, now = Date.now()): InputAck {
    if (batch.runId !== player.runId) throw new RequestError('This input belongs to an earlier game. Reconnect to sync.', 'resync');
    if (batch.sequence <= player.sequence) return this.ack(player);
    if (batch.sequence !== player.sequence + 1) throw new RequestError('An input batch is missing. Reconnect to sync.', 'resync');
    if (batch.frame < player.game.frame || batch.frame > Math.min(216000, Math.floor((now - player.started) * FPS / 1000) + 120)) throw new RequestError('The game clock is out of sync.', 'resync');
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

  restart(player: Player) {
    const now = Date.now();
    if (now - player.started < 2000) throw new RequestError('Wait a moment before restarting.', 'cooldown', 2000);
    player.game = new Game(`tokenfall:${this.code}`);
    player.runId = randomUUID();
    player.started = now;
    player.sequence = 0;
    player.inputCount = 0;
    player.inputWindow = now;
    return this.joinResult(player);
  }

  async assist(player: Player, options: AiOptions) {
    if (player.game.status === 'over') throw new RequestError('Start a new game before asking Luna.', 'game-over');
    const totals = this.totals();
    if (player.record.attempts >= 40 || totals.attempts >= 1000) throw new RequestError('The AI request allowance is used. Manual play is still available.', 'budget');
    const prompts = buildPrompts(player.game, placementsFor(player.game));
    const reservation = PREFIX_TOKENS + (options.compression ? prompts.packedTokens : prompts.rawTokens) + MAX_OUTPUT_TOKENS + 1024;
    const release = this.gate.acquire(player.record.id, reservation, player.metrics.input + player.metrics.output, totals.metrics.input + totals.metrics.output);
    const runId = player.runId;
    player.record.attempts += 1;
    this.save(player);
    try {
      const bucket = parseInt(player.record.id.slice(0, 2), 16) % 8;
      const insight = await this.gateway.complete(player.game, options, `${this.code}:${bucket}`);
      player.metrics = addUsage(player.metrics, insight.usage, insight.savedTokens);
      const current = player.game.view();
      if (insight.status === 'ready' && (runId !== player.runId || insight.pieceId !== current.pieceId || current.status === 'over')) insight.status = 'stale';
      this.save(player);
      return { insight, metrics: { ...player.metrics } };
    } finally { release(); }
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
    const leaderboard: LeaderboardEntry[] = this.records().slice(0, 50).map(record => ({
      id: record.id, name: record.name, score: record.best_score, lines: record.best_lines, level: record.best_level,
      online: Boolean(this.players.get(record.id)?.socketId), metrics: JSON.parse(record.metrics),
    }));
    return {
      code: this.code, online: this.online, capacity: 50, leaderboard, metrics: this.totals().metrics,
      joinUrl: this.publicUrl(), model: this.config.deployment, prefixTokens: PREFIX_TOKENS,
      tokenBudget: ROOM_TOKEN_BUDGET, playerTokenBudget: PLAYER_TOKEN_BUDGET,
    };
  }

  close() { this.database.close(); }
}

export { AI_COOLDOWN_MS };