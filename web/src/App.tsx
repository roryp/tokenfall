import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, BookOpen, Bot, Check, Copy, Expand, Gamepad2, Layers3, Maximize2, Moon, Pause, Play, QrCode, RotateCcw, ScanText, Sparkles, Square, Sun, Trophy, Users, Volume2, VolumeX, Wifi, WifiOff, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { GameBoard, GameControls, PiecePreview } from './GameBoard.tsx';
import { GameRules, LiveRates, LunaControls, TokenLab, TokenPowerups, TokenSetup } from './TokenLab.tsx';
import { formatEfficiency, formatMoney } from './format.ts';
import { useGame } from './useGame.ts';
import type { GameController } from './useGame.ts';
import { tokenLabel } from '../../shared/game.ts';
import { costForUsage } from '../../shared/protocol.ts';
import type { RoomView } from '../../shared/protocol.ts';
import './App.css';

const number = (value: number) => value.toLocaleString();
function Mark() { return <div className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></div>; }

function JoinQr({ room, large = false }: { room: RoomView | null; large?: boolean }) {
  const [copied, setCopied] = useState(false);
  return <div className={`join-qr ${large ? 'large-qr' : ''}`}>
    <div className="qr-heading"><QrCode size={19} /><h3>You're next.</h3><span className="tiny-label">JOIN THE ROOM</span></div>
    <div className="qr-body">{room?.joinUrl ? <QRCodeSVG value={room.joinUrl} size={large ? 244 : 132} level="M" marginSize={3} title="Join the Tokenfall game" bgColor="var(--cp-qr-bg)" fgColor="var(--cp-qr-fg)" /> : <div className="qr-pending"><QrCode size={48} /><span>Join link pending</span></div>}<div><span className="eyebrow">ROOM CODE</span><strong className="room-code">{room?.code ?? '------'}</strong><span className="room-count"><Users size={13} />{room?.online ?? 0} / 50 online</span></div></div>
    {room?.joinUrl && <div className="join-link"><a href={room.joinUrl} target="_blank" rel="noreferrer">{new URL(room.joinUrl).hostname}<ArrowUpRight size={14} /></a><button className="icon-button" title="Copy audience link" aria-label="Copy audience link" onClick={() => { void navigator.clipboard.writeText(room.joinUrl!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => setCopied(false)); }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></div>}
  </div>;
}

function Leaderboard({ controller, large = false }: { controller: GameController; large?: boolean }) {
  const entries = controller.room?.leaderboard ?? [];
  return <section className={`leaderboard ${large ? 'large-leaderboard' : ''}`} aria-labelledby="leaderboard-title">
    <header className="section-heading"><span className="section-number">03</span><h2 id="leaderboard-title">The leaderboard</h2><span className="live-label"><i />LIVE</span></header>
    <div className="leaderboard-columns"><span>RANK / PLAYER</span><span>POINTS / CENT</span></div>
    {entries.length ? <ol>{entries.slice(0, large ? 15 : 7).map((entry, index) => <li key={entry.id} className={entry.id === controller.playerId ? 'your-entry' : ''}><span className={`rank rank-${index}`}>{entry.challengeScore === null ? '--' : index === 0 && entry.challengeScore > 0 ? <Trophy size={17} /> : String(index + 1).padStart(2, '0')}</span><span className={`avatar avatar-${index % 5}`}>{entry.name.slice(0, 2).toUpperCase()}</span><div className="entry-name"><strong>{entry.name}{entry.id === controller.playerId && <small>YOU</small>}</strong><span><i className={entry.online ? 'online-marker' : 'offline-marker'} />{number(entry.score)} Tetris points</span><span className="entry-cost">{entry.costUsd == null ? 'Rates pending' : `${formatMoney(entry.costUsd)} est. spend`}</span></div><div className="entry-result"><strong className="entry-score">{formatEfficiency(entry.challengeScore)}</strong><span>{entry.unmeteredRequests > 0 ? 'Usage missing' : entry.costUsd === 0 ? 'No AI spend' : entry.costUsd == null ? 'Rates pending' : 'pts / cent'}</span></div></li>)}</ol> : <div className="leaderboard-empty"><Trophy size={36} /><strong>The top spot is open.</strong><span>0 players / 0 scores</span></div>}
    <footer><span><Check size={13} />Verified points + usage</span><span>Current USD rates</span></footer>
  </section>;
}

function RoomStats({ controller }: { controller: GameController }) {
  const metrics = controller.room?.metrics;
  const hitRate = metrics?.input ? Math.round(100 * metrics.cached / metrics.input) : 0;
  const rates = controller.room?.pricing?.snapshot?.usdPerMillion;
  const costUsd = metrics && rates ? costForUsage(metrics, rates).total : null;
  const missingUsage = controller.room?.unmeteredRequests ?? 0;
  return <div className="room-stats"><div><Users size={19} /><span>Players online</span><strong>{controller.room?.online ?? 0}</strong></div><div><Sparkles size={19} /><span>Model requests</span><strong>{metrics?.requests ?? 0}</strong></div><div><Layers3 size={19} /><span>Cache-read share</span><strong>{hitRate}%</strong></div><div><Expand size={19} /><span>Reported AI cost<small>{missingUsage ? `incomplete: ${missingUsage} request(s) without usage` : 'retail estimate'}</small></span><strong className="room-cost">{formatMoney(costUsd)}</strong></div></div>;
}

function App() {
  const controller = useGame();
  const [mobileTab, setMobileTab] = useState<'game' | 'lab' | 'scores' | 'rules'>('game');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'light');
  const [sound, setSound] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const lastPieces = useRef(0);
  const lastLines = useRef(0);
  const insight = controller.insights[0] ?? null;
  const settingUp = !controller.joined || controller.editingTokens;
  const visibleTab = settingUp && mobileTab !== 'rules' ? 'game' : mobileTab;
  const rank = (controller.room?.leaderboard.filter(entry => entry.challengeScore !== null).findIndex(entry => entry.id === controller.playerId) ?? -1) + 1;
  useEffect(() => {
    const changed = controller.view.pieces > lastPieces.current;
    const cleared = controller.view.lines > lastLines.current;
    lastPieces.current = controller.view.pieces;
    lastLines.current = controller.view.lines;
    if (!sound || !changed) return;
    try {
      audio.current ??= new AudioContext();
      void audio.current.resume();
      const oscillator = audio.current.createOscillator();
      const gain = audio.current.createGain();
      oscillator.connect(gain);
      gain.connect(audio.current.destination);
      oscillator.frequency.value = cleared ? 880 : 210;
      gain.gain.setValueAtTime(0.04, audio.current.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.current.currentTime + 0.12);
      oscillator.start();
      oscillator.stop(audio.current.currentTime + 0.13);
    } catch { audio.current = null; }
  }, [controller.view.pieces, controller.view.lines, sound]);
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
  }
  function showRules() {
    if (controller.autopilot) controller.toggleAutopilot(false);
    if (controller.view.status === 'playing' && controller.joined) controller.act('pause');
    setMobileTab('rules');
  }
  return <div className={`app ${controller.isProjector ? 'projector-app' : ''} ${controller.view.tokens.length ? 'token-game' : ''}`} data-mobile-tab={visibleTab} data-setup={settingUp && !controller.isProjector}>
    <header className="topbar"><a className="brand" href="/"><Mark /><div><h1>TOKENFALL<span>.</span></h1><span className="brand-caption">THE TOKEN ARCADE</span></div></a><div className="session-label"><span className="live-label"><i />LIVE SESSION</span><span>ROOM {controller.room?.code ?? '------'}</span></div><div className="top-actions"><span className={`connection-label ${controller.connected ? '' : 'disconnected'}`}>{controller.connected ? <Wifi size={15} /> : <WifiOff size={15} />}<span>{controller.connected ? 'Connected' : 'Reconnecting'}</span></span><button className="icon-button" aria-label={sound ? 'Mute sound' : 'Enable sound'} title={sound ? 'Mute sound' : 'Enable sound'} onClick={() => { if (!sound) { audio.current ??= new AudioContext(); void audio.current.resume(); } setSound(current => !current); }}>{sound ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><button className="icon-button" onClick={toggleTheme} aria-label="Toggle color theme" title="Toggle color theme">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button><a className="icon-button projector-link" href={controller.isProjector ? '/' : '/?view=room'} target={controller.isProjector ? undefined : '_blank'} rel="noreferrer" title={controller.isProjector ? 'Play game' : 'Open projector view'} aria-label={controller.isProjector ? 'Play game' : 'Open projector view'}>{controller.isProjector ? <Gamepad2 size={18} /> : <Maximize2 size={18} />}</a></div></header>
    <div className="spectrum-rule"><i /><i /><i /><i /><i /><i /><i /></div>
    {controller.isProjector ? <main className="projector-main"><div className="projector-heading"><div><span className="eyebrow">THE POINTS-PER-CENT CHALLENGE</span><h2>More points.<br />Less AI spend.</h2></div><span className="projector-model"><Sparkles size={18} />GPT-5.6 LUNA<span>REASONING OFF</span></span></div><RoomStats controller={controller} /><div className="projector-columns"><Leaderboard controller={controller} large /><aside><JoinQr room={controller.room} large /><div className="projector-facts"><span>HOW TO WIN</span><strong>Best Tetris points<br />/ AI cost in cents</strong><p>1,000 points at $0.002 = 5,000 points per cent. Actual usage, current retail rates, no flat bonuses.</p></div><LiveRates pricing={controller.room?.pricing} /></aside></div></main> : <>
      <nav className="mobile-tabs" aria-label="Game views"><button aria-current={visibleTab === 'game' ? 'page' : undefined} onClick={() => setMobileTab('game')}><Gamepad2 size={17} />{settingUp ? 'Setup' : 'Play'}</button><button disabled={settingUp} aria-current={visibleTab === 'lab' ? 'page' : undefined} onClick={() => { if (controller.view.status === 'playing' && controller.joined) controller.act('pause'); setMobileTab('lab'); }}><Sparkles size={17} />Token lab</button><button disabled={settingUp} aria-current={visibleTab === 'scores' ? 'page' : undefined} onClick={() => { if (controller.view.status === 'playing' && controller.joined) controller.act('pause'); setMobileTab('scores'); }}><Trophy size={17} />Scores</button><button aria-current={visibleTab === 'rules' ? 'page' : undefined} onClick={showRules}><BookOpen size={17} />Rules</button></nav>
      {controller.autopilot && <div className="autopilot-banner"><span><Bot size={18} />Luna is playing your run</span><button className="text-action" onClick={() => controller.toggleAutopilot(false)}><Square size={15} />Stop AI</button></div>}
      <main className="arcade-layout">
        <section className="play-area" aria-labelledby="play-title"><header className="section-heading"><span className="section-number">01</span><h2 id="play-title">{settingUp ? 'Build your token run.' : 'Make your move.'}</h2><a className="rules-link" href="#game-rules" onClick={showRules}><BookOpen size={15} />Rules</a><span className="tiny-label">{controller.joined ? controller.name : 'TEXT TO TETRIS'}</span></header>
          {settingUp ? <TokenSetup controller={controller} onStart={() => setMobileTab('game')} /> : <>
          <p className="game-objective"><strong>Goal:</strong> the most Tetris points per cent of AI cost.</p>
          <div className="scoreboard"><div className="main-score"><span>THIS RUN / POINTS PER CENT</span><strong data-testid="game-score">{formatEfficiency(controller.efficiencyScore)}</strong><small data-testid="base-score">{number(controller.view.score)} Tetris points</small></div><div><span>LINES</span><strong>{String(controller.view.lines).padStart(2, '0')}</strong></div><div><span>LEVEL</span><strong>{String(controller.view.level).padStart(2, '0')}</strong></div><button className="icon-button" disabled={controller.view.status === 'over'} title={controller.autopilot ? 'Stop AI and pause' : controller.view.status === 'paused' ? 'Resume game (P)' : 'Pause game (P)'} aria-label={controller.autopilot ? 'Stop AI and pause' : controller.view.status === 'paused' ? 'Resume game' : 'Pause game'} onClick={() => controller.autopilot ? controller.toggleAutopilot(false) : controller.act(controller.view.status === 'paused' ? 'resume' : 'pause')}>{controller.view.status === 'paused' && !controller.autopilot ? <Play size={19} /> : <Pause size={19} />}</button><button className="icon-button" disabled={controller.busy} title="Restart game" aria-label="Restart game" onClick={() => { controller.act('pause'); setRestartOpen(true); }}><RotateCcw size={18} /></button></div>
          <div className="token-run-heading"><span data-testid="current-token">{controller.view.activeToken ? <><strong>{tokenLabel(controller.view.activeToken.text)}</strong><small>Token {controller.view.activeTokenIndex % controller.view.tokens.length + 1} / {controller.view.tokens.length} / ID {controller.view.activeToken.id}</small></> : 'Classic piece sequence'}</span><span data-testid="piece-count">{controller.view.pieces} placed</span>{controller.view.status === 'paused' && !controller.autopilot && <span className="paused-marker">Paused</span>}<button className="icon-button" title="Edit text for next run" aria-label="Edit text for next run" disabled={controller.busy} onClick={controller.editTokens}><ScanText size={18} /></button></div>
          <TokenPowerups controller={controller} />
          <div className="play-well"><div className="piece-rail hold-rail"><span className="eyebrow">HOLD</span><button className="hold-slot" disabled={controller.autopilot || !controller.view.canHold || controller.view.status !== 'playing'} title="Hold piece (C)" aria-label="Hold current piece" onClick={() => controller.act('hold')}><PiecePreview piece={controller.view.hold} token={controller.view.holdToken} /></button><div className="rail-rank"><Trophy size={17} /><span>RANK</span><strong>{rank ? `#${rank}` : '--'}</strong></div></div>
            <div className="board-column"><GameBoard key={theme} view={controller.view} joined={controller.joined} suggestion={insight}>
              {controller.view.status === 'paused' && !controller.autopilot && !controller.view.tokens.length ? <div className="board-overlay pause-overlay"><Pause size={35} /><h3>Take a breath.</h3><span>GAME PAUSED</span><button className="primary-button" onClick={() => controller.act('resume')}><Play size={16} />Resume game</button></div> : controller.view.status === 'over' ? <div className="board-overlay gameover-overlay"><Trophy size={38} /><span className="eyebrow">RUN COMPLETE / TETRIS POINTS</span><h3>{number(controller.view.score)}</h3><span>{controller.view.lines} LINES / LEVEL {controller.view.level}</span><button className="primary-button" onClick={() => void controller.restart()} disabled={controller.busy}><RotateCcw size={16} />Play again</button><button className="text-action" onClick={controller.editTokens}><ScanText size={15} />Change token text</button></div> : null}
            </GameBoard><GameControls act={controller.act} disabled={controller.autopilot || !controller.connected || controller.view.status === 'over'} paused={controller.view.status === 'paused'} /></div>
            <div className="piece-rail next-rail"><span className="eyebrow">NEXT TOKENS</span>{controller.view.next.slice(0, 4).map((piece, index) => <div className="next-piece" key={index}><PiecePreview piece={piece} token={controller.view.nextTokens[index]} /></div>)}<span className="bag-label">{controller.view.tokens.length ? 'REPEATING' : '7-BAG'}</span></div>
          </div>
          <div className="play-bottom"><span><i className="status-dot" />{controller.joined ? 'YOUR RUN IS LIVE' : 'READY WHEN YOU ARE'}</span><span>10 x 20 / SRS / HOLD</span></div>
          <div className="mobile-luna"><LunaControls controller={controller} compact /></div>
          </>}
        </section>
        <div className="lab-column"><TokenLab controller={controller} /></div>
        <aside className="audience-column"><Leaderboard controller={controller} /><JoinQr room={controller.room} /><div className="session-totals"><span className="eyebrow">TOGETHER, THIS SESSION</span><div><strong>{number(controller.room?.metrics.cached ?? 0)}</strong><span>input tokens read from cache</span></div><div><strong>{number(controller.room?.metrics.compressionSaved ?? 0)}</strong><span>payload tokens saved <small>estimated</small></span></div></div></aside>
      </main>
    </>}
    <GameRules budget={controller.room?.playerTokenBudget ?? 16000} pricing={controller.room?.pricing} />
    <footer className="site-footer"><span><Mark />TOKENFALL / LIVE TOKEN ARCADE</span><span>STANDARD TETRIS RULES<span className="footer-separator"> / </span>REAL MODEL USAGE</span></footer>
    {controller.notice && <div className="notice" role="status"><span>{controller.notice}</span><button className="icon-button" title="Dismiss message" aria-label="Dismiss message" onClick={() => controller.setNotice('')}><X size={16} /></button></div>}
    {restartOpen && <div className="modal-backdrop"><div className="restart-dialog" role="dialog" aria-modal="true" aria-labelledby="restart-title"><RotateCcw size={28} /><h2 id="restart-title">Start a fresh run?</h2><p>Your best Tetris score stays. Session AI spend and the remaining token allowance do not reset.</p><div><button className="secondary-button" onClick={() => { setRestartOpen(false); controller.act('resume'); }}>Keep playing</button><button className="primary-button" onClick={() => { setRestartOpen(false); void controller.restart(); }}>New game<ArrowRight size={15} /></button></div></div></div>}
  </div>;
}

export default App;
