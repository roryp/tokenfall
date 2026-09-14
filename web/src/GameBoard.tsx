import { useEffect, useEffectEvent, useRef } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowRightLeft, RotateCcw, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { pieceCells, spawnTetromino } from 'miaoda-game-fallblock-core';
import { HEIGHT, HIDDEN_ROWS, WIDTH } from '../../shared/game.ts';
import type { Action, Cell, GameView } from '../../shared/game.ts';
import type { Insight } from '../../shared/protocol.ts';

export function PiecePreview({ piece }: { piece: Cell }) {
  const cells = piece ? pieceCells(spawnTetromino(piece, piece, 0, 0)) : [];
  return <div role="img" aria-label={piece ? `${piece} piece` : 'Empty hold'}>
    <div className="piece-preview">{Array.from({ length: 8 }, (_, index) => <i key={index} className={cells.some(cell => cell.x === index % 4 && cell.y === Math.floor(index / 4)) ? `mino mino-${piece}` : ''} />)}</div>
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
    if (joined && prior && view.pieces === prior.pieces + 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      let target = prior.ghost;
      if (suggestion?.pieceId === prior.pieceId && suggestion.status === 'stale' && suggestion.placement) {
        const pose = suggestion.placement;
        const type = pose.piece ?? prior.piece;
        const landed = spawnTetromino<Cell>(type, type, pose.column, pose.row);
        landed.cells = landed.orientations![pose.rotation];
        target = pieceCells(landed);
      }
      drop.current = { board: prior, target, started: performance.now() };
    }
    if (prior && (view.pieces < prior.pieces || view.frame < prior.frame)) drop.current = null;
    previous.current = view;
    let board = view;
    const animation = drop.current;
    if (joined && animation) {
      const progress = Math.min(1, (performance.now() - animation.started) / 140);
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
    board.board.forEach((value, index) => { if (value) drawCell(index % WIDTH, Math.floor(index / WIDTH), value, 'solid'); });
    board.ghost.forEach(cell => { if (cell.value) drawCell(cell.x, cell.y, cell.value, 'ghost'); });
    if (joined && suggestion?.placement && suggestion.pieceId === view.pieceId && suggestion.status === 'ready') {
      const target = suggestion.placement;
      const type = target.piece ?? view.piece;
      const piece = spawnTetromino(type, type, target.column, target.row);
      piece.cells = piece.orientations![target.rotation];
      pieceCells(piece).forEach(cell => drawCell(cell.x, cell.y, cell.value, 'suggestion'));
    }
    if (board.status !== 'over') {
      board.active.forEach(cell => { if (cell.value) drawCell(cell.x, cell.y, cell.value, 'solid'); });
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
      <canvas ref={canvas} className="game-canvas" aria-label="Tetris playfield, 10 columns and 20 rows" data-pieces={view.pieces} data-status={view.status} data-frame={view.frame} role="img" />
      {children}
      {joined && view.lastClear && view.frame - view.lastClear.frame < 90 && view.status === 'playing' && <div className="clear-callout" key={view.lastClear.frame}><strong>{view.lastClear.label}</strong><span>+{view.lastClear.points.toLocaleString()}</span></div>}
    </div>
    <div className="board-edge bottom"><span>10 x 20</span><span>{joined ? `LVL ${String(view.level).padStart(2, '0')}` : 'READY'}</span></div>
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
    if (event.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable || event.target.closest('dialog'))) return;
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