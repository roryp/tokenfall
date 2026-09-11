import { useEffect, useEffectEvent, useRef } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowRightLeft, RotateCcw, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { pieceCells, spawnTetromino } from 'miaoda-game-fallblock-core';
import { Game, HEIGHT, HIDDEN_ROWS, tokenLabel, WIDTH } from '../../shared/game.ts';
import type { Action, Cell, GameView, PieceToken } from '../../shared/game.ts';
import type { Insight } from '../../shared/protocol.ts';

const attract = new Game('tokenfall-attract');
for (const horizontal of [-3, 3, 0, -2, 4, 1, -4, 3, -1]) {
  for (let step = 0; step < Math.abs(horizontal); step += 1) attract.act(horizontal < 0 ? 'left' : 'right');
  attract.act('hardDrop');
}
const attractView = attract.view();

export function PiecePreview({ piece, label, token }: { piece: Cell; label?: string; token?: PieceToken | null }) {
  const cells = piece ? pieceCells(spawnTetromino(piece, piece, 0, 0)) : [];
  return <div className="token-piece-preview" role="img" aria-label={label ?? (token ? `Token ${tokenLabel(token.text)}, ID ${token.id}, ${piece} shape` : piece ? `${piece} piece` : 'Empty hold')}>
    <div className="piece-preview">{Array.from({ length: 8 }, (_, index) => <i key={index} className={cells.some(cell => cell.x === index % 4 && cell.y === Math.floor(index / 4)) ? `mino mino-${piece}` : ''} />)}</div>
    {token && <span className="preview-token" title={`Token ${token.id}: ${token.text}`}>{tokenLabel(token.text)}</span>}
  </div>;
}

export function GameBoard({ view, joined, suggestion, children }: { view: GameView; joined: boolean; suggestion: Insight | null; children?: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const previous = useRef<GameView | null>(null);
  const drop = useRef<{ board: GameView; target: GameView['active']; started: number } | null>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext('2d');
    if (!context) return;
    const colors = getComputedStyle(document.documentElement);
    const token = (name: string) => colors.getPropertyValue(`--cp-${name}`).trim();
    const blockColors: Record<string, string> = { I: token('link'), O: token('warning'), T: token('accent'), S: token('success'), Z: token('danger'), J: token('game-j'), L: token('game-l') };
    const prior = previous.current;
    if (joined && prior && prior.tokens.length && view.pieces === prior.pieces + 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      let target = prior.ghost;
      if (suggestion?.pieceId === prior.pieceId && suggestion.status === 'stale' && suggestion.placement) {
        const pose = suggestion.placement;
        const landed = spawnTetromino<Cell>(prior.piece, prior.piece, pose.column, pose.row);
        landed.cells = landed.orientations![pose.rotation];
        target = pieceCells(landed);
      }
      drop.current = { board: prior, target, started: performance.now() };
    }
    if (prior && (view.pieces < prior.pieces || view.frame < prior.frame)) drop.current = null;
    previous.current = view;
    let board = joined ? view : attractView;
    const animation = drop.current;
    if (joined && animation) {
      const progress = Math.min(1, (performance.now() - animation.started) / 220);
      if (progress < 1) {
        const startRow = Math.min(...animation.board.active.map(cell => cell.y));
        const targetRow = Math.min(...animation.target.map(cell => cell.y));
        const offset = Math.round((targetRow - startRow) * (1 - progress));
        board = { ...animation.board, active: animation.target.map(cell => ({ ...cell, y: cell.y - offset })), ghost: [] };
      } else drop.current = null;
    }
    const size = 32;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (element.width !== WIDTH * size * ratio) element.width = WIDTH * size * ratio;
    if (element.height !== 20 * size * ratio) element.height = 20 * size * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = token('board');
    context.fillRect(0, 0, WIDTH * size, 20 * size);
    context.strokeStyle = token('board-grid');
    context.lineWidth = 0.6;
    for (let column = 0; column <= WIDTH; column += 1) { context.beginPath(); context.moveTo(column * size, 0); context.lineTo(column * size, 20 * size); context.stroke(); }
    for (let row = 0; row <= 20; row += 1) { context.beginPath(); context.moveTo(0, row * size); context.lineTo(WIDTH * size, row * size); context.stroke(); }
    const drawCell = (column: number, row: number, value: string, mode: 'solid' | 'ghost' | 'suggestion') => {
      if (row < HIDDEN_ROWS || row >= HEIGHT) return;
      const left = column * size;
      const top = (row - HIDDEN_ROWS) * size;
      context.save();
      context.fillStyle = blockColors[value];
      context.strokeStyle = blockColors[value];
      if (mode !== 'solid') {
        context.globalAlpha = mode === 'ghost' ? 0.65 : 0.95;
        context.lineWidth = mode === 'ghost' ? 1.5 : 2.5;
        if (mode === 'suggestion') context.setLineDash([4, 3]);
        context.strokeRect(left + 4, top + 4, size - 8, size - 8);
        context.globalAlpha = 0.1;
        context.fillRect(left + 4, top + 4, size - 8, size - 8);
      } else {
        context.beginPath();
        context.roundRect(left + 1.5, top + 1.5, size - 3, size - 3, 3);
        context.fill();
        context.fillStyle = token('tile-light');
        context.globalAlpha = 0.5;
        context.fillRect(left + 5, top + 4, size - 10, 2);
        context.globalAlpha = 0.15;
        context.fillRect(left + 5, top + 6, 2, size - 12);
        context.fillStyle = token('board');
        context.globalAlpha = 0.28;
        context.fillRect(left + 4, top + size - 5, size - 8, 2);
      }
      context.restore();
    };
    const drawToken = (cells: { x: number; y: number }[], text: string) => {
      const visible = cells.filter(cell => cell.y >= HIDDEN_ROWS && cell.y < HEIGHT);
      if (!visible.length) return;
      const occupied = new Set(visible.map(cell => `${cell.x},${cell.y}`));
      let run = { x: visible[0].x, y: visible[0].y, length: 1, vertical: false };
      for (const cell of visible) for (const vertical of [false, true]) {
        let length = 1;
        while (occupied.has(`${cell.x + (vertical ? 0 : length)},${cell.y + (vertical ? length : 0)}`)) length += 1;
        if (length > run.length) run = { ...cell, length, vertical };
      }
      const label = tokenLabel(text);
      context.save();
      context.font = '700 14px Consolas, monospace';
      const fontSize = Math.min(14, 14 * (run.length * size - 10) / Math.max(1, context.measureText(label).width));
      context.font = `700 ${fontSize}px Consolas, monospace`;
      context.translate((run.x + (run.vertical ? 0.5 : run.length / 2)) * size, (run.y - HIDDEN_ROWS + (run.vertical ? run.length / 2 : 0.5)) * size);
      if (run.vertical) context.rotate(Math.PI / 2);
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.lineJoin = 'round';
      context.lineWidth = 3;
      context.strokeStyle = token('board');
      context.fillStyle = token('tile-light');
      context.strokeText(label, 0, 0);
      context.fillText(label, 0, 0);
      context.restore();
    };
    board.board.forEach((value, index) => { if (value) drawCell(index % WIDTH, Math.floor(index / WIDTH), value, 'solid'); });
    const lockedTokens = new Map<number, { x: number; y: number }[]>();
    board.tokenBoard.forEach((tokenIndex, index) => {
      if (tokenIndex === null || !board.board[index]) return;
      const cells = lockedTokens.get(tokenIndex) ?? [];
      cells.push({ x: index % WIDTH, y: Math.floor(index / WIDTH) });
      lockedTokens.set(tokenIndex, cells);
    });
    for (const [tokenIndex, cells] of lockedTokens) {
      const pieceToken = board.tokens[tokenIndex % board.tokens.length];
      if (pieceToken) drawToken(cells, pieceToken.text);
    }
    board.ghost.forEach(cell => { if (cell.value) drawCell(cell.x, cell.y, cell.value, 'ghost'); });
    if (joined && suggestion?.placement && suggestion.pieceId === view.pieceId && suggestion.status === 'ready') {
      const target = suggestion.placement;
      const piece = spawnTetromino(view.piece, view.piece, target.column, target.row);
      piece.cells = piece.orientations![target.rotation];
      pieceCells(piece).forEach(cell => drawCell(cell.x, cell.y, cell.value, 'suggestion'));
    }
    if (board.status !== 'over') {
      board.active.forEach(cell => { if (cell.value) drawCell(cell.x, cell.y, cell.value, 'solid'); });
      if (board.activeToken) drawToken(board.active, board.activeToken.text);
    }
    if (joined && view.lastClear && view.frame - view.lastClear.frame < 12) {
      context.fillStyle = token('tile-light');
      context.globalAlpha = Math.max(0, (12 - (view.frame - view.lastClear.frame)) / 24);
      for (const row of view.lastClear.rows) context.fillRect(0, (row - HIDDEN_ROWS) * size, WIDTH * size, size);
      context.globalAlpha = 1;
    }
  }, [view, joined, suggestion]);
  return <div className="board-shell">
    <div className="board-edge"><span>01</span><span>10</span></div>
    <div className="board-interior">
      <canvas ref={canvas} className="game-canvas" aria-label={`Tetris playfield, 10 columns and 20 rows${view.activeToken ? `. Falling token: ${tokenLabel(view.activeToken.text)}, ID ${view.activeToken.id}, ${view.piece} shape` : ''}`} data-active-token={view.activeToken ? tokenLabel(view.activeToken.text) : ''} role="img" />
      {children}
      {joined && view.lastClear && view.frame - view.lastClear.frame < 90 && view.status === 'playing' && <div className="clear-callout" key={view.lastClear.frame}><strong>{view.lastClear.label}</strong><span>+{view.lastClear.points.toLocaleString()}</span></div>}
    </div>
    <div className="board-edge bottom"><span>{view.tokens.length ? `TOKEN ${view.activeTokenIndex % view.tokens.length + 1} / ${view.tokens.length}` : 'STANDARD / SRS'}</span><span>{joined ? `LVL ${String(view.level).padStart(2, '0')}` : 'READY'}</span></div>
  </div>;
}

export function GameControls({ act, paused, disabled }: { act: (action: Action) => void; paused: boolean; disabled: boolean }) {
  const held = useRef(new Map<string, { action: Action; next: number }>());
  function press(action: Action, source: string) {
    if (disabled || paused) return;
    act(action);
    if (['left', 'right', 'softDrop'].includes(action)) held.current.set(source, { action, next: performance.now() + (action === 'softDrop' ? 45 : 160) });
  }
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const keys: Record<string, Action> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'softDrop', ArrowUp: 'rotateCW', KeyX: 'rotateCW', KeyZ: 'rotateCCW', Space: 'hardDrop', KeyC: 'hold', ShiftLeft: 'hold', ShiftRight: 'hold' };
    if (event.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable)) return;
    if (disabled) return;
    if (['KeyP', 'Escape'].includes(event.code)) {
      event.preventDefault();
      if (!event.repeat) { held.current.clear(); act(paused ? 'resume' : 'pause'); }
      return;
    }
    if (keys[event.code]) { event.preventDefault(); if (!event.repeat) press(keys[event.code], event.code); }
  });
  const onRepeat = useEffectEvent(() => {
    if (disabled || paused) { held.current.clear(); return; }
    const now = performance.now();
    for (const entry of held.current.values()) if (now >= entry.next) { act(entry.action); entry.next = now + (entry.action === 'softDrop' ? 40 : 50); }
  });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => onKeyDown(event);
    const keyup = (event: KeyboardEvent) => held.current.delete(event.code);
    const releaseAll = () => held.current.clear();
    const timer = setInterval(() => onRepeat(), 16);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', releaseAll);
    return () => { clearInterval(timer); window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', releaseAll); document.removeEventListener('visibilitychange', releaseAll); };
  }, []);
  const controls = [
    { action: 'hold' as Action, label: 'Hold piece (C)', icon: ArrowRightLeft },
    { action: 'rotateCCW' as Action, label: 'Rotate counterclockwise (Z)', icon: RotateCcw },
    { action: 'rotateCW' as Action, label: 'Rotate clockwise (Up)', icon: RotateCw },
    { action: 'hardDrop' as Action, label: 'Hard drop (Space)', icon: ArrowDownToLine },
    { action: 'left' as Action, label: 'Move left', icon: ArrowLeft },
    { action: 'softDrop' as Action, label: 'Soft drop', icon: ArrowDown },
    { action: 'right' as Action, label: 'Move right', icon: ArrowRight },
  ];
  return <div className="game-controls" aria-label="Game controls">
    {controls.map(({ action, label, icon: Icon }) => <button key={action} className={`control-key control-${action}`} disabled={disabled || paused} aria-label={label} title={label}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); press(action, `pointer-${event.pointerId}`); }}
      onPointerUp={event => held.current.delete(`pointer-${event.pointerId}`)} onPointerCancel={event => held.current.delete(`pointer-${event.pointerId}`)} onLostPointerCapture={event => held.current.delete(`pointer-${event.pointerId}`)}
      onClick={event => { if (event.detail === 0) act(action); }}><Icon size={22} />{action === 'hardDrop' && <span>DROP</span>}</button>)}
  </div>;
}