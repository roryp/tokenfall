import seedrandom from 'seedrandom';
import { Grid } from 'miaoda-game-grid-core';
import {
  LockDelay, PieceQueue, TETROMINOES, bagRandomizer, canPlace, clearRows,
  fullRows, ghostCells, ghostPiece, holdSwap, kicksFor, lockPiece, pieceCells,
  rotateWithKicks, spawnTetromino, tryMove,
} from 'miaoda-game-fallblock-core';
import type { ActivePiece, TetrominoId } from 'miaoda-game-fallblock-core';

export const WIDTH = 10;
export const VISIBLE_HEIGHT = 20;
export const HIDDEN_ROWS = 2;
export const HEIGHT = VISIBLE_HEIGHT + HIDDEN_ROWS;
export const FPS = 60;
export const DEFAULT_TOKEN_TEXT = 'Hello world! Tokens make my blocks.';
export const ACTIONS = ['left', 'right', 'softDrop', 'rotateCW', 'rotateCCW', 'hardDrop', 'hold', 'pause', 'resume'] as const;
export type Action = typeof ACTIONS[number];
export type Cell = TetrominoId | null;
export type Spin = 'none' | 'mini' | 'full';
export interface PieceToken { id: number; text: string }
export const tokenShape = (id: number): TetrominoId => TETROMINOES[id % TETROMINOES.length];
export const tokenLabel = (text: string) => /^ {2,}$/.test(text) ? `${text.length} spaces` : text.replaceAll(' ', '\u2423').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
function tokenSequence(tokens: readonly PieceToken[]) {
  let index = 0;
  return { next: () => tokenShape(tokens[index++ % tokens.length].id) };
}
export interface InputEvent { frame: number; action: Action }
export interface Replay { seed: string; frame: number; events: InputEvent[]; tokens?: PieceToken[] }
export interface ClearEvent {
  lines: number;
  points: number;
  label: string;
  combo: number;
  backToBack: boolean;
  frame: number;
  rows: number[];
}

export function scoreClear(lines: number, spin: Spin, level: number, previousCombo: number, previousBackToBack: boolean, perfect: boolean) {
  const difficult = lines === 4 || (spin !== 'none' && lines > 0);
  const combo = lines > 0 ? previousCombo + 1 : -1;
  const bases = spin === 'full' ? [400, 800, 1200, 1600] : spin === 'mini' ? [100, 200, 400] : [0, 100, 300, 500, 800];
  let points = (bases[lines] ?? 0) * level;
  if (difficult && previousBackToBack) points *= 1.5;
  points += Math.max(0, combo) * 50 * level;
  if (perfect && lines > 0) points += (lines === 4 && previousBackToBack ? 3200 : [0, 800, 1200, 1800, 2000][lines]) * level;
  const backToBack = lines === 0 ? previousBackToBack : difficult;
  const label = perfect && lines > 0 ? 'PERFECT CLEAR' : spin === 'full' ? 'T-SPIN' : spin === 'mini' ? 'T-SPIN MINI' : ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'][lines];
  return { points, combo, backToBack, label };
}

export class Game {
  seed: string;
  tokens: PieceToken[];
  well = new Grid<Cell>({ width: WIDTH, height: HEIGHT, empty: null });
  tokenWell = new Grid<number | null>({ width: WIDTH, height: HEIGHT, empty: null });
  queue: PieceQueue<TetrominoId>;
  active: ActivePiece<Cell>;
  held: ActivePiece<Cell> | null = null;
  activeTokenIndex = 0;
  heldTokenIndex: number | null = null;
  tokensTaken = 0;
  usedHold = false;
  lock = new LockDelay({ delayFrames: 30, maxResets: 15 });
  status: 'playing' | 'paused' | 'over' = 'playing';
  frame = 0;
  playingFrames = 0;
  score = 0;
  lines = 0;
  level = 1;
  pieces = 0;
  pieceId = 1;
  combo = -1;
  backToBack = false;
  gravity = 0;
  lastRotation: number | null = null;
  lastClear: ClearEvent | null = null;
  events: InputEvent[] = [];

  constructor(seed: string, tokens: PieceToken[] = []) {
    if (tokens.length > 256 || tokens.some(token => !Number.isSafeInteger(token.id) || token.id < 0 || typeof token.text !== 'string' || token.text.length > 256)) throw new Error('Invalid token sequence.');
    this.seed = seed;
    this.tokens = tokens.map(token => ({ ...token }));
    this.queue = new PieceQueue(this.tokens.length ? tokenSequence(this.tokens) : bagRandomizer(TETROMINOES, seedrandom(seed)), 5);
    this.active = this.takePiece();
  }

  newPiece(type: TetrominoId) { return spawnTetromino<Cell>(type, type, 3, 1); }
  takePiece() {
    this.activeTokenIndex = this.tokensTaken;
    this.tokensTaken += 1;
    return this.newPiece(this.queue.take());
  }
  tokenAt(index: number) { return this.tokens[index % this.tokens.length] ?? null; }
  get piece() { return this.active.cells[0].value as TetrominoId; }
  get hold() { return (this.held?.cells[0].value ?? null) as Cell; }

  act(action: Action) {
    this.events.push({ frame: this.frame, action });
    if (this.status === 'over') return false;
    if (action === 'pause') { this.status = 'paused'; return true; }
    if (action === 'resume') { this.status = 'playing'; return true; }
    if (this.status !== 'playing') return false;
    if (action === 'hold') {
      if (this.usedHold) return false;
      const currentTokenIndex = this.activeTokenIndex;
      const previousHeldTokenIndex = this.heldTokenIndex;
      const swapped = holdSwap(this.active, this.held, 3, 1, () => this.takePiece());
      this.active = swapped.active;
      this.held = swapped.held;
      if (previousHeldTokenIndex !== null) this.activeTokenIndex = previousHeldTokenIndex;
      this.heldTokenIndex = currentTokenIndex;
      this.usedHold = true;
      this.resetPiece();
      if (!canPlace(this.well, this.active)) this.status = 'over';
      return true;
    }
    if (action === 'hardDrop') {
      const landed = ghostPiece(this.well, this.active);
      const distance = landed.y - this.active.y;
      this.score += distance * 2;
      if (distance > 0) this.lastRotation = null;
      this.active = landed;
      this.finishPiece();
      return true;
    }
    const rotating = action === 'rotateCW' || action === 'rotateCCW';
    const moved = rotating
      ? rotateWithKicks(this.well, this.active, action === 'rotateCW' ? 1 : -1, kicksFor(this.piece))
      : tryMove(this.well, this.active, action === 'left' ? -1 : action === 'right' ? 1 : 0, action === 'softDrop' ? 1 : 0);
    if (!moved) return false;
    if (rotating) {
      const kicks = kicksFor(this.piece)[`${this.active.rot ?? 0}>${moved.rot ?? 0}`] ?? [[0, 0]];
      this.lastRotation = kicks.findIndex(([horizontal, vertical]) => moved.x - this.active.x === horizontal && moved.y - this.active.y === vertical);
    } else {
      this.lastRotation = null;
      if (action === 'softDrop') this.score += 1;
    }
    this.active = moved;
    if (action !== 'softDrop') this.lock.onManipulate();
    return true;
  }

  resetPiece() {
    this.lock.reset();
    this.gravity = 0;
    this.lastRotation = null;
    this.pieceId += 1;
  }

  detectSpin(): Spin {
    if (this.piece !== 'T' || this.lastRotation === null) return 'none';
    const occupied = (column: number, row: number) => !this.well.contains(column, row) || this.well.get(column, row) !== null;
    const corners = [[0, 0], [2, 0], [0, 2], [2, 2]].map(([column, row]) => occupied(this.active.x + column, this.active.y + row));
    if (corners.filter(Boolean).length < 3) return 'none';
    const fronts = [[0, 1], [1, 3], [2, 3], [0, 2]][this.active.rot ?? 0];
    return (fronts.every(index => corners[index]) || this.lastRotation === 4) ? 'full' : 'mini';
  }

  finishPiece() {
    if (!canPlace(this.well, this.active)) { this.status = 'over'; return; }
    const spin = this.detectSpin();
    const cells = pieceCells(this.active);
    lockPiece(this.well, this.active);
    if (this.tokens.length) for (const cell of cells) this.tokenWell.set(cell.x, cell.y, this.activeTokenIndex);
    this.pieces += 1;
    if (cells.every(cell => cell.y < HIDDEN_ROWS)) { this.status = 'over'; return; }
    const rows = fullRows(this.well);
    clearRows(this.well, rows);
    clearRows(this.tokenWell, rows);
    const result = scoreClear(rows.length, rows.length === 3 && spin === 'mini' ? 'full' : spin, this.level, this.combo, this.backToBack, this.well.toArray().every(cell => cell === null));
    this.score += result.points;
    this.combo = result.combo;
    this.backToBack = result.backToBack;
    if (result.points > 0) this.lastClear = { ...result, lines: rows.length, frame: this.frame, rows };
    this.lines += rows.length;
    this.level = 1 + Math.floor(this.lines / 10);
    this.active = this.takePiece();
    this.usedHold = false;
    this.resetPiece();
    if (!canPlace(this.well, this.active)) this.status = 'over';
  }

  tick() {
    this.frame += 1;
    if (this.status !== 'playing') return;
    this.playingFrames += 1;
    const speedLevel = Math.min(this.level, 20);
    const framesPerRow = FPS * Math.pow(0.8 - (speedLevel - 1) * 0.007, speedLevel - 1);
    this.gravity += 1;
    for (let step = 0; this.gravity >= framesPerRow && step < HEIGHT; step += 1) {
      this.gravity -= framesPerRow;
      const fallen = tryMove(this.well, this.active, 0, 1);
      if (!fallen) { this.gravity = 0; break; }
      this.active = fallen;
      this.lastRotation = null;
    }
    if (this.lock.tick(this.well, this.active)) this.finishPiece();
  }

  advanceTo(frame: number) {
    if (!Number.isSafeInteger(frame) || frame < this.frame || frame > 216000) throw new Error('Invalid game clock.');
    while (this.frame < frame) this.tick();
  }

  replay(): Replay { return { seed: this.seed, frame: this.frame, events: this.events.map(event => ({ ...event })), ...(this.tokens.length ? { tokens: this.tokens.map(token => ({ ...token })) } : {}) }; }

  static restore(replay: Replay) {
    const game = new Game(replay.seed, replay.tokens);
    for (const event of replay.events) {
      game.advanceTo(event.frame);
      game.act(event.action);
    }
    game.advanceTo(replay.frame);
    return game;
  }

  view() {
    return {
      board: this.well.toArray(), active: pieceCells(this.active), ghost: ghostCells(this.well, this.active),
      tokenBoard: this.tokenWell.toArray(), tokens: this.tokens,
      activeToken: this.tokenAt(this.activeTokenIndex), activeTokenIndex: this.activeTokenIndex,
      holdToken: this.heldTokenIndex === null ? null : this.tokenAt(this.heldTokenIndex),
      nextTokens: this.queue.peek().map((_piece, index) => this.tokenAt(this.tokensTaken + index)),
      piece: this.piece, pieceId: this.pieceId, hold: this.hold, canHold: !this.usedHold,
      next: this.queue.peek(), score: this.score, lines: this.lines, level: this.level,
      pieces: this.pieces, status: this.status, frame: this.frame, lastClear: this.lastClear,
      lockRemaining: this.lock.snapshot.remainingFrames,
    };
  }
}

export type GameView = ReturnType<Game['view']>;
export interface Placement {
  id: string;
  column: number;
  row: number;
  rotation: number;
  clearedLines: number;
  holes: number;
  aggregateHeight: number;
  maxHeight: number;
  bumpiness: number;
  path: Action[];
}

function boardMetrics(well: Grid<Cell>) {
  const heights: number[] = [];
  let holes = 0;
  for (let column = 0; column < WIDTH; column += 1) {
    let found = false;
    let height = 0;
    for (let row = 0; row < HEIGHT; row += 1) {
      if (well.get(column, row) !== null && !found) { height = HEIGHT - row; found = true; }
      else if (well.get(column, row) === null && found) holes += 1;
    }
    heights.push(height);
  }
  return { holes, aggregateHeight: heights.reduce((sum, height) => sum + height, 0), maxHeight: Math.max(...heights), bumpiness: heights.slice(1).reduce((sum, height, index) => sum + Math.abs(height - heights[index]), 0) };
}

export function placementsFor(game: Game): Placement[] {
  if (game.status === 'over') return [];
  const pending: { piece: ActivePiece<Cell>; path: Action[] }[] = [{ piece: game.active, path: [] }];
  const visited = new Set<string>();
  const landings = new Set<string>();
  const placements: Placement[] = [];
  const moves = ['left', 'right', 'rotateCW', 'rotateCCW', 'softDrop'] as const;
  for (let cursor = 0; cursor < pending.length && cursor < 1800; cursor += 1) {
    const { piece, path } = pending[cursor];
    const poseKey = `${piece.x},${piece.y},${piece.rot}`;
    if (visited.has(poseKey)) continue;
    visited.add(poseKey);
    const landed = ghostPiece(game.well, piece);
    const landingKey = pieceCells(landed).map(cell => `${cell.x},${cell.y}`).sort().join(';');
    if (!landings.has(landingKey)) {
      landings.add(landingKey);
      const copy = new Grid<Cell>({ width: WIDTH, height: HEIGHT, empty: null }).fill(({ x, y }) => game.well.get(x, y));
      lockPiece(copy, landed);
      const clearedLines = clearRows(copy).cleared.length;
      placements.push({ id: `P${placements.length}`, column: landed.x, row: landed.y, rotation: landed.rot ?? 0, clearedLines, ...boardMetrics(copy), path: [...path, 'hardDrop'] });
    }
    for (const action of moves) {
      const next = action === 'rotateCW' || action === 'rotateCCW'
        ? rotateWithKicks(game.well, piece, action === 'rotateCW' ? 1 : -1, kicksFor(game.piece))
        : tryMove(game.well, piece, action === 'left' ? -1 : action === 'right' ? 1 : 0, action === 'softDrop' ? 1 : 0);
      if (next && !visited.has(`${next.x},${next.y},${next.rot}`)) pending.push({ piece: next, path: [...path, action] });
    }
  }
  return placements;
}

export function refreshPlacement(game: Game, target: Pick<Placement, 'column' | 'row' | 'rotation'>) {
  return placementsFor(game).find(placement => placement.column === target.column && placement.row === target.row && placement.rotation === target.rotation);
}