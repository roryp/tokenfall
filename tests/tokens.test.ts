import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, WIDTH, HEIGHT, placementsFor } from '../shared/game.ts';
import { emptyMetrics } from '../shared/protocol.ts';
import { packBoard, unpackBoard, buildPrompts, countTokens, tokenChips, decodeTokens, normalizeUsage, addUsage } from '../server/tokens.ts';

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

test('cached tokens remain in input totals and token budgets', () => {
  const usage = normalizeUsage({ prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } });
  const metrics = addUsage(emptyMetrics(), usage, 3000);
  assert.equal(metrics.input + metrics.output, 2020);
  assert.equal(metrics.cached, 1500);
  assert.equal(metrics.compressionSaved, 3000);
  assert.equal(usage.reasoning, 0);
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