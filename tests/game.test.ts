import test from 'node:test';
import assert from 'node:assert/strict';
import { canPlace, ghostPiece, rotateWithKicks, kicksFor, spawnTetromino } from 'miaoda-game-fallblock-core';
import { Game, HEIGHT, WIDTH, placementsFor, refreshPlacement, scoreClear } from '../shared/game.ts';
import type { Cell } from '../shared/game.ts';

test('the board is ten columns by twenty visible rows and two spawn rows', () => {
  const game = new Game('dimensions');
  assert.equal(game.well.width, 10);
  assert.equal(game.well.height, 22);
  assert.equal(game.active.cells.length, 4);
  assert.ok(canPlace(game.well, game.active));
  assert.equal(game.queue.peek().length, 5);
});

test('every seven-bag contains all seven pieces with deterministic seeding', () => {
  const first = new Game('audience-round');
  const second = new Game('audience-round');
  const pieces = [first.piece, ...Array.from({ length: 13 }, () => first.queue.take())];
  const replayed = [second.piece, ...Array.from({ length: 13 }, () => second.queue.take())];
  assert.deepEqual(pieces, replayed);
  assert.equal(new Set(pieces.slice(0, 7)).size, 7);
  assert.equal(new Set(pieces.slice(7, 14)).size, 7);
});

test('I uses SRS kicks when rotating away from the left wall', () => {
  const game = new Game('wall');
  const spawned = spawnTetromino<Cell>('I', 'I', -2, 5);
  const vertical = { ...spawned, rot: 1 as const, cells: spawned.orientations![1] };
  assert.ok(canPlace(game.well, vertical));
  const rotated = rotateWithKicks(game.well, vertical, 1, kicksFor('I'));
  assert.ok(rotated);
  assert.equal(rotated.rot, 2);
  assert.ok(rotated.x >= 0);
});

test('hold is limited to once per locked piece and resets the held orientation', () => {
  const game = new Game('hold');
  const original = game.piece;
  game.act('rotateCW');
  assert.equal(game.act('hold'), true);
  assert.equal(game.hold, original);
  assert.equal(game.held?.rot, 0);
  const pieceId = game.pieceId;
  assert.equal(game.act('hold'), false);
  assert.equal(game.pieceId, pieceId);
  game.act('hardDrop');
  assert.equal(game.act('hold'), true);
  assert.equal(game.piece, original);
  assert.equal(game.active.rot, 0);
});

test('a grounded piece waits thirty frames before locking', () => {
  const game = new Game('lock');
  game.active = ghostPiece(game.well, game.active);
  game.advanceTo(29);
  assert.equal(game.pieces, 0);
  game.advanceTo(31);
  assert.equal(game.pieces, 1);
});

test('pause freezes gravity and does not freeze the replay clock', () => {
  const game = new Game('pause');
  const start = game.active.y;
  game.act('pause');
  game.advanceTo(600);
  assert.equal(game.active.y, start);
  assert.equal(game.playingFrames, 0);
  game.act('resume');
  game.advanceTo(660);
  assert.equal(game.active.y, start + 1);
});

test('four full rows clear rigidly and score a Tetris plus perfect clear and drop points', () => {
  const game = new Game('clear');
  for (let row = HEIGHT - 4; row < HEIGHT; row += 1) {
    for (let column = 0; column < WIDTH; column += 1) if (column !== 4) game.well.set(column, row, 'J');
  }
  const spawned = spawnTetromino<Cell>('I', 'I', 2, 1);
  game.active = { ...spawned, rot: 1, cells: spawned.orientations![1] };
  const distance = ghostPiece(game.well, game.active).y - game.active.y;
  game.act('hardDrop');
  assert.equal(game.lines, 4);
  assert.equal(game.score, 800 + 2000 + distance * 2);
  assert.ok(game.well.toArray().every(cell => cell === null));
});

test('normal clears, spins, combos and back-to-back use guideline score values', () => {
  assert.equal(scoreClear(1, 'none', 1, -1, false, false).points, 100);
  assert.equal(scoreClear(2, 'none', 2, -1, false, false).points, 600);
  assert.equal(scoreClear(3, 'none', 1, -1, false, false).points, 500);
  assert.equal(scoreClear(4, 'none', 1, -1, true, false).points, 1200);
  assert.equal(scoreClear(2, 'full', 1, -1, false, false).points, 1200);
  assert.equal(scoreClear(1, 'mini', 1, -1, false, false).points, 200);
  assert.equal(scoreClear(1, 'none', 1, 0, false, false).points, 150);
  assert.equal(scoreClear(0, 'none', 1, 3, true, false).backToBack, true);
  assert.equal(scoreClear(1, 'none', 1, -1, true, false).backToBack, false);
});

test('replaying inputs reconstructs the exact board, queue, score and timing', () => {
  const game = new Game('replay');
  game.advanceTo(31);
  game.act('left');
  game.act('rotateCW');
  game.advanceTo(60);
  game.act('hardDrop');
  game.act('hold');
  game.advanceTo(125);
  game.act('right');
  game.act('hardDrop');
  game.act('pause');
  game.advanceTo(200);
  game.act('resume');
  assert.deepEqual(Game.restore(game.replay()).view(), game.view());
});

test('model candidates are legal input paths and do not mutate the game', () => {
  const game = new Game('placements');
  const before = game.view();
  const placements = placementsFor(game);
  assert.ok(placements.length >= 9);
  assert.ok(placements.length <= 80);
  assert.deepEqual(game.view(), before);
  for (const placement of placements) {
    const copy = Game.restore(game.replay());
    for (const action of placement.path) copy.act(action);
    assert.equal(copy.pieces, 1);
    assert.equal(copy.lines, placement.clearedLines);
    assert.ok(refreshPlacement(game, placement));
  }
});

test('blocked spawn ends the game without overwriting occupied cells', () => {
  const game = new Game('top-out');
  for (let row = 0; row < 4; row += 1) for (let column = 0; column < WIDTH; column += 1) game.well.set(column, row, 'Z');
  const before = game.well.toArray();
  game.act('hardDrop');
  assert.equal(game.status, 'over');
  assert.deepEqual(game.well.toArray(), before);
});

test('invalid and backward frame numbers cannot be replayed', () => {
  const game = new Game('clock');
  game.advanceTo(20);
  assert.throws(() => game.advanceTo(19));
  assert.throws(() => game.advanceTo(Number.NaN));
  assert.throws(() => game.advanceTo(216001));
});

test('paused token experiments offer legal moves without advancing the board', () => {
  const game = new Game('paused-assist');
  game.act('pause');
  const before = game.view();
  const placements = placementsFor(game);
  assert.ok(placements.length > 0);
  assert.deepEqual(game.view(), before);
  game.act('resume');
  for (const action of placements[0].path) game.act(action);
  game.act('pause');
  assert.equal(game.pieces, 1);
  assert.equal(game.status, 'paused');
  assert.deepEqual(Game.restore(game.replay()).view(), game.view());
});