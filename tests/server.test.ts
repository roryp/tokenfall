import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { Game } from '../shared/game.ts';
import { emptyMetrics } from '../shared/protocol.ts';
import type { Insight, JoinResult, Reply, RoomView } from '../shared/protocol.ts';
import { createApplication } from '../server/app.ts';
import { ModelGate, PLAYER_TOKEN_BUDGET, ROOM_TOKEN_BUDGET } from '../server/model.ts';
import type { ModelGateway } from '../server/model.ts';
import { Room } from '../server/room.ts';

function fixture() {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'tokenfall-test-'));
  const config = { port: 3100, endpoint: 'https://test.openai.azure.com', deployment: 'test-only', tenantId: 'test', dataDirectory };
  const gateway: ModelGateway = { complete: async game => insightFor(game) };
  return { dataDirectory, config, gateway };
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