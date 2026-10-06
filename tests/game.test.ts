import test from 'node:test';
import assert from 'node:assert/strict';
import seedrandom from 'seedrandom';
import { canPlace, ghostPiece, rotateWithKicks, kicksFor, spawnTetromino } from 'miaoda-game-fallblock-core';
import { Game, HEIGHT, WIDTH, placementsFor, refreshPlacement, scoreClear, tokenLabel, tokenShape } from '../shared/game.ts';
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

test('text tokens determine labeled piece order, repeat, and survive replay', () => {
  const tokens = [{ id: 24912, text: 'hello' }, { id: 2375, text: ' world' }, { id: 0, text: '!' }];
  const game = new Game('token-run', tokens);
  assert.equal(game.piece, tokenShape(tokens[0].id));
  assert.deepEqual(game.view().activeToken, tokens[0]);
  assert.deepEqual(game.view().nextTokens, [tokens[1], tokens[2], tokens[0], tokens[1], tokens[2]]);
  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(game.view().activeToken, tokens[index % tokens.length]);
    game.act('hardDrop');
  }
  assert.equal(game.view().tokenBoard.filter(index => index === 0).length, 4);
  assert.deepEqual(Game.restore(game.replay()).view(), game.view());
  assert.equal(tokenLabel(' hi\n'), '\u2423hi\\n');
  assert.equal(tokenLabel(' '.repeat(128)), '128 spaces');
  assert.throws(() => new Game('invalid', [{ id: -1, text: 'bad' }]));
});

test('hold transfers token identity without consuming or relabeling the wrong token', () => {
  const tokens = [{ id: 7, text: 'first' }, { id: 8, text: 'second' }, { id: 9, text: 'third' }];
  const game = new Game('token-hold', tokens);
  game.act('hold');
  assert.deepEqual(game.view().holdToken, tokens[0]);
  assert.deepEqual(game.view().activeToken, tokens[1]);
  game.act('hardDrop');
  game.act('hold');
  assert.deepEqual(game.view().activeToken, tokens[0]);
  assert.deepEqual(game.view().holdToken, tokens[2]);
  assert.equal(game.tokensTaken, 3);
  game.act('hardDrop');
  assert.deepEqual(Game.restore(game.replay()).view(), game.view());
});

test('clearing rows moves the token labels with their surviving cells', () => {
  const game = new Game('token-clear', [{ id: 0, text: 'label' }]);
  for (let row = HEIGHT - 4; row < HEIGHT; row += 1) {
    for (let column = 0; column < WIDTH; column += 1) if (column !== 4) {
      game.well.set(column, row, 'J');
      game.tokenWell.set(column, row, 50);
    }
  }
  game.well.set(0, HEIGHT - 5, 'T');
  game.tokenWell.set(0, HEIGHT - 5, 99);
  const spawned = spawnTetromino<Cell>('I', 'I', 2, 1);
  game.active = { ...spawned, rot: 1, cells: spawned.orientations![1] };
  game.act('hardDrop');
  assert.equal(game.lines, 4);
  assert.equal(game.tokenWell.get(0, HEIGHT - 1), 99);
  assert.equal(game.tokenWell.toArray().filter(index => index !== null).length, 1);
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
  assert.deepEqual(game.lastMove, {
    id: 1, frame: 0, points: game.score,
    parts: [
      { label: 'Tetris', detail: '800', points: 800 },
      { label: 'Perfect clear', detail: '2000', points: 2000 },
      { label: 'Hard drop', detail: `${distance} rows × 2`, points: distance * 2 },
    ],
  });
});

test('score parts always add up to the clear points', () => {
  for (const spin of ['none', 'mini', 'full'] as const) {
    for (let lines = 0; lines <= (spin === 'none' ? 4 : spin === 'mini' ? 2 : 3); lines += 1) {
      for (const [level, combo, backToBack, perfect] of [[1, -1, false, false], [3, 2, true, false], [2, 0, true, true], [5, 4, false, true]] as const) {
        const result = scoreClear(lines, spin, level, combo, backToBack, perfect);
        assert.equal(result.parts.reduce((sum, part) => sum + part.points, 0), result.points, `${spin} ${lines} lines at level ${level}`);
      }
    }
  }
  assert.deepEqual(scoreClear(4, 'none', 2, 1, true, false).parts, [
    { label: 'Tetris', detail: '800 × level 2', points: 1600 },
    { label: 'Back-to-back', detail: '50% of 1600', points: 800 },
    { label: 'Combo 2', detail: '2 × 50 × level 2', points: 200 },
  ]);
  assert.deepEqual(scoreClear(2, 'full', 1, -1, false, false).parts, [{ label: 'T-spin double', detail: '1200', points: 1200 }]);
  assert.deepEqual(scoreClear(0, 'mini', 1, -1, false, false).parts, [{ label: 'T-spin mini', detail: '100', points: 100 }]);
  assert.deepEqual(scoreClear(1, 'none', 1, 2, false, false).parts, [{ label: 'Single', detail: '100', points: 100 }, { label: 'Combo 3', detail: '3 × 50', points: 150 }]);
});

test('each locked piece reports exactly the points it added, including drops before a hold', () => {
  const game = new Game('move-score');
  game.act('softDrop');
  game.act('softDrop');
  game.act('hold');
  game.act('softDrop');
  const before = game.score;
  game.act('hardDrop');
  assert.equal(game.lastMove!.points, game.score);
  assert.deepEqual(game.lastMove!.parts.map(part => part.label), ['Hard drop', 'Soft drop']);
  assert.equal(game.lastMove!.parts[1].detail, '3 rows × 1');
  assert.equal(game.score - before, game.lastMove!.parts[0].points);

  const played = new Game('move-score-play');
  const random = seedrandom('move-score-play');
  let scoreAtLock = 0;
  let moves = 0;
  let clears = 0;
  const check = () => {
    if (played.moves === moves) return;
    assert.equal(played.moves, moves + 1);
    assert.equal(played.lastMove!.points, played.score - scoreAtLock);
    assert.equal(played.lastMove!.parts.reduce((sum, part) => sum + part.points, 0), played.lastMove!.points);
    if (played.lastMove!.parts.some(part => !part.label.endsWith('drop'))) clears += 1;
    scoreAtLock = played.score;
    moves = played.moves;
  };
  while (played.moves < 120 && played.status !== 'over') {
    const choices = placementsFor(played).filter(placement => !placement.gameOver);
    if (!choices.length) break;
    const value = (placement: typeof choices[number]) => placement.clearedLines * 8 - placement.holes * 7 - placement.aggregateHeight * 0.5 - placement.bumpiness * 0.3;
    const best = choices.reduce((winner, placement) => value(placement) > value(winner) ? placement : winner);
    for (const action of best.path.slice(0, -1)) { played.act(action); check(); }
    const finish = random();
    if (finish < 0.5) played.act('hardDrop');
    else if (finish < 0.8) { for (let row = 0; row < 3 && played.act('softDrop'); row += 1) check(); played.act('hardDrop'); }
    else for (let frame = 0; frame < 3000 && played.moves === moves; frame += 1) played.advanceTo(played.frame + 1);
    check();
  }
  assert.equal(played.moves, 120);
  assert.ok(clears > 10, `${clears} scoring clears`);
  assert.deepEqual(Game.restore(played.replay()).view(), played.view());
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
    assert.equal(copy.status === 'over', placement.gameOver);
    assert.ok(refreshPlacement(game, placement));
  }
});

test('Luna can choose an empty or occupied Hold slot through an exact legal path', () => {
  const game = new Game('luna-hold');
  for (const occupied of [false, true]) {
    if (occupied) { game.act('hold'); game.act('hardDrop'); }
    const before = game.view();
    const candidate = placementsFor(game).find(placement => placement.useHold && !placement.gameOver)!;
    assert.ok(candidate);
    assert.equal(candidate.path[0], 'hold');
    assert.equal(candidate.piece, game.hold ?? game.queue.peek()[0]);
    assert.deepEqual(game.view(), before);
    const copy = Game.restore(game.replay());
    for (const action of candidate.path) copy.act(action);
    assert.equal(copy.pieces, game.pieces + 1);
    assert.equal(copy.hold, game.piece);
    assert.equal(copy.tokensTaken, game.tokensTaken + (occupied ? 1 : 2));
    assert.equal(refreshPlacement(game, candidate)?.id, candidate.id);
  }
  game.act('hold');
  assert.equal(placementsFor(game).some(placement => placement.useHold), false);
});

test('candidate game-over flags match real lock and next-spawn outcomes without hiding choices', () => {
  const game = new Game('luna-danger');
  game.active = game.newPiece('I');
  for (let row = 3; row < HEIGHT; row += 1) game.well.set(4, row, 'J');
  const placements = placementsFor(game);
  assert.ok(placements.some(placement => placement.gameOver));
  assert.ok(placements.some(placement => !placement.gameOver));
  for (const placement of placements) {
    const copy = new Game(game.seed);
    copy.active = copy.newPiece('I');
    game.well.toArray().forEach((cell, index) => copy.well.set(index % WIDTH, Math.floor(index / WIDTH), cell));
    for (const action of placement.path) copy.act(action);
    assert.equal(copy.status === 'over', placement.gameOver, placement.id);
    assert.equal(copy.lines, placement.clearedLines, placement.id);
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
  assert.throws(() => game.advanceTo(Number.MAX_SAFE_INTEGER + 1));
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