// Load test that plays real games over Socket.IO like a venue audience on one address: players join, play, restart after game over,
// optionally switch Luna autopilot on for a burst, while spectators only watch the room.
// node scripts/stress-room.ts --url https://host --players 500 --spectators 100 --join-seconds 90 --steady-seconds 360 --luna-bots 50 --luna-start 60 --luna-seconds 120
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { FPS, Game, refreshPlacement } from '../shared/game.ts';
import type { Action } from '../shared/game.ts';
import { MCP_LOOKUP_TIMEOUT_MS } from '../shared/protocol.ts';
import type { AiOptions, InputAck, InputBatch, Insight, JoinResult, PlayerUsage, Reply, RoomView } from '../shared/protocol.ts';

type Counts = Record<string, number>;
interface Stats {
  joinsOk: number; rejoinsOk: number; joinFail: Counts; joinLat: number[];
  inputsOk: number; inputFail: Counts; inputLat: number[];
  restartsOk: number; restartFail: Counts;
  assist: Counts; assistLat: number[];
  rooms: number; bytes: number; connectErrors: number; disconnects: Counts;
}
interface Gauges { sockets: number; connected: number; joined: number; pilots: number; online: number; loopP99: number; loopMax: number }
interface PlayerSpec { name: string; text?: string; joinAt: number; luna?: AiOptions }
interface Plan { url: string; code: string; flushMs: number; autopilotCooldownMs: number; lunaFrom: number; lunaUntil: number; endAt: number; reportMs: number; players: PlayerSpec[]; spectators: number[] }
type WorkerMessage = { type: 'stats'; stats: Stats; gauges: Gauges } | { type: 'done'; stats: Stats; gauges: Gauges };

const blank = (): Stats => ({ joinsOk: 0, rejoinsOk: 0, joinFail: {}, joinLat: [], inputsOk: 0, inputFail: {}, inputLat: [], restartsOk: 0, restartFail: {}, assist: {}, assistLat: [], rooms: 0, bytes: 0, connectErrors: 0, disconnects: {} });
const count = (counts: Counts, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const merge = (target: Stats, source: Stats) => {
  for (const key of ['joinsOk', 'rejoinsOk', 'inputsOk', 'restartsOk', 'rooms', 'bytes', 'connectErrors'] as const) target[key] += source[key];
  for (const key of ['joinFail', 'inputFail', 'restartFail', 'assist', 'disconnects'] as const) for (const [name, value] of Object.entries(source[key])) target[key][name] = (target[key][name] ?? 0) + value;
  for (const key of ['joinLat', 'inputLat', 'assistLat'] as const) for (const value of source[key]) target[key].push(value);
};
const percentile = (sorted: Float64Array, p: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]) : 0;
const latency = (values: number[]) => {
  const sorted = Float64Array.from(values).sort();
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: percentile(sorted, 100) };
};
const brief = (counts: Counts) => Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(',') || '-';
const failure = (error: Error | null, reply: Reply<unknown>) => error ? 'timeout' : reply.ok ? '' : reply.code ?? 'error';
const retryAfter = (error: Error | null, reply: Reply<unknown>) => error || reply.ok ? 0 : reply.retryAfterMs ?? 0;

if (isMainThread) await main();
else await runWorker(workerData as Plan);

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string' },
    players: { type: 'string', default: '10' },
    spectators: { type: 'string', default: '0' },
    'join-seconds': { type: 'string', default: '60' },
    'steady-seconds': { type: 'string', default: '120' },
    'luna-bots': { type: 'string', default: '0' },
    'luna-start': { type: 'string', default: '30' },
    'luna-seconds': { type: 'string', default: '120' },
    'sentence-share': { type: 'string', default: '0.7' },
    prefix: { type: 'string', default: 'Stress-' },
    workers: { type: 'string', default: '2' },
    'report-seconds': { type: 'string', default: '10' },
  } });
  const number = (name: keyof typeof values) => {
    const value = Number(values[name]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number.`);
    return value;
  };
  if (!values.url) throw new Error('--url is required.');
  const url = values.url.replace(/\/$/, '');
  const players = Math.floor(number('players'));
  const spectators = Math.floor(number('spectators'));
  const lunaBots = Math.min(players, Math.floor(number('luna-bots')));
  const workerCount = Math.max(1, Math.floor(number('workers')));
  const reportMs = number('report-seconds') * 1000;
  if (!/^[\p{L}\p{N} _-]{1,12}$/u.test(values.prefix!)) throw new Error('--prefix must be at most 12 letters, numbers, spaces, underscores or hyphens.');

  const room = await (await fetch(`${url}/api/room`)).json() as RoomView & { autopilotCooldownMs?: number; requestsRemaining?: number };
  console.log(`Target ${url} room ${room.code}: ${room.online}/${room.capacity} online, ${room.requestsRemaining ?? '?'} room Luna requests left.`);
  if (players > room.capacity - room.online) console.warn(`Only ${room.capacity - room.online} seats are free; extra players will be refused as full.`);

  const start = Date.now() + 3000;
  const joinMs = number('join-seconds') * 1000;
  const steadyFrom = start + joinMs;
  const endAt = steadyFrom + number('steady-seconds') * 1000;
  const lunaFrom = steadyFrom + number('luna-start') * 1000;
  const lunaUntil = lunaFrom + number('luna-seconds') * 1000;
  const lunaEvery = lunaBots ? Math.max(1, Math.floor(players / lunaBots)) : 0;
  const specs: PlayerSpec[] = Array.from({ length: players }, (_, index) => {
    const lunaIndex = lunaEvery && index % lunaEvery === 0 ? index / lunaEvery : -1;
    const luna = lunaIndex >= 0 && lunaIndex < lunaBots
      // A workshop mix: cache always on, half compress, every fifth uses MCP lookahead and every tenth reasons.
      ? { cache: true, compression: lunaIndex % 2 === 0, mcp: lunaIndex % 5 === 1, reasoning: lunaIndex % 10 === 3, autopilot: true }
      : undefined;
    return {
      name: `${values.prefix}${String(index + 1).padStart(3, '0')}`,
      ...(Math.random() < number('sentence-share') ? { text: `Stress player ${index + 1} stacks real tokens in Tokenfall.` } : {}),
      joinAt: start + Math.round(index / Math.max(1, players) * joinMs),
      ...(luna ? { luna } : {}),
    };
  });
  const spectatorTimes = Array.from({ length: spectators }, (_, index) => start + Math.round(index / Math.max(1, spectators) * Math.min(joinMs, 15000)));
  console.log(`Plan: ${players} players over ${joinMs / 1000}s (${specs.filter(spec => spec.text).length} with sentences), ${spectators} spectators, ${lunaBots} Luna autopilot bots from +${Math.round((lunaFrom - start) / 1000)}s to +${Math.round((lunaUntil - start) / 1000)}s, end at +${Math.round((endAt - start) / 1000)}s, ${workerCount} workers.`);

  const totals = blank();
  let interval = blank();
  const gauges = new Map<number, Gauges>();
  const finished = new Set<number>();
  const workers = Array.from({ length: workerCount }, (_, worker) => {
    const plan: Plan = {
      url, code: room.code, flushMs: 400, autopilotCooldownMs: room.autopilotCooldownMs ?? 1000, lunaFrom, lunaUntil, endAt, reportMs,
      players: specs.filter((_, index) => index % workerCount === worker), spectators: spectatorTimes.filter((_, index) => index % workerCount === worker),
    };
    const thread = new Worker(new URL(import.meta.url), { workerData: plan });
    thread.on('message', (message: WorkerMessage) => {
      merge(totals, message.stats);
      merge(interval, message.stats);
      gauges.set(worker, message.gauges);
      if (message.type === 'done') { finished.add(worker); void thread.terminate(); }
    });
    thread.on('error', error => { console.error(`Worker ${worker} failed:`, error); finished.add(worker); });
    return thread;
  });
  const stop = () => { for (const thread of workers) thread.postMessage('stop'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const health: number[] = [];
  const healthFailures: Counts = {};
  let server: { online: number; requestsRemaining?: number } = { online: room.online, requestsRemaining: room.requestsRemaining };
  const probe = setInterval(async () => {
    const started = performance.now();
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10000) });
      if (response.ok) health.push(performance.now() - started); else count(healthFailures, String(response.status));
    } catch (error) { count(healthFailures, error instanceof Error ? error.name : 'error'); }
  }, 5000);
  let healthReported = 0;
  const report = setInterval(async () => {
    try { server = await (await fetch(`${url}/api/room`, { signal: AbortSignal.timeout(10000) })).json(); } catch { /* keep the last snapshot */ }
    const all = [...gauges.values()];
    const sum = (key: keyof Gauges) => all.reduce((total, gauge) => total + gauge[key], 0);
    const seconds = reportMs / 1000;
    const inputs = latency(interval.inputLat);
    const joins = latency(interval.joinLat);
    const assists = latency(interval.assistLat);
    const recentHealth = latency(health.slice(healthReported));
    healthReported = health.length;
    const phase = Date.now() < steadyFrom ? 'join' : Date.now() >= lunaFrom && Date.now() < lunaUntil && lunaBots ? 'luna' : 'steady';
    console.log(`[+${Math.round((Date.now() - start) / 1000)}s ${phase}] sockets ${sum('connected')}/${sum('sockets')} joined ${sum('joined')} serverOnline ${server.online} pilots ${sum('pilots')} | joins ${interval.joinsOk} rejoins ${interval.rejoinsOk} fail ${brief(interval.joinFail)} p95 ${joins.p95}ms max ${joins.max}ms | inputs ${(interval.inputsOk / seconds).toFixed(0)}/s p50 ${inputs.p50} p95 ${inputs.p95} p99 ${inputs.p99} max ${inputs.max}ms fail ${brief(interval.inputFail)} | restarts ${interval.restartsOk} fail ${brief(interval.restartFail)} | luna ${brief(interval.assist)} p50 ${assists.p50} p95 ${assists.p95}ms | room ${(interval.rooms / seconds).toFixed(0)} msg/s ${(interval.bytes / seconds / 1e6).toFixed(2)} MB/s | health p95 ${recentHealth.p95}ms fail ${brief(healthFailures)} | disconnects ${brief(interval.disconnects)} connectErrors ${interval.connectErrors} | requestsLeft ${server.requestsRemaining ?? '?'} | loadgen loop p99 ${Math.max(0, ...all.map(gauge => gauge.loopP99))}ms max ${Math.max(0, ...all.map(gauge => gauge.loopMax))}ms`);
    interval = blank();
  }, reportMs);

  while (finished.size < workers.length) await new Promise(resolve => setTimeout(resolve, 500));
  clearInterval(probe);
  clearInterval(report);
  const durationSeconds = Math.max(1, (Date.now() - start) / 1000);
  console.log(`STRESS_SUMMARY ${JSON.stringify({
    url, roomCode: room.code, players, spectators, lunaBots, durationSeconds: Math.round(durationSeconds),
    joins: { ok: totals.joinsOk, rejoins: totals.rejoinsOk, failed: totals.joinFail, latencyMs: latency(totals.joinLat) },
    inputs: { ok: totals.inputsOk, perSecond: Math.round(totals.inputsOk / durationSeconds), failed: totals.inputFail, latencyMs: latency(totals.inputLat) },
    restarts: { ok: totals.restartsOk, failed: totals.restartFail },
    luna: { outcomes: totals.assist, latencyMs: latency(totals.assistLat) },
    room: { messages: totals.rooms, megabytes: Math.round(totals.bytes / 1e6), averageMBps: Number((totals.bytes / durationSeconds / 1e6).toFixed(2)) },
    health: { latencyMs: latency(health), failed: healthFailures },
    disconnects: totals.disconnects, connectErrors: totals.connectErrors, finalServer: { online: server.online, requestsRemaining: server.requestsRemaining },
  })}`);
  process.exit(0);
}

async function runWorker(plan: Plan) {
  let stats = blank();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const sockets: Socket[] = [];
  let latestOnline = 0;
  let stopping = false;
  const connect = () => {
    const socket = io(plan.url, { transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 750, reconnectionDelayMax: 4000, forceNew: true, timeout: 20000 });
    socket.io.on('open', () => socket.io.engine.on('data', data => { stats.bytes += typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength; }));
    socket.on('connect_error', () => { stats.connectErrors += 1; });
    socket.on('disconnect', reason => { if (!stopping) count(stats.disconnects, reason); });
    socket.on('room', (view: RoomView) => { stats.rooms += 1; latestOnline = view.online; });
    sockets.push(socket);
    return socket;
  };

  class Bot {
    socket: Socket | null = null;
    game: Game | null = null;
    token?: string;
    runId = '';
    sequence = 0;
    sent = 0;
    batch: InputBatch | null = null;
    sending = false;
    lastFlush = 0;
    nextAction = 0;
    clockStart = 0;
    clockFrame = 0;
    joined = false;
    joining = false;
    retryJoinAt = 0;
    overAt = 0;
    restarting = false;
    pilot = false;
    pilotPending = false;
    pilotFailures = 0;
    pilotBlocked = false;
    nextRequestAt = 0;
    spec: PlayerSpec;
    constructor(spec: PlayerSpec) { this.spec = spec; }

    start() {
      this.socket = connect();
      this.socket.on('connect', () => { this.join(); });
      this.socket.on('disconnect', () => { this.joined = false; this.joining = false; this.pilotPending = false; });
    }

    join() {
      if (this.joining || stopping || !this.socket?.connected) return;
      this.joining = true;
      const rejoin = Boolean(this.token);
      const payload = this.token ? { name: this.spec.name, room: plan.code, token: this.token } : { name: this.spec.name, room: plan.code, ...(this.spec.text ? { text: this.spec.text } : {}) };
      const sentAt = performance.now();
      this.socket.timeout(8000).emit('join', payload, (error: Error | null, reply: Reply<JoinResult>) => {
        this.joining = false;
        if (error || !reply.ok) {
          const code = failure(error, reply);
          count(stats.joinFail, code);
          if (code === 'session') this.token = undefined;
          this.retryJoinAt = Date.now() + Math.max(2000, retryAfter(error, reply)) + Math.random() * 2000;
          return;
        }
        stats.joinLat.push(performance.now() - sentAt);
        if (rejoin) stats.rejoinsOk += 1; else stats.joinsOk += 1;
        this.token = reply.data.token || this.token;
        this.install(reply.data);
        this.joined = true;
      });
    }

    install(data: JoinResult) {
      this.game = Game.restore(data.replay);
      this.runId = data.runId;
      this.sequence = data.sequence;
      this.sent = data.replay.events.length;
      this.batch = null;
      this.sending = false;
      this.clockStart = performance.now();
      this.clockFrame = this.game.frame;
      this.overAt = 0;
      this.restarting = false;
      this.pilotPending = false;
    }

    resync() {
      // Like the browser after a rejected batch: take the server's replay instead of guessing.
      this.joined = false;
      this.retryJoinAt = Date.now() + 500 + Math.random() * 1000;
    }

    flush() {
      if (!this.joined || this.sending || !this.game || !this.socket?.connected) return;
      if (!this.batch) {
        const events = this.game.events.slice(this.sent, this.sent + 64);
        const more = this.sent + events.length < this.game.events.length;
        this.batch = { runId: this.runId, sequence: this.sequence + 1, frame: more ? events.at(-1)?.frame ?? this.game.frame : this.game.frame, events };
      }
      const batch = this.batch;
      this.sending = true;
      this.lastFlush = performance.now();
      const sentAt = this.lastFlush;
      this.socket.timeout(5000).emit('inputs', batch, (error: Error | null, reply: Reply<InputAck>) => {
        if (this.batch !== batch || this.runId !== batch.runId) return;
        this.sending = false;
        if (!error && !reply.ok && reply.code === 'maintenance') return;
        if (error || !reply.ok) { count(stats.inputFail, failure(error, reply)); this.batch = null; this.resync(); return; }
        stats.inputsOk += 1;
        stats.inputLat.push(performance.now() - sentAt);
        this.sent += batch.events.length;
        this.sequence = reply.data.sequence;
        this.batch = null;
      });
    }

    restart() {
      this.restarting = true;
      this.socket!.timeout(8000).emit('restart', (error: Error | null, reply: Reply<JoinResult>) => {
        this.restarting = false;
        if (error || !reply.ok) {
          const code = failure(error, reply);
          count(stats.restartFail, code);
          this.overAt = Date.now() + Math.max(2000, retryAfter(error, reply));
          if (code === 'session') this.resync();
          return;
        }
        stats.restartsOk += 1;
        this.install(reply.data);
      });
    }

    ask(options: AiOptions, now: number) {
      this.pilotPending = true;
      this.nextRequestAt = now + plan.autopilotCooldownMs;
      const runId = this.runId;
      const sentAt = performance.now();
      this.socket!.timeout((options.reasoning ? 65000 : 25000) + (options.mcp ? MCP_LOOKUP_TIMEOUT_MS : 0)).emit('assist', options, (error: Error | null, reply: Reply<{ insight: Insight } & PlayerUsage>) => {
        if (!this.pilotPending || runId !== this.runId) return;
        this.pilotPending = false;
        if (error) { count(stats.assist, 'timeout'); this.defer(0); return; }
        if (!reply.ok) {
          count(stats.assist, reply.code ?? 'error');
          if (reply.code === 'busy' || reply.code === 'cooldown') this.nextRequestAt = Date.now() + Math.max(1000, reply.retryAfterMs ?? 0);
          else if (['mcp', 'unavailable', 'rate'].includes(reply.code ?? '')) this.defer(reply.retryAfterMs ?? 0);
          else this.pilotBlocked = true;
          return;
        }
        stats.assistLat.push(performance.now() - sentAt);
        const insight = reply.data.insight;
        const current = this.game && insight.pieceId === this.game.pieceId;
        count(stats.assist, current ? insight.status : 'stale');
        // Like the browser, a reply that arrives after autopilot ended is reported but not played.
        if (!this.pilot || !current || insight.status !== 'ready' || !insight.placement || !this.game) return;
        const placement = refreshPlacement(this.game, insight.placement);
        if (!placement) { count(stats.assist, 'unusable'); return; }
        if (this.game.status === 'paused') this.game.act('resume');
        for (const action of placement.path) this.game.act(action);
        if (this.game.status !== 'over') this.game.act('pause');
        this.pilotFailures = 0;
        this.flush();
      });
    }

    defer(retryAfterMs: number) {
      this.pilotFailures += 1;
      if (this.pilotFailures > 3) { this.pilotBlocked = true; return; }
      this.nextRequestAt = Date.now() + Math.max(retryAfterMs, 2000 * 2 ** (this.pilotFailures - 1));
    }

    step(now: number) {
      if (!this.socket) { if (now >= this.spec.joinAt) this.start(); return; }
      if (!this.joined) { if (this.socket.connected && this.retryJoinAt && now >= this.retryJoinAt) { this.retryJoinAt = 0; this.join(); } return; }
      const game = this.game!;
      const target = this.clockFrame + Math.floor((performance.now() - this.clockStart) * FPS / 1000);
      while (game.frame < target) game.tick();
      const pilot = Boolean(this.spec.luna) && !this.pilotBlocked && now >= plan.lunaFrom && now < plan.lunaUntil;
      if (pilot !== this.pilot) {
        this.pilot = pilot;
        if (game.status !== 'over') { game.act(pilot ? 'pause' : 'resume'); this.flush(); }
      }
      if (game.status === 'over') {
        if (!this.overAt) this.overAt = now + 2000 + Math.random() * 3000;
        else if (now >= this.overAt && !this.restarting && !this.sending && !this.pilotPending && this.sent >= game.events.length) this.restart();
      } else if (this.pilot) {
        if (game.status === 'playing') { game.act('pause'); this.flush(); }
        if (!this.pilotPending && now >= this.nextRequestAt) {
          if (this.sending || this.sent < game.events.length) this.flush();
          else this.ask(this.spec.luna!, now);
        }
      } else if (game.status === 'paused') {
        if (!this.pilotPending) { game.act('resume'); this.flush(); }
      } else if (now >= this.nextAction) {
        this.nextAction = now + 150 + Math.random() * 300;
        const roll = Math.random();
        const action: Action = roll < 0.22 ? 'left' : roll < 0.44 ? 'right' : roll < 0.62 ? 'rotateCW' : roll < 0.68 ? 'rotateCCW' : roll < 0.80 ? 'softDrop' : roll < 0.96 ? 'hardDrop' : 'hold';
        game.act(action);
        if (action === 'hardDrop' || action === 'hold') this.flush();
      }
      if (performance.now() - this.lastFlush >= plan.flushMs) this.flush();
    }
  }

  const bots = plan.players.map(spec => new Bot(spec));
  const watchers = [...plan.spectators];
  const gauges = (): Gauges => ({
    sockets: sockets.length, connected: sockets.filter(socket => socket.connected).length, joined: bots.filter(bot => bot.joined).length,
    pilots: bots.filter(bot => bot.pilot).length, online: latestOnline,
    loopP99: Math.round(loop.percentile(99) / 1e6), loopMax: Math.round(loop.max / 1e6),
  });
  const publish = (type: 'stats' | 'done') => {
    parentPort!.postMessage({ type, stats, gauges: gauges() } satisfies WorkerMessage);
    stats = blank();
    loop.reset();
  };
  const reporter = setInterval(() => publish('stats'), plan.reportMs);
  const finish = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(ticker);
    clearInterval(reporter);
    for (const socket of sockets) socket.disconnect();
    await new Promise(resolve => setTimeout(resolve, 1000));
    // The main thread terminates this worker once the final stats arrive.
    publish('done');
  };
  parentPort!.on('message', message => { if (message === 'stop') void finish(); });
  const ticker = setInterval(() => {
    const now = Date.now();
    if (now >= plan.endAt) { void finish(); return; }
    while (watchers.length && watchers[0] <= now) { watchers.shift(); connect(); }
    for (const bot of bots) {
      try { bot.step(now); } catch (error) { count(stats.inputFail, `bot-${error instanceof Error ? error.message.slice(0, 40) : 'error'}`); bot.resync(); }
    }
  }, 25);
}
