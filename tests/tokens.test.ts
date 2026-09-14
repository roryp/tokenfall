import test from 'node:test';
import assert from 'node:assert/strict';
import { ghostCells, pieceCells, spawnTetromino } from 'miaoda-game-fallblock-core';
import { Game, WIDTH, HEIGHT, placementsFor } from '../shared/game.ts';
import { costForUsage, emptyMetrics, pointsPerCent, tokenCreditsUsed } from '../shared/protocol.ts';
import { packBoard, unpackBoard, buildPrompts, countTokens, tokenChips, decodeTokens, normalizeUsage, addUsage, gameTokens } from '../server/tokens.ts';
import { fetchTokenPricing, refreshTokenPricing, selectTokenPricing } from '../server/pricing.ts';

function priceMeters() {
  return [
    ['5.6 luna ShortCo Inp Std Gl', 0.20], ['5.6 luna ShortCo Cd Inp Std Gl', 0.02],
    ['5.6 luna ShortCo Cd Wr Std Gl', 0.25], ['5.6 luna ShortCo Opt Std Gl', 1.20],
  ].map(([skuName, retailPrice], index) => ({
    skuName, retailPrice, productName: 'Azure OpenAI GPT5', meterName: `${skuName} 1M Tokens`, meterId: `meter-${index}`,
    unitOfMeasure: '1M', currencyCode: 'USD', effectiveStartDate: '2026-08-01T00:00:00Z',
    type: 'Consumption', armRegionName: 'eastus2', isPrimaryMeterRegion: true, tierMinimumUnits: 0,
  }));
}

test('lossless packing preserves every cell, including hidden rows and holes', () => {
  const game = new Game('codec');
  game.well.set(0, 0, 'T');
  game.well.set(9, HEIGHT - 1, 'L');
  game.well.set(5, HEIGHT - 3, 'S');
  assert.deepEqual(unpackBoard(packBoard(game.well.toArray())), game.well.toArray());
});

test('the board codec rejects malformed dimensions and unrecognized cells', () => {
  assert.throws(() => unpackBoard(['..........']));
  assert.throws(() => unpackBoard(Array.from({ length: HEIGHT }, () => 'bad-board!')));
  assert.throws(() => packBoard(Array(WIDTH * HEIGHT - 1).fill(null)));
});

test('packed prompts preserve placement information and substantially reduce actual encoded payload tokens', () => {
  const game = new Game('compression');
  game.act('hardDrop');
  const prompts = buildPrompts(game, placementsFor(game));
  const verbose = JSON.parse(prompts.verbose);
  const packed = JSON.parse(prompts.packed);
  assert.deepEqual(packed.placements, verbose.placements);
  assert.deepEqual(packed.active, verbose.active);
  assert.deepEqual(packed.next, verbose.next);
  assert.deepEqual(unpackBoard(packed.board), verbose.board.map((cell: { value: unknown }) => cell.value));
  assert.ok(prompts.packedTokens < prompts.rawTokens * 0.6);
});

test('tokenization uses the real o200k encoding rather than word counts', () => {
  assert.equal(countTokens('hello world'), 2);
  assert.ok(countTokens('antidisestablishmentarianism') > 1);
  const sample = 'Tokens, spaces, and punctuation!';
  assert.equal(decodeTokens(tokenChips(sample).map(token => token.id)), sample);
  assert.doesNotThrow(() => countTokens('<|endoftext|>'));
});

test('game pieces use every real token, including punctuation and Unicode byte fragments', () => {
  for (const text of ['hello world', 'antidisestablishmentarianism', ' spaces\n\ttabs!', '\u4f60\u597d\ud83d\ude80']) {
    const tokens = gameTokens(text);
    assert.equal(tokens.length, countTokens(text));
    assert.equal(decodeTokens(tokens.map(token => token.id)), text);
  }
  assert.throws(() => gameTokens(''));
  assert.throws(() => gameTokens('a'.repeat(501)));
});

test('custom token text never enters the model prompt while packed shape information remains lossless', () => {
  const text = 'private_token_text_never_send_to_model';
  const game = new Game('private-token-run', gameTokens(text));
  const prompts = buildPrompts(game, placementsFor(game));
  assert.ok(!prompts.verbose.includes(text));
  assert.ok(!prompts.packed.includes(text));
  assert.deepEqual(Object.keys(JSON.parse(prompts.packed)).sort(), ['active', 'board', 'boardState', 'canHold', 'coordinateOrder', 'height', 'hiddenRows', 'hold', 'level', 'lines', 'next', 'piecesPlaced', 'placements', 'randomizer', 'score', 'width']);
  assert.deepEqual(unpackBoard(JSON.parse(prompts.packed).board), game.well.toArray());
  assert.deepEqual(JSON.parse(prompts.packed).next, game.queue.peek());
});

test('Luna receives unranked Hold choices, terminal facts and the real current-board profile', () => {
  const game = new Game('luna-context');
  game.act('hardDrop');
  const candidates = placementsFor(game);
  const prompts = buildPrompts(game, candidates);
  const packed = JSON.parse(prompts.packed);
  const verbose = JSON.parse(prompts.verbose);
  assert.equal(packed.height, 22);
  assert.equal(packed.hiddenRows, 2);
  assert.equal(packed.randomizer, 'seven-bag');
  assert.equal(packed.boardState.columnHeights.length, 10);
  assert.equal(packed.boardState.aggregateHeight, packed.boardState.columnHeights.reduce((sum: number, height: number) => sum + height, 0));
  assert.deepEqual(packed.placements.map((placement: { id: string }) => placement.id), candidates.map(candidate => candidate.id));
  assert.ok(packed.placements.some((placement: { useHold: boolean }) => placement.useHold));
  assert.ok(packed.placements.every((placement: { gameOver: boolean; columnHeights: number[] }) => typeof placement.gameOver === 'boolean' && placement.columnHeights.length === 10));
  assert.deepEqual(packed.placements, verbose.placements);
  assert.deepEqual(packed.boardState, verbose.boardState);
  assert.equal(packed.next.length, 5);
});

test('the full board and exact active, ghost and candidate cells reach Luna in both formats', () => {
  const game = new Game('explicit-positions');
  game.well.set(9, 0, 'J');
  game.well.set(0, HEIGHT - 1, 'S');
  game.well.set(1, HEIGHT - 2, 'T');
  game.well.set(1, HEIGHT - 1, 'Z');
  game.act('rotateCW');
  game.act('left');
  const before = game.view();
  const candidates = placementsFor(game);
  const prompts = buildPrompts(game, candidates);
  const verbose = JSON.parse(prompts.verbose);
  const packed = JSON.parse(prompts.packed);
  assert.equal(verbose.board.length, WIDTH * HEIGHT);
  assert.equal(packed.board.length, HEIGHT);
  assert.ok(packed.board.every((row: string) => row.length === WIDTH));
  assert.deepEqual(unpackBoard(packed.board), game.well.toArray());
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    assert.deepEqual(verbose.board[index], { row: Math.floor(index / WIDTH), column: index % WIDTH, value: game.well.toArray()[index] });
  }
  const coordinates = (cells: { x: number; y: number }[]) => cells.map(cell => [cell.x, cell.y]);
  for (const prompt of [verbose, packed]) {
    assert.equal(prompt.coordinateOrder, '[column,row]');
    assert.ok(Object.keys(prompt).indexOf('board') < Object.keys(prompt).indexOf('placements'));
    assert.deepEqual(prompt.active.cells, coordinates(pieceCells(game.active)));
    assert.deepEqual(prompt.active.hardDropCells, coordinates(ghostCells(game.well, game.active)));
    assert.equal(prompt.piecesPlaced, game.pieces);
    assert.equal(prompt.lines, game.lines);
    assert.equal(prompt.score, game.score);
    assert.equal(prompt.placements.length, candidates.length);
    candidates.forEach((candidate, index) => {
      const piece = spawnTetromino(candidate.piece, candidate.piece, candidate.column, candidate.row);
      piece.cells = piece.orientations![candidate.rotation];
      assert.deepEqual(prompt.placements[index].cells, coordinates(pieceCells(piece)));
      assert.equal(prompt.placements[index].id, candidate.id);
    });
  }
  assert.deepEqual(verbose.placements, packed.placements);
  assert.deepEqual(game.view(), before);
});

test('verified cache hits preserve gameplay credits without hiding provider tokens', () => {
  const usage = normalizeUsage({ prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } });
  const metrics = addUsage(emptyMetrics(), usage, 3000, true);
  assert.equal(metrics.input + metrics.output, 2020);
  assert.equal(metrics.cached, 1500);
  assert.equal(metrics.compressionSaved, 3000);
  assert.equal(tokenCreditsUsed(metrics), 520);
  assert.equal(tokenCreditsUsed(usage), 520);
  const cacheWrite = { ...usage, cached: 0, cacheWrites: 1500 };
  assert.equal(tokenCreditsUsed(cacheWrite), 2020);
  assert.equal(usage.reasoning, 0);
});

test('cache counters separate hits, write misses, ordinary misses and bypassed requests', () => {
  const base = { input: 2000, output: 20, total: 2020, cached: 0, cacheWrites: 0, reasoning: 0 };
  const initial = emptyMetrics();
  const bypassed = addUsage(initial, base, 0, false);
  const written = addUsage(bypassed, { ...base, cacheWrites: 1200 }, 3000, true);
  const hit = addUsage(written, { ...base, cached: 1200 }, 3000, true);
  const missed = addUsage(hit, base, 3000, true);
  assert.equal(missed.requests, 4);
  assert.equal(missed.cacheHits, 1);
  assert.equal(missed.cacheMisses, 2);
  assert.equal(missed.cacheBypassed, 1);
  assert.equal(missed.cached, 1200);
  assert.equal(missed.cacheWrites, 1200);
  assert.equal(missed.compressionSaved, 9000);
  assert.deepEqual(initial, emptyMetrics());
});

test('retail cost prices ordinary input, cache reads, writes and output exactly once', () => {
  const rates = { input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20 };
  const usage = { input: 1000000, cached: 300000, cacheWrites: 200000, output: 100000 };
  const cost = costForUsage(usage, rates);
  assert.equal(cost.input, 0.10);
  assert.equal(cost.cachedInput, 0.006);
  assert.equal(cost.cacheWrite, 0.05);
  assert.equal(cost.output, 0.12);
  assert.ok(Math.abs(cost.total - 0.276) < 1e-12);
  assert.throws(() => costForUsage({ ...usage, input: 400000 }, rates));
  assert.throws(() => costForUsage(usage, { ...rates, cachedInput: NaN }));
});

test('measured Luna usage shows the real compression saving, cache discount and write premium', () => {
  const rates = { input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20 };
  const raw = costForUsage({ input: 9472, output: 36, cached: 0, cacheWrites: 0 }, rates);
  const packed = costForUsage({ input: 3128, output: 36, cached: 0, cacheWrites: 0 }, rates);
  const write = costForUsage({ input: 3128, output: 36, cached: 0, cacheWrites: 1549 }, rates);
  const hit = costForUsage({ input: 3128, output: 36, cached: 1549, cacheWrites: 0 }, rates);
  assert.ok(Math.abs(raw.total - 0.0019376) < 1e-12);
  assert.ok(Math.abs(write.total - 0.00074625) < 1e-12);
  assert.ok(Math.abs(hit.total - 0.00038998) < 1e-12);
  assert.ok(raw.total > packed.total);
  assert.ok(write.total > packed.total);
  assert.ok(hit.total < packed.total);
});

test('points per cent rewards lower actual spend without a flat bonus or division by zero', () => {
  assert.equal(pointsPerCent(1000, 0.002), 5000);
  assert.equal(pointsPerCent(1000, 0.001), 10000);
  assert.equal(pointsPerCent(0, 0.001), 0);
  assert.equal(pointsPerCent(1000, 0), null);
  assert.equal(pointsPerCent(1000, NaN), null);
});

test('live pricing selects only matching current USD Global Standard short-context meters', () => {
  const meters = priceMeters();
  const current = selectTokenPricing([
    ...meters,
    { ...meters[0], skuName: '5.6 luna ShortCo Inp Std DZ', retailPrice: 99 },
    { ...meters[0], unitOfMeasure: '1K', retailPrice: 99 },
    { ...meters[0], currencyCode: 'EUR', retailPrice: 99 },
    { ...meters[0], effectiveStartDate: '2099-01-01T00:00:00Z', retailPrice: 99 },
    { ...meters[0], effectiveStartDate: '2026-09-01T00:00:00Z', retailPrice: 0.21 },
  ], 'gpt-5.6-luna', 'eastus2', Date.parse('2026-09-11T00:00:00Z'));
  assert.deepEqual(current.usdPerMillion, { input: 0.21, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20 });
  assert.equal(current.meters.input.effectiveFrom, '2026-09-01T00:00:00Z');
  assert.equal(current.checkedAt, '2026-09-11T00:00:00.000Z');
  assert.throws(() => selectTokenPricing(meters.slice(1), 'gpt-5.6-luna', 'eastus2'));
  assert.throws(() => selectTokenPricing(meters, 'another-model', 'eastus2'));
  assert.throws(() => selectTokenPricing([...meters, { ...meters[0], retailPrice: 99 }], 'gpt-5.6-luna', 'eastus2'));
});

test('the rate loader follows Azure pagination and cannot follow a foreign pricing URL', async () => {
  const meters = priceMeters();
  const requests: string[] = [];
  const pricing = await fetchTokenPricing('gpt-5.6-luna', 'eastus2', async request => {
    requests.push(String(request));
    return new Response(JSON.stringify({ Items: requests.length === 1 ? meters.slice(0, 2) : meters.slice(2), NextPageLink: requests.length === 1 ? 'https://prices.azure.com/api/retail/prices?$skip=2' : null }));
  });
  assert.equal(requests.length, 2);
  assert.ok(new URL(requests[0]).searchParams.get('$filter')?.includes("skuName eq '5.6 luna ShortCo Cd Wr Std Gl'"));
  assert.equal(pricing.usdPerMillion.cacheWrite, 0.25);
  await assert.rejects(() => fetchTokenPricing('gpt-5.6-luna', 'eastus2', async () => new Response(JSON.stringify({ Items: [], NextPageLink: 'https://other.example/prices' }))));
});

test('failed live price refreshes retain dated last-known rates without inventing zero or fresh prices', async () => {
  const snapshot = selectTokenPricing(priceMeters(), 'gpt-5.6-luna', 'eastus2');
  const unavailable = async () => new Response('', { status: 503 });
  assert.deepEqual(await refreshTokenPricing({ status: 'live', snapshot }, 'gpt-5.6-luna', 'eastus2', unavailable), { status: 'stale', snapshot });
  assert.deepEqual(await refreshTokenPricing({ status: 'loading', snapshot: null }, 'gpt-5.6-luna', 'eastus2', unavailable), { status: 'unavailable', snapshot: null });
});

test('missing reasoning telemetry is unknown, not a fabricated zero', () => {
  const usage = normalizeUsage({ prompt_tokens: 1200, completion_tokens: 10, total_tokens: 1210, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1100 } });
  assert.equal(usage.reasoning, null);
  assert.equal(usage.cacheWrites, 1100);
});

test('negative or internally inconsistent provider counters are rejected', () => {
  assert.throws(() => normalizeUsage({ prompt_tokens: -1 }));
  assert.throws(() => normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 999, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }));
});