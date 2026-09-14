import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadConfig, ROOT } from '../server/config.ts';
import { LunaGateway, MAX_OUTPUT_TOKENS, POLICY, PREFIX_TOKENS, RequestError } from '../server/model.ts';
import { refreshTokenPricing } from '../server/pricing.ts';
import { Room } from '../server/room.ts';
import { buildPrompts, packBoard } from '../server/tokens.ts';
import { boardMetrics, FPS, Game, placementsFor, refreshPlacement } from '../shared/game.ts';
import { costForUsage } from '../shared/protocol.ts';

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false },
  moves: { type: 'string', default: '100' },
  'min-lines': { type: 'string', default: '20' },
  'max-usd': { type: 'string', default: '0.20' },
  seed: { type: 'string', default: 'pure-luna-survival-20260914' },
  'no-compression': { type: 'boolean', default: false },
} });
if (!values.live) throw new Error('This evaluation makes paid Azure requests. Add --live to run it.');
const targetMoves = Number(values.moves);
const minimumLines = Number(values['min-lines']);
const maxUsd = Number(values['max-usd']);
const compression = !values['no-compression'];
if (!Number.isSafeInteger(targetMoves) || targetMoves < 1 || targetMoves > 200) throw new Error('--moves must be 1 through 200.');
if (!Number.isSafeInteger(minimumLines) || minimumLines < 0 || minimumLines > targetMoves * 4) throw new Error('Invalid --min-lines.');
if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 1) throw new Error('--max-usd must be greater than zero and at most 1.');

const directory = path.join(ROOT, 'data', 'luna-evaluations', new Date().toISOString().replace(/[:.]/g, '-'));
const config = { ...loadConfig(), dataDirectory: directory };
mkdirSync(directory, { recursive: true });
const room = new Room(config, new LunaGateway(config));
const started = Date.now();
const trace: unknown[] = [];
let stopReason = 'target';
let holds = 0;
let highestStack = 0;
let errorMessage: string | null = null;
let resultPath = '';

try {
  room.pricing = await refreshTokenPricing(room.pricing, config.deployment, config.pricingRegion ?? '');
  const rates = room.pricing.snapshot?.usdPerMillion;
  if (!rates) throw new Error('Verified rates are required before making paid evaluation requests.');
  room.join('Luna Evaluation', room.code, undefined, 'evaluation', undefined, true);
  const player = room.playerFor('evaluation');
  const client = new Game(values.seed);
  player.game = new Game(values.seed);
  client.act('pause');
  let sequence = 0;
  let sentEvents = 0;
  function sync() {
    client.advanceTo(Math.floor((Date.now() - player.started) * FPS / 1000));
    do {
      const events = client.events.slice(sentEvents, sentEvents + 64);
      const frame = sentEvents + events.length < client.events.length ? events[events.length - 1].frame : client.frame;
      room.inputs(player, { runId: player.runId, sequence: ++sequence, frame, events });
      sentEvents += events.length;
    } while (sentEvents < client.events.length);
  }
  sync();
  while (client.pieces < targetMoves && client.status !== 'over') {
    if (Date.now() - started > 8 * 60000) { stopReason = 'time-cap'; break; }
    sync();
    const prompts = buildPrompts(client, placementsFor(client));
    const reservation = PREFIX_TOKENS + (compression ? prompts.packedTokens : prompts.rawTokens) + MAX_OUTPUT_TOKENS + 1024;
    const projectedMaximum = ((reservation - MAX_OUTPUT_TOKENS) * Math.max(rates.input, rates.cachedInput, rates.cacheWrite) + MAX_OUTPUT_TOKENS * rates.output) / 1000000;
    if (costForUsage(player.metrics, rates).total + projectedMaximum > maxUsd) { stopReason = 'spending-cap'; break; }
    let result;
    try { result = await room.assist(player, { compression, cache: true, autopilot: true }); }
    catch (error) {
      if (error instanceof RequestError && ['cooldown', 'busy'].includes(error.code)) { await delay(Math.max(100, error.retryAfterMs)); continue; }
      throw error;
    }
    const insight = result.insight;
    if (insight.status !== 'ready' || !insight.placement || insight.usage.reasoning !== 0) throw new Error(`Model request ${player.record.attempts} returned ${insight.status}: ${insight.tip}`);
    sync();
    const selected = refreshPlacement(client, insight.placement);
    if (!selected || selected.id !== JSON.parse(insight.outputText).placementId) throw new Error('Model choice and executable input path differ.');
    const before = boardMetrics(client.well);
    client.act('resume');
    for (const action of selected.path) client.act(action);
    if (client.view().status !== 'over') client.act('pause');
    sync();
    const after = boardMetrics(client.well);
    for (const key of ['holes', 'aggregateHeight', 'maxHeight', 'bumpiness'] as const) assert.equal(after[key], selected[key], `Selected and executed ${key} differ`);
    assert.deepEqual(after.columnHeights, selected.columnHeights);
    assert.equal(client.view().status === 'over', selected.gameOver);
    assert.deepEqual(player.game.view(), client.view(), 'Server and client game states differ');
    highestStack = Math.max(highestStack, after.maxHeight);
    holds += Number(selected.useHold);
    const entry = {
      move: client.pieces, selected, before, after,
      lines: client.lines, score: client.score, status: client.status,
      usage: insight.usage, latencyMs: insight.latencyMs,
      costUsd: costForUsage(insight.usage, rates).total,
      prompt: insight.prompt, modelReply: insight.outputText,
    };
    trace.push(entry);
    writeFileSync(path.join(directory, 'trace.json'), JSON.stringify(trace));
    if (client.pieces % 10 === 0 || client.view().status === 'over') console.log(JSON.stringify({ moves: client.pieces, lines: client.lines, holds, ...entry.after, costUsd: costForUsage(player.metrics, rates).total, status: client.status }));
  }
  if (client.status === 'over') stopReason = 'game-over';
  else if (client.pieces >= targetMoves && client.lines < minimumLines) stopReason = 'insufficient-lines';
  const passed = client.pieces >= targetMoves && client.lines >= minimumLines && client.status !== 'over';
  const report = {
    passed, stopReason, seed: values.seed, targetMoves, minimumLines, maxUsd, compression,
    model: config.deployment, policySha256: createHash('sha256').update(POLICY).digest('hex'),
    moves: client.pieces, lines: client.lines, score: client.score, holds, highestStack,
    board: packBoard(client.well.toArray()), boardState: boardMetrics(client.well),
    metrics: player.metrics, costUsd: costForUsage(player.metrics, rates).total,
    unmeteredRequests: player.record.attempts - player.metrics.requests,
    durationMs: Date.now() - started, automaticResets: 0, solverSelections: 0,
  };
  resultPath = path.join(directory, 'result.json');
  writeFileSync(resultPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, resultPath }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  const player = [...room.players.values()][0];
  const report = { passed: false, stopReason: 'error', error: errorMessage, completedMoves: trace.length, metrics: player?.metrics, unmeteredRequests: player ? player.record.attempts - player.metrics.requests : 0 };
  resultPath = path.join(directory, 'result.json');
  writeFileSync(resultPath, JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ ...report, resultPath }));
} finally { room.close(); }