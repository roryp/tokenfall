import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { io as connect } from 'socket.io-client';
import { TETROMINOES } from 'miaoda-game-fallblock-core';
import { boardMetrics, Game, placementsFor } from '../shared/game.ts';
import { costForUsage, emptyMetrics, reportedTokenBalance, tokenAllowance, tokenCreditsUsed } from '../shared/protocol.ts';
import type { Insight, JoinResult, Reply, RoomView, TokenPricing } from '../shared/protocol.ts';
import { createApplication } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { AI_COOLDOWN_MS, AUTOPILOT_COOLDOWN_MS, LunaGateway, MAX_OUTPUT_TOKENS, MAX_REASONING_COMPLETION_TOKENS, ModelGate, PLAYER_REQUEST_LIMIT, PLAYER_TOKEN_BUDGET, POLICY, PREFIX_TOKENS, ROOM_REQUEST_LIMIT, ROOM_TOKEN_BUDGET } from '../server/model.ts';
import type { ModelGateway } from '../server/model.ts';
import { Room } from '../server/room.ts';
import { buildPrompts, countTokens, gameTokens } from '../server/tokens.ts';
import { lookaheadSnapshot, lookupBoardFacts, lookupFutureMoves, McpLookupError, MAX_MCP_CONTEXT_TOKENS } from '../server/mcp.ts';
import { analyzeFutureMoves, boardFactsSchema, lookaheadOutputSchema } from '../server/mcp-server.ts';
import { resetRoom } from '../scripts/reset-room.ts';

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

for (const mode of ['all', 'scores'] as const) test(`room reset script ${mode} mode backs up history and preserves the room`, async () => {
  const setup = fixture();
  let room = new Room(setup.config, setup.gateway);
  try {
    const session = room.join('Old player', room.code, undefined, 'reset', 'Saved sentence.');
    const player = room.playerFor('reset');
    player.record.best_score = 4321;
    player.record.best_lines = 12;
    player.record.best_level = 3;
    player.metrics = { ...emptyMetrics(), requests: 4, input: 10000, output: 100, cached: 1000, reasoning: 20 };
    player.record.attempts = 5;
    room.disconnect('reset');
    room.join('Zero-score player', room.code, undefined, 'zero');
    room.disconnect('zero');
    const saved = room.records();
    const code = room.code;
    room.close();
    const databasePath = path.join(setup.dataDirectory, 'tokenfall.sqlite');
    const preview = await resetRoom({ databasePath, mode });
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.before, { players: 2, nonzeroScores: 1, requests: 4, usedTokens: 10100, attempts: 5 });
    const result = await resetRoom({ databasePath, mode, apply: true, confirmRoom: code, serverStopped: true });
    assert.equal(result.applied, true);
    assert.ok(result.backupPath);
    const recovery = new DatabaseSync(result.backupPath, { readOnly: true });
    try {
      assert.deepEqual(recovery.prepare('SELECT * FROM players ORDER BY best_score DESC, best_lines DESC, updated ASC').all(), saved);
      assert.equal(recovery.prepare("SELECT value FROM settings WHERE key = 'room'").get()!.value, code);
    } finally { recovery.close(); }
    room = new Room(setup.config, setup.gateway);
    assert.equal(room.code, code);
    if (mode === 'all') {
      assert.deepEqual(room.view().pointsLeaderboard, []);
      assert.deepEqual(room.view().leaderboard, []);
      assert.deepEqual(room.totals(), { metrics: emptyMetrics(), attempts: 0 });
      assert.equal(room.view().allowance.remaining, ROOM_TOKEN_BUDGET);
      assert.equal(room.view().requestsRemaining, ROOM_REQUEST_LIMIT);
      assert.throws(() => room.join(session.name, code, session.token, 'old'), /expired/);
      const fresh = room.join('Fresh player', code, undefined, 'fresh');
      assert.notEqual(fresh.playerId, session.playerId);
      assert.equal(fresh.metrics.requests, 0);
    } else {
      assert.equal(room.records().length, 2);
      assert.ok(room.records().every(record => record.best_score === 0 && record.best_lines === 0 && record.best_level === 1));
      assert.equal(room.join(session.name, code, session.token, 'old').metrics.requests, 4);
      assert.equal(room.view().allowance.used, 10100);
    }
  } finally { if (room.database.isOpen) room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('room reset script refuses unsafe confirmation, active games, changed data and backup overwrite', async () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    room.join('Retained player', room.code, undefined, 'reset-guard');
    room.disconnect('reset-guard');
    const databasePath = path.join(setup.dataDirectory, 'tokenfall.sqlite');
    const options = { databasePath, apply: true, confirmRoom: room.code, serverStopped: true };
    await assert.rejects(resetRoom({ databasePath: path.join(setup.dataDirectory, 'missing.sqlite') }), /does not exist/);
    await assert.rejects(resetRoom({ ...options, confirmRoom: 'WRONG0' }), /confirmation does not match/);
    await assert.rejects(resetRoom({ ...options, confirmRoom: undefined }), /requires --confirm-room/);
    await assert.rejects(resetRoom({ ...options, serverStopped: false }), /Stop the server/);
    await assert.rejects(resetRoom({ ...options, backupPath: databasePath }), /overwrite/);
    await assert.rejects(resetRoom({ ...options, assertIdle: async () => { throw new Error('Players are online'); } }), /Players are online/);
    let checks = 0;
    await assert.rejects(resetRoom({ ...options, assertIdle: async () => {
      if (++checks === 2) room.database.exec('UPDATE players SET best_score = 777');
    } }), /Players changed/);
    assert.equal(room.records().length, 1);
    assert.equal(room.records()[0].best_score, 777);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('room reset script CLI previews by default and requires confirmation before clearing all rows', () => {
  const setup = fixture();
  let room = new Room(setup.config, setup.gateway);
  const session = room.join('CLI player', room.code, undefined, 'cli');
  room.disconnect('cli');
  const code = room.code;
  room.close();
  try {
    const script = fileURLToPath(new URL('../scripts/reset-room.ts', import.meta.url));
    const args = [script, '--database', path.join(setup.dataDirectory, 'tokenfall.sqlite')];
    const preview = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stderr);
    const summary = JSON.parse(preview.stdout.match(/RESET_RESULT (.+)/)![1]);
    assert.equal(summary.applied, false);
    assert.equal(summary.mode, 'all');
    assert.equal(summary.before.players, 1);
    assert.equal(spawnSync(process.execPath, [...args, '--apply', '--server-stopped'], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [...args, '--apply', '--confirm-room', 'WRONG0', '--server-stopped'], { encoding: 'utf8' }).status, 1);
    room = new Room(setup.config, setup.gateway);
    assert.equal(room.records().length, 1);
    assert.equal(room.records()[0].id, session.playerId);
    room.close();
    const applied = spawnSync(process.execPath, [...args, '--apply', '--confirm-room', code, '--server-stopped'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout.match(/RESET_RESULT (.+)/)![1]).after.players, 0);
    room = new Room(setup.config, setup.gateway);
    assert.deepEqual(room.view().pointsLeaderboard, []);
    assert.equal(room.code, code);
  } finally { if (room.database.isOpen) room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

for (const mode of ['all', 'scores'] as const) test(`in-app room reset ${mode} clears cached games without allowing stale writes`, async () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    const session = room.join('Reset Player', room.code, undefined, 'reset-ui');
    const player = room.playerFor('reset-ui');
    player.game.act('hardDrop');
    player.game.act('pause');
    player.record.best_score = 1234;
    player.metrics = { ...emptyMetrics(), requests: 1, input: 2000, output: 20 };
    player.record.attempts = 1;
    room.save(player);
    const previousRun = player.runId;
    const operation = room.reset(mode, room.code);
    assert.equal(room.maintenanceStatus.resetting, true);
    assert.throws(() => room.join('Late join', room.code, undefined, 'late'), /reset in progress/);
    assert.throws(() => room.setAllowance(player, 100000), /reset in progress/);
    await assert.rejects(room.reset(mode, room.code), /reset in progress/);
    const result = await operation;
    assert.equal(result.applied, true);
    assert.ok(result.backupPath);
    assert.equal(room.players.size, 0);
    assert.equal(room.maintenanceStatus.resetting, false);
    assert.throws(() => room.save(player), /expired/);
    assert.throws(() => room.inputs(player, { runId: previousRun, sequence: 1, frame: 0, events: [] }), /expired/);
    room.disconnect('reset-ui');
    if (mode === 'all') {
      assert.deepEqual(room.view().pointsLeaderboard, []);
      assert.deepEqual(room.view().leaderboard, []);
      assert.equal(room.view().allowance.used, 0);
      assert.throws(() => room.join(session.name, room.code, session.token, 'new'), /expired/);
    } else {
      assert.equal(room.view().pointsLeaderboard[0].score, 0);
      assert.equal(room.view().allowance.used, 2020);
      const rejoined = room.join(session.name, room.code, session.token, 'new');
      assert.notEqual(rejoined.runId, previousRun);
      assert.equal(room.playerFor('new').game.pieces, 0);
      assert.equal(rejoined.metrics.requests, 1);
    }
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('in-app room reset refuses active games and pending Luna requests and releases its lock', async () => {
  const setup = fixture();
  let release!: (insight: Insight) => void;
  const room = new Room(setup.config, { complete: async () => new Promise<Insight>(resolve => { release = resolve; }) });
  try {
    room.join('Busy Player', room.code, undefined, 'busy');
    const player = room.playerFor('busy');
    await assert.rejects(room.reset('all', 'WRONG0'), /room code/);
    await assert.rejects(room.reset('all', room.code), /Pause all games/);
    player.game.act('pause');
    const pending = room.assist(player, { compression: true, cache: false });
    await assert.rejects(room.reset('all', room.code), /pending Luna requests/);
    assert.equal(room.maintenanceStatus.resetting, false);
    release(insightFor(player.game));
    await pending;
    assert.equal(room.records()[0].attempts, 1);
    assert.equal(room.totals().metrics.requests, 1);
    assert.equal((await room.reset('all', room.code)).after?.players, 0);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('local maintenance API is opt-in, validates origin and consumes reset previews once', async () => {
  const setup = fixture();
  assert.throws(() => createApplication({ ...setup.config, localMaintenance: true, host: '0.0.0.0' }, setup.gateway), /local loopback/);
  const application = createApplication({ ...setup.config, localMaintenance: true, host: '127.0.0.1' }, setup.gateway);
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const post = (route: string, payload: object, headers: Record<string, string> = {}) => fetch(`${base}/api/maintenance/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Room-Maintenance': '1', ...headers }, body: JSON.stringify(payload) });
  try {
    application.room.join('Old player', application.room.code, undefined, 'old');
    application.room.playerFor('old').game.act('pause');
    assert.equal((await post('preview', { mode: 'all' }, { Origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await post('preview', { mode: 'all' }, { 'X-Room-Maintenance': '' })).status, 403);
    assert.equal((await post('preview', { mode: 'all' }, { 'X-Forwarded-Host': 'public.example' })).status, 403);
    assert.equal((await post('preview', { mode: 'all', databasePath: '/data/other.sqlite' })).status, 400);
    const preview = await (await post('preview', { mode: 'all' })).json();
    assert.equal(preview.before.players, 1);
    const request = { mode: 'all', confirmRoom: application.room.code, confirmationId: preview.confirmationId };
    assert.equal((await post('reset', { ...request, confirmRoom: 'WRONG0' })).status, 400);
    const response = await post('reset', request);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.after.players, 0);
    assert.equal(result.backup.includes('/'), false);
    assert.equal(result.backup.includes('\\'), false);
    assert.equal((await post('reset', request)).status, 409);
    assert.equal(application.room.players.size, 0);
    assert.deepEqual(application.room.view().pointsLeaderboard, []);
    application.room.config.localMaintenance = false;
    assert.equal((await post('preview', { mode: 'all' })).status, 404);
    assert.equal(application.room.view().maintenance, undefined);
  } finally { await application.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('in-app room reset rejects changed and expired previews without deleting players', async context => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    const preview = room.previewReset('all');
    room.join('New player', room.code, undefined, 'new');
    room.playerFor('new').game.act('pause');
    await assert.rejects(room.reset('all', room.code, preview.confirmationId), /room changed/);
    const current = room.previewReset('scores');
    await assert.rejects(room.reset('all', room.code, current.confirmationId), /room changed/);
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const expired = room.previewReset('all');
    context.mock.timers.tick(120001);
    await assert.rejects(room.reset('all', room.code, expired.confirmationId), /preview expired/);
    assert.equal(room.records().length, 1);
    assert.equal(room.maintenanceStatus.resetting, false);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('in-app room reset leaves records and sessions intact when the backup cannot be created', async () => {
  const setup = fixture();
  const room = new Room(setup.config, setup.gateway);
  try {
    room.join('Keep Player', room.code, undefined, 'keep');
    const player = room.playerFor('keep');
    player.game.act('pause');
    player.record.best_score = 777;
    room.save(player);
    const before = room.records();
    const backupDirectory = path.join(setup.dataDirectory, 'backups');
    writeFileSync(backupDirectory, 'Blocked backup directory');
    await assert.rejects(room.reset('all', room.code));
    assert.deepEqual(room.records(), before);
    assert.equal(room.playerFor('keep'), player);
    assert.equal(room.maintenanceStatus.resetting, false);
    rmSync(backupDirectory);
    assert.equal((await room.reset('all', room.code)).after?.players, 0);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('local maintenance configuration is explicit and refuses production or public binding', () => {
  const environment = { AZURE_OPENAI_ENDPOINT: 'https://fixture.invalid', AZURE_OPENAI_DEPLOYMENT: 'fixture', AZURE_TENANT_ID: 'fixture', AZURE_CLIENT_ID: '', HOST: '127.0.0.1', NODE_ENV: 'development', LOCAL_ROOM_MAINTENANCE: 'false' };
  assert.equal(loadConfig(environment).localMaintenance, false);
  assert.equal(loadConfig({ ...environment, LOCAL_ROOM_MAINTENANCE: 'true' }).localMaintenance, true);
  for (const changes of [{ HOST: '0.0.0.0' }, { NODE_ENV: 'production' }, { AZURE_CLIENT_ID: 'cloud-identity' }]) {
    assert.throws(() => loadConfig({ ...environment, ...changes, LOCAL_ROOM_MAINTENANCE: 'true' }), /local loopback/);
  }
});

test('AI allowance counts output and MCP input once and distinguishes unavailable reservations from reported spend', () => {
  const usage = { ...emptyMetrics(), input: 12000, output: 2000, reasoning: 1500, cached: 4000 };
  assert.deepEqual(tokenAllowance(30000, usage, 10000, 1000), { limit: 30000, used: 14000, reserved: 10000, unconfirmed: 1000, remaining: 5000 });
  assert.equal(reportedTokenBalance(tokenAllowance(30000, usage, 10000, 1000)), 16000);
  assert.equal(reportedTokenBalance(tokenAllowance(30000, usage)), 16000);
  assert.equal(reportedTokenBalance(tokenAllowance(10000, usage)), 0);
  assert.equal(tokenAllowance(30000, usage).remaining, 16000);
  assert.equal(tokenAllowance(10000, usage).remaining, 0);
  const gate = new ModelGate();
  assert.throws(() => gate.acquire('personal', 4000, 18000, 18000, 0, false, 20000), /2[,\s]000 left.*4[,\s]000/);
  assert.throws(() => gate.acquire('shared', 4000, 0, ROOM_TOKEN_BUDGET - 1000), error => (error as { code: string }).code === 'room-budget');
});

test('personal AI allowances persist and can be increased without resetting scores, usage or sentence games', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 20000 });
  const setup = fixture();
  let room = new Room(setup.config, setup.gateway);
  try {
    const joined = room.join('Budget Setup', room.code, undefined, 'budget', 'A shared token pool.', false, 24000);
    const player = room.playerFor('budget');
    assert.equal(joined.allowance.limit, 24000);
    assert.equal(joined.allowance.remaining, 24000);
    player.metrics = { ...emptyMetrics(), input: 20000, output: 1000, cached: 7000, reasoning: 500, requests: 2 };
    player.record.attempts = 2;
    player.record.best_score = 987;
    room.save(player);
    await assert.rejects(room.assist(player, { compression: true, cache: false }), /3[,\s]000 left/);
    assert.equal(player.record.attempts, 2);
    const run = player.runId;
    const adjusted = room.setAllowance(player, 60000);
    assert.equal(adjusted.allowance.remaining, 39000);
    assert.equal(player.runId, run);
    assert.equal(player.record.best_score, 987);
    const reply = await room.assist(player, { compression: true, cache: false });
    assert.equal(reply.allowance.used, 23020);
    assert.equal(reply.allowance.remaining, 36980);
    assert.equal(reply.allowance.reserved, 0);
    context.mock.timers.tick(2100);
    const restarted = room.restart(player, 'A new sentence.');
    assert.deepEqual(restarted.allowance, reply.allowance);
    for (const invalid of [0, 15999, 16000.5, 8000001, NaN]) assert.throws(() => room.setAllowance(player, invalid));
    assert.throws(() => room.setAllowance(player, 16000), /already used or held/);
    room.disconnect('budget');
    room.close();
    room = new Room(setup.config, setup.gateway);
    const restored = room.join('Budget Setup', room.code, joined.token, 'restored');
    assert.deepEqual(restored.allowance, reply.allowance);
    assert.equal(restored.tokenText, 'A new sentence.');
    assert.equal(room.view().pointsLeaderboard[0].score, 987);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('existing databases gain the allowance setting without losing player records', () => {
  const setup = fixture();
  let room = new Room(setup.config, setup.gateway);
  try {
    const joined = room.join('Legacy Budget', room.code, undefined, 'legacy', 'Existing sentence.');
    const player = room.playerFor('legacy');
    player.metrics = { ...emptyMetrics(), requests: 50, input: 800000, output: 1000, reasoning: 500 };
    player.record.attempts = 50;
    player.record.best_score = 321;
    room.disconnect('legacy');
    room.database.exec('ALTER TABLE players DROP COLUMN token_limit');
    room.close();
    room = new Room(setup.config, setup.gateway);
    const restored = room.join('Legacy Budget', room.code, joined.token, 'resumed', undefined, false, 16000);
    assert.equal(restored.playerId, joined.playerId);
    assert.equal(restored.allowance.limit, ROOM_TOKEN_BUDGET);
    assert.equal(restored.allowance.used, 801000);
    assert.equal(restored.allowance.remaining, ROOM_TOKEN_BUDGET - 801000);
    assert.equal(restored.tokenText, 'Existing sentence.');
    assert.equal(room.view().pointsLeaderboard[0].score, 321);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('socket allowance configuration validates the limit and only changes the authenticated player', async () => {
  const setup = fixture();
  const application = createApplication(setup.config, setup.gateway);
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address() as { port: number };
  const client = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
  try {
    const notJoined = await client.timeout(5000).emitWithAck('allowance', { tokenLimit: 50000 });
    assert.equal(notJoined.ok, false);
    assert.equal(notJoined.code, 'session');
    for (const tokenLimit of [-1, 0, 16000.5, 8000001, '50000']) {
      const rejected = await client.timeout(5000).emitWithAck('join', { name: 'Budget Client', room: application.room.code, tokenLimit });
      assert.equal(rejected.ok, false);
    }
    assert.equal(application.room.players.size, 0);
    const joined = await client.timeout(5000).emitWithAck('join', { name: 'Budget Client', room: application.room.code, text: 'A chosen allowance.', tokenLimit: 50000 });
    assert.equal(joined.ok, true);
    assert.equal(joined.data.allowance.limit, 50000);
    const invalid = await client.timeout(5000).emitWithAck('allowance', { tokenLimit: 60000, playerId: 'somebody-else' });
    assert.equal(invalid.ok, false);
    const changed = await client.timeout(5000).emitWithAck('allowance', { tokenLimit: 60000 });
    assert.equal(changed.ok, true);
    assert.equal(changed.data.allowance.remaining, 60000);
    assert.equal(changed.data.metrics.requests, 0);
    assert.equal(application.room.players.get(joined.data.playerId)!.runId, joined.data.runId);
  } finally { client.disconnect(); await application.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('AI allowance reserves in-flight requests and keeps unreported usage distinct from spend', async () => {
  const setup = fixture();
  let complete!: (value: Insight) => void;
  let fail = false;
  const room = new Room(setup.config, { complete: async () => {
    if (fail) throw new Error('Provider usage unavailable');
    return new Promise<Insight>(resolve => { complete = resolve; });
  } });
  try {
    room.join('In Flight', room.code, undefined, 'pending', undefined, false, 32000);
    const player = room.playerFor('pending');
    const pending = room.assist(player, { compression: true, cache: false });
    const held = room.usage(player).allowance;
    assert.ok(held.reserved > 0);
    assert.equal(held.used, 0);
    assert.equal(held.unconfirmed, 0);
    assert.equal(held.remaining, 32000 - held.reserved);
    assert.equal(room.view().allowance.reserved, held.reserved);
    complete(insightFor(player.game));
    const result = await pending;
    assert.equal(result.allowance.used, 2020);
    assert.equal(result.allowance.reserved, 0);
    assert.equal(result.allowance.remaining, 29980);
    room.join('Unknown Usage', room.code, undefined, 'unknown', undefined, false, 32000);
    fail = true;
    await assert.rejects(room.assist(room.playerFor('unknown'), { compression: true, cache: false }), /usage unavailable/);
    const unknown = room.usage(room.playerFor('unknown')).allowance;
    assert.equal(unknown.used, 0);
    assert.equal(unknown.reserved, 0);
    assert.equal(unknown.unconfirmed, 16000);
    assert.equal(unknown.remaining, 16000);
    assert.equal(room.view().allowance.unconfirmed, 16000);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('MCP lookahead computes achievable two-piece outcomes without choosing the first move or mutating play', () => {
  const game = new Game('lookahead-proof', gameTokens('Hello world! Tokens make my blocks.'));
  game.act('left');
  game.act('hardDrop');
  const before = game.view();
  const board = buildPrompts(game, placementsFor(game)).packed;
  const input = { board: JSON.parse(board).board as string[], active: { piece: game.piece, column: game.active.x, row: game.active.y, rotation: game.active.rot ?? 0 }, hold: game.hold, canHold: !game.usedHold, next: game.queue.peek() };
  const analysis = analyzeFutureMoves(input);
  const candidates = placementsFor(game);
  assert.deepEqual(analysis.moves.map(move => move[0]), candidates.map(candidate => candidate.id));
  assert.ok(analysis.continuationsEvaluated > candidates.length);
  for (const [index, candidate] of candidates.entries()) {
    const branch = Game.restore(game.replay());
    for (const action of candidate.path) branch.act(action);
    const replies = placementsFor(branch);
    const move = analysis.moves[index];
    assert.equal(move[1], replies.length);
    assert.equal(move[2], replies.filter(reply => !reply.gameOver).length);
    for (const forecast of [move[3], move[4]]) {
      if (!forecast) continue;
      const reply = replies.find(option => option.id === forecast[0])!;
      assert.ok(reply);
      assert.equal(reply.gameOver, false);
      assert.deepEqual(forecast.slice(1), [reply.piece, reply.useHold, candidate.clearedLines + reply.clearedLines, reply.holes, reply.maxHeight]);
    }
  }
  assert.deepEqual(game.view(), before);
});

test('real MCP lookahead exposes a line clear and five fewer holes missed by immediate-only evaluation', async () => {
  const game = new Game('lookahead-advantage-18');
  for (let turn = 0; turn < 6; turn += 1) {
    const legal = placementsFor(game).filter(move => !move.gameOver);
    const choice = legal[(18 * 17 + turn * 23) % legal.length];
    for (const action of choice.path) game.act(action);
  }
  const candidates = placementsFor(game).filter(move => !move.gameOver);
  const greedy = [...candidates].sort((first, second) => first.holes - second.holes || second.clearedLines - first.clearedLines || first.aggregateHeight - second.aggregateHeight || first.maxHeight - second.maxHeight)[0];
  const lookup = await lookupFutureMoves(lookaheadSnapshot(game));
  const analysis = lookaheadOutputSchema.parse(JSON.parse(lookup.result));
  const baseline = analysis.moves.find(move => move[0] === greedy.id)!;
  const improved = analysis.moves.find(move => move[3]?.[4] === 2)!;
  const current = candidates.find(move => move.id === improved[0])!;
  assert.deepEqual([current.holes, current.maxHeight, current.clearedLines], [greedy.holes, greedy.maxHeight, greedy.clearedLines]);
  assert.equal(baseline[3]![4], 7);
  assert.equal(baseline[3]![3], 0);
  assert.equal(improved[3]![4], 2);
  assert.equal(improved[3]![3], 1);
  const replay = Game.restore(game.replay());
  for (const action of current.path) replay.act(action);
  const followup = placementsFor(replay).find(move => move.id === improved[3]![0])!;
  for (const action of followup.path) replay.act(action);
  assert.equal(replay.lines - game.lines, 1);
  assert.equal(boardMetrics(replay.well).holes, 2);
  assert.equal(replay.status, 'playing');
  assert.ok(analysis.continuationsEvaluated > 2000);
});

test('MCP lookahead preserves rotated wall poses and both available and already-used Hold states', async () => {
  for (const scenario of ['held', 'used-hold', 'rotated-wall', 'paused']) {
    const game = new Game(`lookahead-${scenario}`);
    game.act('hold');
    if (scenario !== 'used-hold') game.act('hardDrop');
    if (scenario === 'rotated-wall') {
      game.act('rotateCW');
      for (let step = 0; step < 5; step += 1) game.act('left');
    }
    if (scenario === 'paused') game.act('pause');
    const before = game.view();
    const candidates = placementsFor(game);
    const lookup = await lookupFutureMoves(lookaheadSnapshot(game));
    const analysis = lookaheadOutputSchema.parse(JSON.parse(lookup.result));
    assert.deepEqual(analysis.moves.map(move => move[0]), candidates.map(move => move.id));
    for (const index of [0, Math.floor(candidates.length / 2), candidates.length - 1]) {
      const branch = Game.restore(game.replay());
      if (branch.status === 'paused') branch.act('resume');
      for (const action of candidates[index].path) branch.act(action);
      const replies = placementsFor(branch);
      const forecast = analysis.moves[index];
      assert.equal(forecast[1], replies.length, scenario);
      assert.equal(forecast[2], replies.filter(reply => !reply.gameOver).length, scenario);
      for (const path of [forecast[3], forecast[4]]) {
        if (!path) continue;
        const reply = replies.find(move => move.id === path[0])!;
        assert.deepEqual(path.slice(1), [reply.piece, reply.useHold, candidates[index].clearedLines + reply.clearedLines, reply.holes, reply.maxHeight], scenario);
      }
    }
    assert.deepEqual(game.view(), before);
  }
});

test('the MCP board tool runs through real stdio discovery and returns snapshot-specific facts', async () => {
  const board = Array.from({ length: 22 }, () => '..........');
  board[19] = 'T.........';
  board[21] = 'JJJJ.JJJJJ';
  const before = [...board];
  const lookup = await lookupBoardFacts(board);
  assert.equal(lookup.server, 'tetris-board-facts');
  assert.equal(lookup.tool, 'lookup_board_facts');
  assert.equal(lookup.transport, 'stdio');
  assert.deepEqual(lookup.arguments.board, before);
  assert.deepEqual(board, before);
  const facts = JSON.parse(lookup.result);
  assert.equal(facts.holes, 1);
  assert.deepEqual(facts.holeCells, [[0, 20]]);
  assert.equal(facts.columnHeights[0], 3);
  assert.deepEqual(facts.rowGaps.find((row: { row: number }) => row.row === 21).columns, [4]);
  assert.ok(lookup.resultTokens > 0 && lookup.resultTokens < MAX_MCP_CONTEXT_TOKENS);
  const empty = await lookupBoardFacts(Array.from({ length: 22 }, () => '..........'));
  assert.notEqual(JSON.parse(empty.result).boardHash, facts.boardHash);
  assert.deepEqual(JSON.parse(empty.result).holeCells, []);
  await assert.rejects(lookupBoardFacts(['invalid']), McpLookupError);
});

test('the standalone MCP tool advertises read-only capabilities and rejects malformed or unknown calls', async () => {
  const client = new Client({ name: 'mcp-contract-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../server/mcp-server.ts', import.meta.url))], stderr: 'ignore' });
  try {
    await client.connect(transport, { timeout: 5000 });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['analyze_future_moves', 'lookup_board_facts']);
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    assert.equal(tools[0].annotations?.destructiveHint, false);
    assert.equal(tools[0].annotations?.openWorldHint, false);
    const invalid = await client.callTool({ name: 'lookup_board_facts', arguments: { board: ['bad board'] } });
    assert.equal(invalid.isError, true);
    const extra = await client.callTool({ name: 'lookup_board_facts', arguments: { board: Array(22).fill('..........'), url: 'https://example.invalid' } });
    assert.equal(extra.isError, true);
    const unknown = await client.callTool({ name: 'change_game', arguments: {} });
    assert.equal(unknown.isError, true);
    const valid = await client.callTool({ name: 'lookup_board_facts', arguments: { board: Array(22).fill('..........') } });
    assert.equal(valid.isError, undefined);
    assert.equal(boardFactsSchema.parse(valid.structuredContent).holes, 0);
  } finally { await client.close(); }
});

test('MCP results stay within the reserved context limit for crowded and hole-heavy boards', async () => {
  for (const board of [
    ['TTTTTTTTTT', ...Array(21).fill('T.........')],
    Array.from({ length: 22 }, (_, row) => row % 2 ? '.T.T.T.T.T' : 'T.T.T.T.T.'),
    Array(22).fill('JJJJJJJJJJ'),
  ]) {
    const lookup = await lookupBoardFacts(board);
    const facts = JSON.parse(lookup.result);
    assert.ok(lookup.resultTokens + 128 <= MAX_MCP_CONTEXT_TOKENS);
    assert.equal(facts.holeCells.length, facts.holes);
    assert.equal(facts.columnHeights.length, 10);
  }
});

test('Luna receives actual MCP lookahead with reasoning enabled in one metered request, while off remains unchanged', async context => {
  const setup = fixture();
  const gateway = new LunaGateway(setup.config);
  const game = new Game('mcp-gateway');
  game.well.set(0, 19, 'T');
  game.well.set(0, 21, 'J');
  const original = game.view();
  let sent: unknown;
  const connections = context.mock.method(StdioClientTransport.prototype, 'start');
  const mock = context.mock.method(gateway['client'].chat.completions, 'create', async (request: unknown) => {
    sent = request;
    const payload = JSON.parse(JSON.stringify(request));
    const prompt = JSON.parse(payload.messages[1].content);
    const input = countTokens(payload.messages[0].content[0].text) + countTokens(payload.messages[1].content);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ placementId: prompt.placements[0].id, tip: 'Use verified two-piece analysis.' }) } }], usage: { prompt_tokens: input, completion_tokens: 100, total_tokens: input + 100, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 70 } } };
  });
  try {
    const enabled = await gateway.complete(game, { compression: true, cache: false, reasoning: true, mcp: true }, 'test');
    assert.equal(enabled.status, 'ready');
    assert.ok(enabled.mcpLookup);
    assert.equal(JSON.parse(enabled.prompt).mcpLookup.tool, 'analyze_future_moves');
    assert.deepEqual(JSON.parse(enabled.prompt).mcpLookup.analysis, JSON.parse(enabled.mcpLookup.result));
    assert.equal(JSON.parse(enabled.mcpLookup.result).depth, 2);
    assert.ok(JSON.parse(enabled.mcpLookup.result).continuationsEvaluated > 100);
    assert.match(enabled.systemPrompt!, /MCP LOOKAHEAD/);
    assert.ok(enabled.mcpLookup.addedInputTokens! > enabled.mcpLookup.resultTokens);
    assert.equal(JSON.parse(JSON.stringify(sent)).reasoning_effort, 'low');
    assert.equal(JSON.parse(JSON.stringify(sent)).messages[1].content, enabled.prompt);
    assert.deepEqual(JSON.parse(enabled.promptComparison!.verbose).mcpLookup, JSON.parse(enabled.promptComparison!.packed).mcpLookup);
    const originalPrompts = buildPrompts(game, placementsFor(game));
    assert.ok(enabled.packedTokens > originalPrompts.packedTokens);
    assert.ok(enabled.packedTokens - originalPrompts.packedTokens <= MAX_MCP_CONTEXT_TOKENS);
    assert.equal(mock.mock.callCount(), 1);
    assert.equal(connections.mock.callCount(), 1);
    const disabled = await gateway.complete(game, { compression: true, cache: false, reasoning: true }, 'test');
    assert.equal(disabled.mcpLookup, undefined);
    assert.equal(disabled.prompt, originalPrompts.packed);
    assert.equal(disabled.systemPrompt, POLICY);
    assert.ok(enabled.usage.input > disabled.usage.input);
    assert.equal(enabled.usage.input - disabled.usage.input, enabled.mcpLookup.addedInputTokens);
    const rates = setup.pricing.snapshot!.usdPerMillion;
    const addedCost = costForUsage(enabled.usage, rates).total - costForUsage(disabled.usage, rates).total;
    assert.ok(addedCost > 0);
    assert.ok(Math.abs(addedCost - enabled.mcpLookup.addedInputTokens! * rates.input / 1000000) < 1e-12);
    assert.equal(mock.mock.callCount(), 2);
    assert.equal(connections.mock.callCount(), 1);
    assert.deepEqual(game.view(), original);
    const pending = gateway.complete(game, { compression: true, cache: false, reasoning: true, mcp: true }, 'test');
    game.act('hardDrop');
    const changed = game.view();
    const snapshot = await pending;
    assert.equal(snapshot.pieceId, original.pieceId);
    assert.deepEqual(JSON.parse(snapshot.prompt).board, JSON.parse(originalPrompts.packed).board);
    assert.deepEqual(snapshot.mcpLookup?.arguments.board, JSON.parse(originalPrompts.packed).board);
    assert.deepEqual(game.view(), changed);
  } finally { rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('MCP lookahead compacts crowded forecasts losslessly within the existing request budget', async context => {
  const setup = fixture();
  const gateway = new LunaGateway(setup.config);
  const game = new Game('mcp-irregular-0');
  for (let turn = 0; turn < 8; turn += 1) {
    const legal = placementsFor(game).filter(move => !move.gameOver);
    for (const action of legal[turn * 23 % legal.length].path) game.act(action);
  }
  const original = game.view();
  const mock = context.mock.method(gateway['client'].chat.completions, 'create', async (request: unknown) => {
    const payload = JSON.parse(JSON.stringify(request));
    const prompt = JSON.parse(payload.messages[1].content);
    const input = countTokens(payload.messages[0].content[0].text) + countTokens(payload.messages[1].content);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ placementId: prompt.placements[0].id, tip: 'Use the compact forecasts.' }) } }], usage: { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } };
  });
  try {
    const result = await gateway.complete(game, { compression: true, cache: false, mcp: true }, 'test');
    assert.equal(result.status, 'ready');
    const lookup = result.mcpLookup!;
    const analysis = lookaheadOutputSchema.parse(JSON.parse(lookup.result));
    assert.equal(analysis.candidatesEvaluated, 91);
    assert.ok(lookup.resultTokens > MAX_MCP_CONTEXT_TOKENS);
    const { replies, ...packed } = JSON.parse(result.prompt).mcpLookup.analysis;
    assert.ok(replies.length < analysis.moves.length);
    const expanded = { ...packed, moves: packed.moves.map(([id, legal, surviving, holes, clears]: [string, number, number, number | null, number | null]) => [id, legal, surviving, holes === null ? null : replies[holes], clears === null ? null : replies[clears]]) };
    assert.deepEqual(expanded, analysis);
    assert.deepEqual(JSON.parse(result.promptComparison!.verbose).mcpLookup, JSON.parse(result.promptComparison!.packed).mcpLookup);
    assert.ok(lookup.addedInputTokens! <= MAX_MCP_CONTEXT_TOKENS);
    assert.ok(countTokens(result.systemPrompt!) - PREFIX_TOKENS <= 256);
    assert.ok(PREFIX_TOKENS + buildPrompts(game, placementsFor(game)).packedTokens + MAX_OUTPUT_TOKENS + 1024 + MAX_MCP_CONTEXT_TOKENS <= 16000);
    assert.equal(mock.mock.callCount(), 1);
    assert.deepEqual(game.view(), original);
  } finally { rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('MCP admission reserves tool context and a failed pre-inference lookup is not billed', async () => {
  const setup = fixture();
  let oversized = false;
  const room: Room = new Room(setup.config, { complete: async (game, options) => {
    assert.equal(options.mcp, true);
    const prompts = buildPrompts(game, placementsFor(game));
    assert.equal(room.gate.reserved, PREFIX_TOKENS + prompts.packedTokens + MAX_OUTPUT_TOKENS + 1024 + MAX_MCP_CONTEXT_TOKENS);
    throw new McpLookupError(oversized ? 'context' : 'tool');
  } });
  try {
    room.join('MCP Player', room.code, undefined, 'mcp');
    const player = room.playerFor('mcp');
    await assert.rejects(room.assist(player, { compression: true, cache: false, mcp: true }), /before contacting Luna/);
    assert.equal(player.record.attempts, 0);
    assert.equal(player.metrics.requests, 0);
    assert.equal(room.usage(player).unmeteredRequests, 0);
    assert.equal(room.gate.inFlight, 0);
    assert.equal(room.gate.reserved, 0);
    oversized = true;
    room.join('MCP Context', room.code, undefined, 'mcp-context');
    const contextPlayer = room.playerFor('mcp-context');
    await assert.rejects(room.assist(contextPlayer, { compression: true, cache: false, mcp: true }), { code: 'mcp-context', message: /cannot fit/ });
    assert.equal(contextPlayer.record.attempts, 0);
    assert.equal(room.usage(contextPlayer).unmeteredRequests, 0);
    assert.equal(room.gate.reserved, 0);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

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

test('reasoning is opt-in, uses a bounded completion budget, and never bypasses legal-move validation', async context => {
  const setup = fixture();
  const gateway = new LunaGateway(setup.config);
  const game = new Game('reasoning-options');
  let placementId = placementsFor(game)[0].id;
  let reasoning: number | undefined = 128;
  let finishReason = 'stop';
  let sent: unknown;
  let timeout: number | undefined;
  context.mock.method(gateway['client'].chat.completions, 'create', async (request: unknown, options: { timeout: number }) => {
    sent = request;
    timeout = options.timeout;
    return { choices: [{ finish_reason: finishReason, message: { content: JSON.stringify({ placementId, tip: 'A legal move.' }) } }], usage: { prompt_tokens: 4000, completion_tokens: 160, total_tokens: 4160, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: reasoning } } };
  });
  try {
    const disabled = await gateway.complete(game, { compression: true, cache: false }, 'test');
    assert.equal(JSON.parse(JSON.stringify(sent)).reasoning_effort, 'none');
    assert.equal(JSON.parse(JSON.stringify(sent)).max_completion_tokens, MAX_OUTPUT_TOKENS);
    assert.equal(disabled.status, 'invalid');
    assert.equal(disabled.reasoningEnabled, false);
    assert.equal(timeout, 20000);
    const enabled = await gateway.complete(game, { compression: true, cache: false, reasoning: true }, 'test');
    assert.equal(JSON.parse(JSON.stringify(sent)).reasoning_effort, 'low');
    assert.equal(JSON.parse(JSON.stringify(sent)).max_completion_tokens, MAX_REASONING_COMPLETION_TOKENS);
    assert.equal(enabled.status, 'ready');
    assert.equal(enabled.reasoningEnabled, true);
    assert.equal(enabled.usage.reasoning, 128);
    assert.equal(enabled.usage.output, 160);
    assert.equal(enabled.usage.total, 4160);
    assert.equal(timeout, 60000);
    finishReason = 'length';
    const truncated = await gateway.complete(game, { compression: true, cache: false, reasoning: true }, 'test');
    assert.equal(truncated.status, 'invalid');
    assert.equal(truncated.placement, null);
    assert.equal(truncated.usage.reasoning, 128);
    assert.match(truncated.tip, /completion cap, not your total allowance/);
    finishReason = 'stop';
    reasoning = undefined;
    const unknown = await gateway.complete(game, { compression: true, cache: false, reasoning: true }, 'test');
    assert.equal(unknown.usage.reasoning, null);
    assert.equal(unknown.status, 'ready');
    placementId = 'not-legal';
    const invalid = await gateway.complete(game, { compression: true, cache: false, reasoning: true }, 'test');
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.placement, null);
    assert.equal(game.pieces, 0);
  } finally { rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('reasoning reserves its full output allowance and persists the actual reported count', async () => {
  const setup = fixture();
  let calls = 0;
  let reservation = 0;
  const room: Room = new Room(setup.config, { complete: async (game, options) => {
    calls += 1;
    assert.equal(options.reasoning, true);
    assert.equal(room.gate.reserved, reservation);
    return { ...insightFor(game), reasoningEnabled: true, usage: { input: 4000, output: 160, cached: 0, cacheWrites: 0, total: 4160, reasoning: 128 } };
  } });
  try {
    const joined = room.join('Reasoning Player', room.code, undefined, 'reasoning');
    const player = room.playerFor('reasoning');
    const prompts = buildPrompts(player.game, placementsFor(player.game));
    reservation = PREFIX_TOKENS + prompts.packedTokens + MAX_REASONING_COMPLETION_TOKENS + 1024;
    const reply = await room.assist(player, { compression: true, cache: false, reasoning: true });
    assert.equal(reply.metrics.reasoning, 128);
    assert.equal(reply.metrics.output, 160);
    assert.equal(room.gate.reserved, 0);
    room.disconnect('reasoning');
    const restored = room.join('Reasoning Player', room.code, joined.token, 'restored');
    assert.equal(restored.metrics.reasoning, 128);
    assert.equal(restored.metrics.output, 160);
    const stored = room.database.prepare('SELECT metrics FROM players WHERE id = ?').get(joined.playerId)!;
    assert.equal(JSON.parse(stored.metrics as string).reasoning, 128);
    room.join('Budget Player', room.code, undefined, 'budget', 'Bounded reasoning.');
    const limited = room.playerFor('budget');
    const packed = buildPrompts(limited.game, placementsFor(limited.game)).packedTokens;
    limited.metrics.input = ROOM_TOKEN_BUDGET - (PREFIX_TOKENS + packed + MAX_REASONING_COMPLETION_TOKENS + 1024) + 1;
    await assert.rejects(room.assist(limited, { compression: true, cache: false, reasoning: true }), /Not enough token credits/);
    assert.equal(limited.record.attempts, 0);
    assert.equal(calls, 1);
  } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
});

test('all normal active and Hold combinations fit the request guard in both encodings', () => {
  assert.ok(PREFIX_TOKENS >= 1024);
  for (const active of TETROMINOES) for (const held of [null, ...TETROMINOES]) {
    const game = new Game('prompt-size');
    game.active = game.newPiece(active);
    game.held = held ? game.newPiece(held) : null;
    const prompts = buildPrompts(game, placementsFor(game));
    for (const count of [prompts.rawTokens, prompts.packedTokens]) for (const output of [MAX_OUTPUT_TOKENS, MAX_REASONING_COMPLETION_TOKENS]) {
      const reservation = PREFIX_TOKENS + count + output + 1024;
      assert.ok(reservation <= 16000, `${active}/${held ?? 'empty'} with ${output} output needs ${reservation} reserved tokens`);
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

test('both game modes continue beyond prototype player limits while retaining shared room guards', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 20000 });
  for (const text of [undefined, 'Hello world! Tokens make my blocks.']) {
    const setup = fixture();
    const room = new Room(setup.config, setup.gateway);
    try {
      const joined = room.join('Continuous Player', room.code, undefined, 'socket', text);
      const player = room.playerFor('socket');
      player.record.attempts = PLAYER_REQUEST_LIMIT + 10;
      player.record.best_score = 1234;
      player.metrics = { ...emptyMetrics(), requests: player.record.attempts, input: PLAYER_TOKEN_BUDGET + 10000, output: 1000 };
      room.save(player);
      const result = await room.assist(player, { compression: true, cache: false, autopilot: true });
      assert.equal(result.metrics.requests, PLAYER_REQUEST_LIMIT + 11);
      assert.equal(player.record.attempts, PLAYER_REQUEST_LIMIT + 11);
      assert.equal(player.record.best_score, 1234);
      assert.equal(result.metrics.input, PLAYER_TOKEN_BUDGET + 12000);
      assert.deepEqual(player.game.tokens, text ? gameTokens(text) : []);
      assert.equal(room.view().playerTokenBudget, ROOM_TOKEN_BUDGET);
      room.disconnect('socket');
      const restored = room.join('Continuous Player', room.code, joined.token, 'restored');
      assert.deepEqual(restored.metrics, result.metrics);
      room.join('Other Player', room.code, undefined, 'other');
      const other = room.playerFor('other');
      other.metrics.input = ROOM_TOKEN_BUDGET - player.metrics.input - player.metrics.output;
      room.save(other);
      context.mock.timers.tick(AUTOPILOT_COOLDOWN_MS);
      await assert.rejects(room.assist(player, { compression: true, cache: false, autopilot: true }), /room model token limit/);
      player.record.attempts = ROOM_REQUEST_LIMIT;
      room.save(player);
      await assert.rejects(room.assist(player, { compression: true, cache: false, autopilot: true }), /room AI request allowance/);
    } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
  }
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

test('sentence runs retain spending and optimization savings beyond the old request allowance', async context => {
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
        await room.assist(player, options);
      }
      assert.ok(tokenCreditsUsed(player.metrics) < ROOM_TOKEN_BUDGET);
      assert.equal(room.view().metrics.input + room.view().metrics.output, player.metrics.input + player.metrics.output);
      const spent = tokenCreditsUsed(player.metrics);
      room.restart(player);
      assert.equal(tokenCreditsUsed(player.metrics), spent);
      requestCounts.push(requests);
      creditsSpent.push(spent);
    } finally { room.close(); rmSync(setup.dataDirectory, { recursive: true, force: true }); }
  }
  assert.ok(requestCounts.every(count => count === PLAYER_REQUEST_LIMIT + 1));
  assert.ok(creditsSpent[0] > PLAYER_TOKEN_BUDGET);
  assert.ok(creditsSpent[1] < creditsSpent[0]);
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
    assert.equal(room.view().playerTokenBudget, ROOM_TOKEN_BUDGET);
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