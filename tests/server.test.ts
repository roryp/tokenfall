import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { TETROMINOES } from 'miaoda-game-fallblock-core';
import { Game, placementsFor } from '../shared/game.ts';
import { emptyMetrics, tokenCreditsUsed } from '../shared/protocol.ts';
import type { Insight, JoinResult, Reply, RoomView, TokenPricing } from '../shared/protocol.ts';
import { createApplication } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { AI_COOLDOWN_MS, AUTOPILOT_COOLDOWN_MS, LunaGateway, MAX_OUTPUT_TOKENS, ModelGate, PLAYER_REQUEST_LIMIT, PLAYER_TOKEN_BUDGET, POLICY, PREFIX_TOKENS, ROOM_TOKEN_BUDGET } from '../server/model.ts';
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

test('the gateway passes Luna\'s Hold choice unchanged and never substitutes an invalid model choice', async context => {
  const setup = fixture();
  const gateway = new LunaGateway(setup.config);
  const game = new Game('gateway-hold');
  const before = game.view();
  const candidates = placementsFor(game);
  const selected = candidates.find(candidate => candidate.useHold && !candidate.gameOver)!;
  let selectedId = selected.id;
  let sent: unknown;
  const mock = context.mock.method(gateway['client'].chat.completions, 'create', async (request: unknown) => {
    sent = request;
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ placementId: selectedId, tip: 'Use the held piece.' }) } }], usage: { prompt_tokens: 4000, completion_tokens: 20, total_tokens: 4020, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } };
  });
  try {
    const insight = await gateway.complete(game, { compression: true, cache: false }, 'test');
    assert.equal(insight.status, 'ready');
    assert.deepEqual(insight.placement, { column: selected.column, row: selected.row, rotation: selected.rotation, piece: selected.piece, useHold: true });
    const request = JSON.parse(JSON.stringify(sent));
    assert.equal(insight.systemPrompt, POLICY);
    assert.equal(insight.systemPrompt, request.messages[0].content[0].text);
    const comparison = buildPrompts(game, candidates);
    assert.deepEqual(insight.promptComparison, { verbose: comparison.verbose, packed: comparison.packed });
    assert.equal(insight.promptComparison?.packed, request.messages[1].content);
    assert.equal(insight.rawTokens, comparison.rawTokens);
    assert.equal(insight.packedTokens, comparison.packedTokens);
    assert.equal(request.messages[0].content[0].prompt_cache_breakpoint, undefined);
    assert.deepEqual(JSON.parse(request.messages[1].content).placements.map((candidate: { id: string }) => candidate.id), candidates.map(candidate => candidate.id));
    assert.equal(request.reasoning_effort, 'none');
    assert.deepEqual(game.view(), before);
    selectedId = 'not-a-legal-placement';
    const invalid = await gateway.complete(new Game('different-board'), { compression: false, cache: true }, 'test');
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.placement, null);
    assert.equal(invalid.usage.total, 4020);
    assert.equal(invalid.systemPrompt, POLICY);
    assert.equal(invalid.promptComparison?.verbose, JSON.parse(JSON.stringify(sent)).messages[1].content);
    assert.equal(invalid.savedTokens, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(sent)).messages[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
    assert.deepEqual(JSON.parse(JSON.stringify(sent)).response_format, request.response_format);
    assert.equal(mock.mock.callCount(), 2);
  } finally { rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('all normal active and Hold combinations fit the request guard in both encodings', () => {
  assert.ok(PREFIX_TOKENS >= 1024);
  for (const active of TETROMINOES) for (const held of [null, ...TETROMINOES]) {
    const game = new Game('prompt-size');
    game.active = game.newPiece(active);
    game.held = held ? game.newPiece(held) : null;
    const prompts = buildPrompts(game, placementsFor(game));
    for (const count of [prompts.rawTokens, prompts.packedTokens]) {
      const reservation = PREFIX_TOKENS + count + MAX_OUTPUT_TOKENS + 1024;
      assert.ok(reservation <= 16000, `${active}/${held ?? 'empty'} needs ${reservation} reserved tokens`);
    }
  }
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

test('classic play replaces prototype token sequences without erasing usage and restarts with a fresh bag', () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    const original = room.join('Returning Player', room.code, undefined, 'old', 'Prototype pieces');
    const player = room.playerFor('old');
    player.metrics = { ...emptyMetrics(), requests: 1, input: 1234, output: 20 };
    player.record.attempts = 1;
    player.record.best_score = 120;
    room.disconnect('old');
    const joined = room.join('Returning Player', room.code, original.token, 'classic', undefined, true);
    assert.equal(joined.playerId, original.playerId);
    assert.notEqual(joined.runId, original.runId);
    assert.equal(joined.tokenText, '');
    assert.equal(joined.replay.tokens, undefined);
    assert.equal(joined.metrics.input, 1234);
    assert.equal(player.record.attempts, 1);
    assert.equal(player.record.best_score, 120);
    const client = Game.restore(joined.replay);
    const pieces = [];
    for (let index = 0; index < 7; index += 1) { pieces.push(client.piece); client.act('hardDrop'); }
    assert.equal(new Set(pieces).size, 7);
    room.inputs(player, { runId: joined.runId, sequence: 1, frame: 0, events: client.events });
    assert.deepEqual(player.game.view(), client.view());
    player.started -= 3000;
    const restarted = room.restart(player);
    assert.notEqual(restarted.replay.seed, joined.replay.seed);
    assert.equal(restarted.replay.tokens, undefined);
    assert.equal(restarted.metrics.input, 1234);
    assert.throws(() => room.join('Invalid', room.code, undefined, 'invalid', 'Text', true), /Classic/);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('cache outcomes persist without inventing hit or miss history for older usage', async () => {
  const setup = fixture();
  let room = new Room(setup.config, setup.gateway);
  try {
    const joined = room.join('Cache History', room.code, undefined, 'socket', undefined, true);
    const legacy = { requests: 2, input: 4500, output: 40, cached: 1500, cacheWrites: 1500, reasoning: 0, compressionSaved: 5000 };
    room.database.prepare('UPDATE players SET metrics = ?, attempts = ? WHERE id = ?').run(JSON.stringify(legacy), 2, joined.playerId);
    room.close();
    room = new Room(setup.config, setup.gateway);
    const restored = room.join('Cache History', room.code, joined.token, 'restored', undefined, true);
    assert.equal(restored.metrics.requests, 2);
    assert.equal(restored.metrics.cacheHits, 0);
    assert.equal(restored.metrics.cacheMisses, 0);
    assert.equal(restored.metrics.cacheBypassed, 0);
    assert.equal(room.totals().metrics.cacheHits, 0);
    await room.assist(room.playerFor('restored'), { compression: true, cache: true, autopilot: true });
    room.close();
    room = new Room(setup.config, setup.gateway);
    const after = room.join('Cache History', room.code, joined.token, 'after', undefined, true);
    assert.equal(after.metrics.requests, 3);
    assert.equal(after.metrics.cacheHits, 1);
    assert.equal(after.metrics.cacheMisses, 0);
    assert.equal(after.metrics.input, legacy.input + 2000);
    assert.equal(after.metrics.requests - after.metrics.cacheHits - after.metrics.cacheMisses - after.metrics.cacheBypassed, 2);
    assert.equal(room.totals().metrics.cacheHits, 1);
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

test('standard Luna play continues beyond prototype player limits while retaining the global spending guard', async () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    room.join('Continuous Player', room.code, undefined, 'socket', undefined, true);
    const player = room.playerFor('socket');
    player.record.attempts = PLAYER_REQUEST_LIMIT + 10;
    player.metrics = { ...emptyMetrics(), requests: player.record.attempts, input: PLAYER_TOKEN_BUDGET + 10000, output: 1000 };
    room.save(player);
    const result = await room.assist(player, { compression: true, cache: false, autopilot: true });
    assert.equal(result.metrics.requests, PLAYER_REQUEST_LIMIT + 11);
    assert.equal(player.record.attempts, PLAYER_REQUEST_LIMIT + 11);
    const gate = new ModelGate();
    assert.throws(() => gate.acquire('global', 3000, 0, ROOM_TOKEN_BUDGET, 0, true, ROOM_TOKEN_BUDGET), /room model token limit/);
    assert.throws(() => gate.acquire('large', 16001, 0, 0, 0, true, ROOM_TOKEN_BUDGET), /credits/);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
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

test('legacy token runs retain their original bank without erasing the cost of inefficient requests', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 20000 });
  const requestCounts: number[] = [];
  const creditsSpent: number[] = [];
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
      room.join('Budget Player', room.code, undefined, 'socket', 'Hello world! Tokens make my blocks.');
      const player = room.playerFor('socket');
      player.game = new Game('compression', gameTokens(player.record.token_text));
      for (let attempt = 0; attempt <= PLAYER_REQUEST_LIMIT; attempt += 1) {
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
      creditsSpent.push(spent);
    } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
  }
  assert.ok(requestCounts[0] < requestCounts[1]);
  assert.ok(requestCounts[1] <= requestCounts[2]);
  assert.ok(requestCounts.every(count => count <= PLAYER_REQUEST_LIMIT));
  assert.ok(creditsSpent[2] / requestCounts[2] < creditsSpent[1] / requestCounts[1]);
});

test('standard play permits thirty richer compressed requests after prior spend without cache hits', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 20000 });
  const setup = fixture();
  const gateway: ModelGateway = { complete: async game => {
    const prompts = buildPrompts(game, placementsFor(game));
    const input = PREFIX_TOKENS + prompts.packedTokens + 128;
    return {
      ...insightFor(game), cacheEnabled: false,
      usage: { input, output: MAX_OUTPUT_TOKENS, total: input + MAX_OUTPUT_TOKENS, cached: 0, cacheWrites: 0, reasoning: 0 },
    };
  } };
  const room = new Room(setup.config, gateway);
  try {
    room.join('Returning Pilot', room.code, undefined, 'socket', undefined, true);
    const player = room.playerFor('socket');
    player.record.attempts = 2;
    player.metrics = { ...emptyMetrics(), requests: 2, input: 15000, output: 100 };
    room.save(player);
    player.game.act('pause');
    for (let request = 0; request < 30; request += 1) {
      context.mock.timers.tick(AUTOPILOT_COOLDOWN_MS);
      const response = await room.assist(player, { cache: false, compression: true, autopilot: true });
      assert.equal(response.insight.status, 'ready');
    }
    assert.equal(player.metrics.requests, 32);
    assert.equal(player.metrics.cached, 0);
    assert.ok(tokenCreditsUsed(player.metrics) > 16000);
    assert.ok(tokenCreditsUsed(player.metrics) < ROOM_TOKEN_BUDGET);
    assert.equal(room.view().playerTokenBudget, 160000);
    assert.equal(room.view().metrics.input, player.metrics.input);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('free board comparisons use the same prompt encoding without spending tokens or moving pieces', () => {
  const setup = fixture();
  let modelCalls = 0;
  const room = new Room(setup.config, { complete: async game => { modelCalls += 1; return insightFor(game); } });
  try {
    room.join('Compare Player', room.code, undefined, 'socket', 'Tokens teach costs.');
    const player = room.playerFor('socket');
    player.game.act('pause');
    const before = player.game.view();
    const preview = room.inspect(player, 0);
    const prompts = buildPrompts(player.game, placementsFor(player.game));
    assert.equal(preview.rawTokens, prompts.rawTokens);
    assert.equal(preview.packedTokens, prompts.packedTokens);
    assert.ok(preview.packedTokens < preview.rawTokens);
    assert.equal(preview.rawReservation - preview.packedReservation, prompts.rawTokens - prompts.packedTokens);
    assert.equal(preview.runId, player.runId);
    assert.equal(preview.pieceId, player.game.pieceId);
    assert.equal(modelCalls, 0);
    assert.equal(player.record.attempts, 0);
    assert.deepEqual(player.metrics, emptyMetrics());
    assert.deepEqual(player.game.view(), before);
    assert.throws(() => room.inspect(player, 999), /cooling/);
    assert.doesNotThrow(() => room.inspect(player, 1000));
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
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

test('points ranking includes manual winners independently of the top fifty cost scores', () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    room.pricing = setup.pricing;
    for (let index = 0; index < 50; index += 1) {
      const socketId = `paid-${index}`;
      room.join(`Paid ${index}`, room.code, undefined, socketId);
      const player = room.playerFor(socketId);
      player.record.best_score = index + 1;
      player.record.attempts = 1;
      player.metrics = { ...emptyMetrics(), requests: 1, input: 100, output: 10 };
      room.save(player);
      room.disconnect(socketId);
    }
    room.join('Manual Winner', room.code, undefined, 'manual');
    const player = room.playerFor('manual');
    player.record.best_score = 5000;
    room.save(player);
    const view = room.view();
    assert.equal(view.leaderboard.length, 50);
    assert.equal(view.leaderboard.some(entry => entry.name === 'Manual Winner'), false);
    assert.equal(view.pointsLeaderboard.length, 50);
    assert.equal(view.pointsLeaderboard[0].name, 'Manual Winner');
    assert.equal(view.pointsLeaderboard[0].score, 5000);
    assert.equal(view.pointsLeaderboard[0].costUsd, 0);
    assert.equal(view.pointsLeaderboard[0].challengeScore, null);
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

test('a game can continue past the old hour cap while rejecting oversized synchronization jumps', () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    room.join('Untimed Player', room.code, undefined, 'socket', undefined, true);
    const player = room.playerFor('socket');
    player.game.act('pause');
    player.game.advanceTo(216000);
    player.started -= 3600000;
    const ack = room.inputs(player, { runId: player.runId, sequence: 1, frame: 216001, events: [] });
    assert.equal(ack.frame, 216001);
    assert.equal(player.game.status, 'paused');
    assert.throws(() => room.inputs(player, { runId: player.runId, sequence: 2, frame: 220000, events: [] }, Date.now() + 120000), /clock/);
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