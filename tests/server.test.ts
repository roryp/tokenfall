import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { Game, placementsFor } from '../shared/game.ts';
import { emptyMetrics, tokenCreditsUsed } from '../shared/protocol.ts';
import type { Insight, JoinResult, Reply, RoomView, TokenPricing } from '../shared/protocol.ts';
import { createApplication } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { AI_COOLDOWN_MS, ModelGate, PLAYER_TOKEN_BUDGET, PREFIX_TOKENS, ROOM_TOKEN_BUDGET } from '../server/model.ts';
import type { ModelGateway } from '../server/model.ts';
import { Room } from '../server/room.ts';
import { buildPrompts, gameTokens } from '../server/tokens.ts';

function fixture() {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'tokenfall-test-'));
  const config = { port: 3100, endpoint: 'https://test.openai.azure.com', deployment: 'test-only', tenantId: 'test', dataDirectory };
  const gateway: ModelGateway = { complete: async game => insightFor(game) };
  const pricing: TokenPricing = { status: 'live', snapshot: {
    model: 'gpt-5.6-luna', region: 'eastus2', sku: 'GlobalStandard', currency: 'USD',
    usdPerMillion: { input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20 },
    checkedAt: '2026-09-11T00:00:00.000Z', sourceUrl: 'https://prices.azure.com/api/retail/prices',
    meters: {
      input: { id: 'input', name: 'Input fixture', effectiveFrom: '2026-08-01T00:00:00Z' },
      cachedInput: { id: 'cached', name: 'Cache read fixture', effectiveFrom: '2026-08-01T00:00:00Z' },
      cacheWrite: { id: 'write', name: 'Cache write fixture', effectiveFrom: '2026-08-01T00:00:00Z' },
      output: { id: 'output', name: 'Output fixture', effectiveFrom: '2026-08-01T00:00:00Z' },
    },
  } };
  return { dataDirectory, config, gateway, pricing };
}
function insightFor(game: Game): Insight {
  return {
    id: 'test-result', pieceId: game.pieceId, placement: { column: 3, row: 20, rotation: 0 }, tip: 'Test fixture.', status: 'ready',
    usage: { input: 2000, output: 20, total: 2020, cached: 1500, cacheWrites: 0, reasoning: 0 },
    latencyMs: 10, rawTokens: 5000, packedTokens: 1000, savedTokens: 4000, compression: true, cacheEnabled: true,
    prompt: 'Test prompt', outputText: '{}', inputChips: [], outputChips: [],
  };
}

test('inference gate enforces concurrency, cooldown and token budgets', () => {
  const gate = new ModelGate();
  const releases = Array.from({ length: 4 }, (_, index) => gate.acquire(`player-${index}`, 3000, 0, 0, 0));
  assert.throws(() => gate.acquire('fifth', 3000, 0, 0, 0));
  releases[0]();
  releases[0]();
  assert.equal(gate.inFlight, 3);
  assert.throws(() => gate.acquire('player-0', 3000, 0, 0, 1000));
  releases.slice(1).forEach(release => release());
  assert.throws(() => gate.acquire('budget', 3000, PLAYER_TOKEN_BUDGET, 0, 10000));
  assert.throws(() => gate.acquire('room', 3000, 0, ROOM_TOKEN_BUDGET, 10000));
  assert.equal(gate.reserved, 0);
});

test('container settings enable external binding and managed identity without changing local defaults', () => {
  const settings = { AZURE_OPENAI_ENDPOINT: 'https://test.openai.azure.com', AZURE_OPENAI_DEPLOYMENT: 'test', AZURE_TENANT_ID: 'tenant' };
  const local = loadConfig(settings);
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.sqliteJournalMode, 'WAL');
  const cloud = loadConfig({ ...settings, HOST: '0.0.0.0', PORT: '3100', AZURE_CLIENT_ID: 'managed-identity', DATA_DIRECTORY: os.tmpdir(), SQLITE_JOURNAL_MODE: 'DELETE' });
  assert.equal(cloud.host, '0.0.0.0');
  assert.equal(cloud.managedIdentityClientId, 'managed-identity');
  assert.equal(cloud.dataDirectory, path.resolve(os.tmpdir()));
  assert.equal(cloud.sqliteJournalMode, 'DELETE');
  assert.throws(() => loadConfig({ ...settings, SQLITE_JOURNAL_MODE: 'invalid' }));
  assert.throws(() => loadConfig({ ...settings, HOST: 'invalid' }));
});

test('token setup is authoritative, private, replayable, and persistent without resetting spend', () => {
  const setup = fixture();
  let room = new Room(setup.config, setup.gateway);
  try {
    const text = 'antidisestablishmentarianism hello world!';
    const joined = room.join('Token Player', room.code, undefined, 'socket', text);
    const player = room.playerFor('socket');
    assert.deepEqual(joined.replay.tokens, gameTokens(text));
    assert.equal(joined.tokenText, text);
    const client = Game.restore(joined.replay);
    client.act('hold');
    client.act('hardDrop');
    client.act('pause');
    room.inputs(player, { runId: joined.runId, sequence: 1, frame: 0, events: client.events });
    assert.deepEqual(player.game.view(), client.view());
    assert.ok(!JSON.stringify(room.view()).includes(text));
    player.metrics.input = 1234;
    room.save(player);
    room.disconnect('socket');
    const resumed = room.join('Token Player', room.code, joined.token, 'resumed', 'ignored replacement');
    assert.equal(resumed.tokenText, text);
    room.close();
    room = new Room(setup.config, setup.gateway);
    const restored = room.join('Token Player', room.code, joined.token, 'restored');
    assert.equal(restored.tokenText, text);
    const current = room.playerFor('restored');
    current.started -= 3000;
    const next = room.restart(current, 'New tokens.');
    assert.deepEqual(next.replay.tokens, gameTokens('New tokens.'));
    assert.equal(next.metrics.input, 1234);
    assert.throws(() => room.restart(current, ''), /Wait|Enter/);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('existing databases gain token setup without losing sessions, scores, or usage', () => {
  const setup = fixture();
  let room = new Room(setup.config, setup.gateway);
  try {
    const joined = room.join('Legacy Record', room.code, undefined, 'socket');
    const player = room.playerFor('socket');
    player.record.best_score = 987;
    player.record.attempts = 2;
    player.metrics = { ...emptyMetrics(), requests: 2, input: 4321, output: 40 };
    room.save(player);
    room.database.exec('ALTER TABLE players DROP COLUMN token_text');
    room.close();
    room = new Room(setup.config, setup.gateway);
    const restored = room.join('Legacy Record', room.code, joined.token, 'restored');
    assert.equal(restored.playerId, joined.playerId);
    assert.equal(restored.tokenText, '');
    assert.equal(room.view().leaderboard[0].score, 987);
    assert.equal(restored.metrics.input, 4321);
    assert.equal(room.playerFor('restored').record.attempts, 2);
    assert.equal(room.database.prepare('PRAGMA table_info(players)').all().filter(column => column.name === 'token_text').length, 1);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('socket setup rejects forged token IDs, over-limit sequences, and invalid fast-mode requests', async () => {
  const setup = fixture();
  const application = createApplication(setup.config, setup.gateway);
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address() as { port: number };
  const client = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
  try {
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    const forged = await client.timeout(5000).emitWithAck('join', { name: 'Forged', room: application.room.code, text: 'hello', tokens: [{ id: 0, text: 'I only' }] });
    assert.equal(forged.ok, false);
    const oversized = await client.timeout(5000).emitWithAck('join', { name: 'Oversized', room: application.room.code, text: '\u0378'.repeat(500) });
    assert.equal(oversized.ok, false);
    assert.equal(application.room.records().length, 0);
    const joined = await client.timeout(5000).emitWithAck('join', { name: 'Real Tokens', room: application.room.code, text: 'hello world' });
    assert.equal(joined.ok, true);
    assert.deepEqual(joined.data.replay.tokens, gameTokens('hello world'));
    const badMode = await client.timeout(5000).emitWithAck('assist', { cache: true, compression: true, autopilot: 'yes' });
    assert.equal(badMode.ok, false);
    const player = application.room.playerFor(client.id!);
    assert.equal(player.record.attempts, 0);
    player.started -= 3000;
    const badSetup = await client.timeout(5000).emitWithAck('configure', { text: 'new', tokens: [{ id: 0, text: 'fake' }] });
    assert.equal(badSetup.ok, false);
    assert.equal(player.record.token_text, 'hello world');
  } finally { client.disconnect(); await application.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('fast autopilot remains single-flight, paced, and bound by the same budgets', () => {
  const gate = new ModelGate();
  const release = gate.acquire('pilot', 3000, 0, 0, 0, true);
  assert.throws(() => gate.acquire('pilot', 3000, 0, 0, 1500, true), /already/);
  release();
  assert.throws(() => gate.acquire('pilot', 3000, 0, 0, 999, true), /cooling/);
  assert.doesNotThrow(() => gate.acquire('pilot', 3000, 0, 0, 1000, true)());
  assert.throws(() => gate.acquire('pilot', 3000, PLAYER_TOKEN_BUDGET, 0, 2000, true), /credits/);
});

test('single-instance rollback journal storage retains scores across process restarts', () => {
  const setup = fixture();
  const config = { ...setup.config, sqliteJournalMode: 'DELETE' as const };
  let room = new Room(config, setup.gateway);
  try {
    assert.equal(room.database.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
    const joined = room.join('Persistent Container', room.code, undefined, 'socket');
    const player = room.playerFor('socket');
    room.inputs(player, { runId: joined.runId, sequence: 1, frame: 0, events: [{ frame: 0, action: 'hardDrop' }] });
    const score = room.view().leaderboard[0].score;
    room.close();
    room = new Room(config, setup.gateway);
    assert.equal(room.view().leaderboard[0].score, score);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('a tight credit bank permits one raw request and substantially more compressed and cached requests', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 20000 });
  const requestCounts: number[] = [];
  for (const options of [{ compression: false, cache: false }, { compression: true, cache: false }, { compression: true, cache: true }]) {
    const setup = fixture();
    let requests = 0;
    const gateway: ModelGateway = { complete: async game => {
      const prompts = buildPrompts(game, placementsFor(game));
      const input = PREFIX_TOKENS + (options.compression ? prompts.packedTokens : prompts.rawTokens);
      const cached = options.cache && requests > 0 ? PREFIX_TOKENS : 0;
      requests += 1;
      return {
        ...insightFor(game), compression: options.compression, cacheEnabled: options.cache,
        savedTokens: options.compression ? prompts.rawTokens - prompts.packedTokens : 0,
        usage: { input, output: 20, total: input + 20, cached, cacheWrites: options.cache && !cached ? PREFIX_TOKENS : 0, reasoning: 0 },
      };
    } };
    const room = new Room(setup.config, gateway);
    try {
      room.join('Budget Player', room.code, undefined, 'socket');
      const player = room.playerFor('socket');
      player.game = new Game('compression');
      for (let attempt = 0; attempt < 20; attempt += 1) {
        context.mock.timers.tick(AI_COOLDOWN_MS);
        try { await room.assist(player, options); }
        catch (error) { assert.equal((error as { code: string }).code, 'budget'); break; }
      }
      assert.ok(tokenCreditsUsed(player.metrics) <= PLAYER_TOKEN_BUDGET);
      assert.equal(room.view().metrics.input + room.view().metrics.output, player.metrics.input + player.metrics.output);
      const spent = tokenCreditsUsed(player.metrics);
      room.restart(player);
      assert.equal(tokenCreditsUsed(player.metrics), spent);
      requestCounts.push(requests);
    } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
  }
  assert.deepEqual(requestCounts, [1, 4, 7]);
});

test('real priced usage determines the efficiency leaderboard while base scores remain intact', async () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    room.pricing = setup.pricing;
    room.join('Raw Player', room.code, undefined, 'raw');
    room.join('Efficient Player', room.code, undefined, 'efficient');
    const raw = room.playerFor('raw');
    const efficient = room.playerFor('efficient');
    raw.record.best_score = 150;
    raw.record.attempts = 1;
    raw.metrics = { ...emptyMetrics(), requests: 1, input: 2000, output: 20 };
    efficient.record.best_score = 100;
    room.save(raw);
    room.save(efficient);
    assert.equal(room.view().leaderboard[0].name, 'Raw Player');
    await room.assist(efficient, { cache: true, compression: true });
    const winner = room.view().leaderboard[0];
    assert.equal(winner.name, 'Efficient Player');
    assert.equal(winner.score, 100);
    assert.ok(Math.abs(winner.costUsd! - 0.000154) < 1e-12);
    assert.ok(Math.abs(winner.challengeScore! - 100 * 0.01 / 0.000154) < 1e-6);
    assert.ok(winner.challengeScore! > room.view().leaderboard[1].challengeScore!);
    assert.equal(tokenCreditsUsed(winner.metrics), 520);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('missing rates, zero spend, and missing provider usage cannot produce a cost-ranked score', async () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    room.join('Cost Player', room.code, undefined, 'socket');
    const player = room.playerFor('socket');
    player.record.best_score = 1000;
    room.save(player);
    assert.equal(room.view().leaderboard[0].costUsd, null);
    assert.equal(room.view().leaderboard[0].challengeScore, null);
    room.pricing = setup.pricing;
    assert.equal(room.view().leaderboard[0].costUsd, 0);
    assert.equal(room.view().leaderboard[0].challengeScore, null);
    await room.assist(player, { compression: true, cache: true });
    const ranked = room.view().leaderboard[0].challengeScore;
    assert.ok(ranked! > 0);
    room.pricing = { ...setup.pricing, status: 'stale' };
    assert.equal(room.view().leaderboard[0].challengeScore, ranked);
    assert.equal(room.view().pricing.status, 'stale');
    player.record.attempts += 1;
    room.save(player);
    assert.equal(room.view().leaderboard[0].challengeScore, null);
    assert.equal(room.view().leaderboard[0].unmeteredRequests, 1);
    assert.equal(room.view().unmeteredRequests, 1);
    assert.ok(room.view().leaderboard[0].costUsd! > 0);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('room verifies input replay, rejects speed-ups and ignores duplicate batches', () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    const joined = room.join('Player One', room.code, undefined, 'socket-1');
    const player = room.playerFor('socket-1');
    const client = Game.restore(joined.replay);
    client.act('left');
    client.act('hardDrop');
    const batch = { runId: joined.runId, sequence: 1, frame: 0, events: client.events };
    const verified = room.inputs(player, batch);
    assert.equal(verified.score, client.score);
    assert.equal(room.inputs(player, batch).score, client.score);
    assert.throws(() => room.inputs(player, { ...batch, sequence: 2, frame: 50000, events: [] }));
    assert.equal(player.sequence, 1);
    assert.equal(room.view().leaderboard[0].score, client.score);
    room.disconnect('socket-1');
    const resumed = room.join('Player One', room.code, joined.token, 'socket-2');
    assert.equal(resumed.playerId, joined.playerId);
    assert.equal(Game.restore(resumed.replay).score, client.score);
    assert.equal(Game.restore(resumed.replay).status, 'paused');
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('fifty players can join, one connection cannot claim multiple seats, and disconnect releases a seat', () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    for (let index = 0; index < 50; index += 1) room.join(`Player ${index}`, room.code, undefined, `socket-${index}`);
    assert.equal(room.online, 50);
    assert.throws(() => room.join('Extra Player', room.code, undefined, 'socket-51'));
    assert.throws(() => room.join('Duplicate', room.code, undefined, 'socket-0'));
    room.disconnect('socket-0');
    room.join('New Player', room.code, undefined, 'socket-51');
    assert.equal(room.online, 50);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('verbose prompts cannot exceed the rolling token-throughput allowance', () => {
  const gate = new ModelGate();
  for (let index = 0; index < 25; index += 1) gate.acquire(`player-${index}`, 16000, 0, 0, 0)();
  assert.throws(() => gate.acquire('overflow', 1000, 0, 0, 1));
  assert.doesNotThrow(() => gate.acquire('later', 1000, 0, 0, 60001)());
});

test('stale model responses are billed but cannot become current-piece suggestions', async () => {
  const setup = fixture();
  let finish!: (insight: Insight) => void;
  let original!: Insight;
  const gateway: ModelGateway = { complete: game => { original = insightFor(game); return new Promise(resolve => { finish = resolve; }); } };
  const room = new Room(setup.config, gateway);
  try {
    room.join('Late Reply', room.code, undefined, 'socket');
    const player = room.playerFor('socket');
    const pending = room.assist(player, { cache: true, compression: true });
    player.game.act('hardDrop');
    finish(original);
    const result = await pending;
    assert.equal(result.insight.status, 'stale');
    assert.equal(result.metrics.input, 2000);
    assert.equal(result.metrics.cached, 1500);
    assert.equal(player.game.pieces, 1);
    assert.equal(room.gate.inFlight, 0);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('leaderboard and request allowances persist across server restarts', () => {
  const setup = fixture();
  let room = new Room(setup.config, setup.gateway);
  try {
    const joined = room.join('Persistent', room.code, undefined, 'socket');
    const player = room.playerFor('socket');
    player.record.attempts = 7;
    player.metrics = { ...emptyMetrics(), input: 3000 };
    room.inputs(player, { runId: joined.runId, sequence: 1, frame: 0, events: [{ frame: 0, action: 'hardDrop' }] });
    const expected = room.view().leaderboard[0].score;
    const code = room.code;
    room.close();
    room = new Room(setup.config, setup.gateway);
    assert.equal(room.code, code);
    assert.equal(room.view().leaderboard[0].score, expected);
    room.join('Persistent', code, joined.token, 'new-socket');
    assert.equal(room.playerFor('new-socket').record.attempts, 7);
    assert.equal(room.playerFor('new-socket').metrics.input, 3000);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('public room data never exposes player session credentials and does not publish localhost QR codes', () => {
  const setup = fixture();
  const room = new Room({ ...setup.config, publicUrl: 'http://localhost:3100' }, setup.gateway);
  try {
    const joined = room.join('Private Token', room.code, undefined, 'socket');
    assert.ok(!JSON.stringify(room.view()).includes(joined.token));
    assert.ok(!JSON.stringify(room.view()).includes('token_hash'));
    assert.equal(room.view().joinUrl, null);
    room.config.publicUrl = 'https://audience.example.com';
    assert.equal(new URL(room.view().joinUrl!).searchParams.get('room'), room.code);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('live sockets broadcast verified scores to a spectator and reject score injection', async () => {
  const setup = fixture();
  const application = createApplication(setup.config, setup.gateway);
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const player = connect(url, { transports: ['websocket'], forceNew: true });
  const spectator = connect(url, { transports: ['websocket'], forceNew: true });
  try {
    await Promise.all([new Promise<void>(resolve => player.on('connect', resolve)), new Promise<void>(resolve => spectator.on('connect', resolve))]);
    const joined = await player.emitWithAck('join', { name: 'Live Player', room: application.room.code }) as Reply<JoinResult>;
    assert.ok(joined.ok);
    const invalid = await player.emitWithAck('inputs', { runId: joined.data.runId, sequence: 1, frame: 0, events: [], score: 9999999 });
    assert.equal(invalid.ok, false);
    const observed = new Promise<RoomView>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Leaderboard did not update.')), 3000);
      spectator.on('room', room => { if (room.leaderboard.some((entry: { score: number }) => entry.score > 0)) { clearTimeout(timer); resolve(room); } });
    });
    const moved = await player.emitWithAck('inputs', { runId: joined.data.runId, sequence: 1, frame: 0, events: [{ frame: 0, action: 'hardDrop' }] });
    assert.equal(moved.ok, true);
    const room = await observed;
    assert.ok(room.leaderboard[0].score > 0);
    assert.ok(room.leaderboard[0].score < 100);
    const health = await fetch(`${url}/api/health`).then(response => response.json()) as { reasoning: string };
    assert.equal(health.reasoning, 'none');
  } finally { player.disconnect(); spectator.disconnect(); await application.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('fifty simultaneous sockets can join, play and receive the complete live leaderboard', async () => {
  const setup = fixture();
  const application = createApplication(setup.config, setup.gateway);
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address() as { port: number };
  const clients = Array.from({ length: 50 }, () => connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true }));
  try {
    await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); })));
    const joined = await Promise.all(clients.map((client, index) => client.timeout(5000).emitWithAck('join', { name: `Audience ${index}`, room: application.room.code }))) as Reply<JoinResult>[];
    assert.ok(joined.every(result => result.ok));
    assert.equal(application.room.online, 50);
    const observed = new Promise<RoomView>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The full audience leaderboard did not arrive.')), 5000);
      clients[0].on('room', room => {
        if (room.leaderboard.length === 50 && room.leaderboard.every((entry: { score: number }) => entry.score > 0)) { clearTimeout(timer); resolve(room); }
      });
    });
    const acknowledgments = await Promise.all(clients.map((client, index) => {
      const result = joined[index];
      if (!result.ok) throw new Error('Join failed.');
      return client.timeout(5000).emitWithAck('inputs', { runId: result.data.runId, sequence: 1, frame: 0, events: [{ frame: 0, action: 'hardDrop' }] });
    }));
    assert.ok(acknowledgments.every(result => result.ok));
    const broadcast = await observed;
    assert.equal(broadcast.online, 50);
    assert.ok(broadcast.leaderboard.every(entry => entry.online));
    assert.equal(new Set(broadcast.leaderboard.map(entry => entry.score)).size, 1);
  } finally { clients.forEach(client => client.disconnect()); await application.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});