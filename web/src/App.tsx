import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, Copy, Expand, Gamepad2, Layers3, Maximize2, Moon, Pause, Play, QrCode, RotateCcw, Sparkles, Sun, Trophy, Users, Volume2, VolumeX, Wifi, WifiOff, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { GameBoard, GameControls, PiecePreview } from './GameBoard.tsx';
import { TokenLab } from './TokenLab.tsx';
import { useGame } from './useGame.ts';
import type { GameController } from './useGame.ts';
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
    <div className="leaderboard-columns"><span>RANK / PLAYER</span><span>BEST SCORE</span></div>
    {entries.length ? <ol>{entries.slice(0, large ? 15 : 7).map((entry, index) => <li key={entry.id} className={entry.id === controller.playerId ? 'your-entry' : ''}><span className={`rank rank-${index}`}>{index === 0 && entry.score > 0 ? <Trophy size={17} /> : String(index + 1).padStart(2, '0')}</span><span className={`avatar avatar-${index % 5}`}>{entry.name.slice(0, 2).toUpperCase()}</span><div className="entry-name"><strong>{entry.name}{entry.id === controller.playerId && <small>YOU</small>}</strong><span><i className={entry.online ? 'online-marker' : 'offline-marker'} />{entry.lines} lines<span className="entry-tokens"> / {number(entry.metrics.input + entry.metrics.output)} tokens</span></span></div><strong className="entry-score">{number(entry.score)}</strong></li>)}</ol> : <div className="leaderboard-empty"><Trophy size={36} /><strong>The top spot is open.</strong><span>0 players / 0 scores</span></div>}
    <footer><span><Check size={13} />Server-verified scores</span><span>Best run</span></footer>
  </section>;
}

function RoomStats({ controller }: { controller: GameController }) {
  const metrics = controller.room?.metrics;
  const hitRate = metrics?.input ? Math.round(100 * metrics.cached / metrics.input) : 0;
  return <div className="room-stats"><div><Users size={19} /><span>Players online</span><strong>{controller.room?.online ?? 0}</strong></div><div><Sparkles size={19} /><span>Model requests</span><strong>{metrics?.requests ?? 0}</strong></div><div><Layers3 size={19} /><span>Cache-read share</span><strong>{hitRate}%</strong></div><div><Expand size={19} /><span>Payload tokens saved<small>estimated</small></span><strong>{number(metrics?.compressionSaved ?? 0)}</strong></div></div>;
}

function App() {
  const controller = useGame();
  const [mobileTab, setMobileTab] = useState<'game' | 'lab' | 'scores'>('game');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'light');
  const [sound, setSound] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const lastPieces = useRef(0);
  const lastLines = useRef(0);
  const insight = controller.insights[0] ?? null;
  const rank = (controller.room?.leaderboard.findIndex(entry => entry.id === controller.playerId) ?? -1) + 1;
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
  return <div className={`app ${controller.isProjector ? 'projector-app' : ''}`} data-mobile-tab={mobileTab}>
    <header className="topbar"><a className="brand" href="/"><Mark /><div><h1>TOKENFALL<span>.</span></h1><span className="brand-caption">THE TOKEN ARCADE</span></div></a><div className="session-label"><span className="live-label"><i />LIVE SESSION</span><span>ROOM {controller.room?.code ?? '------'}</span></div><div className="top-actions"><span className={`connection-label ${controller.connected ? '' : 'disconnected'}`}>{controller.connected ? <Wifi size={15} /> : <WifiOff size={15} />}<span>{controller.connected ? 'Connected' : 'Reconnecting'}</span></span><button className="icon-button" aria-label={sound ? 'Mute sound' : 'Enable sound'} title={sound ? 'Mute sound' : 'Enable sound'} onClick={() => { if (!sound) { audio.current ??= new AudioContext(); void audio.current.resume(); } setSound(current => !current); }}>{sound ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><button className="icon-button" onClick={toggleTheme} aria-label="Toggle color theme" title="Toggle color theme">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button><a className="icon-button projector-link" href={controller.isProjector ? '/' : '/?view=room'} target={controller.isProjector ? undefined : '_blank'} rel="noreferrer" title={controller.isProjector ? 'Play game' : 'Open projector view'} aria-label={controller.isProjector ? 'Play game' : 'Open projector view'}>{controller.isProjector ? <Gamepad2 size={18} /> : <Maximize2 size={18} />}</a></div></header>
    <div className="spectrum-rule"><i /><i /><i /><i /><i /><i /><i /></div>
    {controller.isProjector ? <main className="projector-main"><div className="projector-heading"><div><span className="eyebrow">THE ROOM IS LIVE</span><h2>Small tokens.<br />Big moves.</h2></div><span className="projector-model"><Sparkles size={18} />GPT-5.6 LUNA<span>REASONING OFF</span></span></div><RoomStats controller={controller} /><div className="projector-columns"><Leaderboard controller={controller} large /><aside><JoinQr room={controller.room} large /><div className="projector-facts"><span>THE TOKEN EQUATION</span><strong>Input + output = usage</strong><p>Cached input still counts toward context.<br />Compression sends fewer tokens.</p></div></aside></div></main> : <>
      <nav className="mobile-tabs" aria-label="Game views"><button aria-current={mobileTab === 'game' ? 'page' : undefined} onClick={() => setMobileTab('game')}><Gamepad2 size={17} />Play</button><button aria-current={mobileTab === 'lab' ? 'page' : undefined} onClick={() => { if (controller.view.status === 'playing' && controller.joined) controller.act('pause'); setMobileTab('lab'); }}><Sparkles size={17} />Token lab</button><button aria-current={mobileTab === 'scores' ? 'page' : undefined} onClick={() => { if (controller.view.status === 'playing' && controller.joined) controller.act('pause'); setMobileTab('scores'); }}><Trophy size={17} />Scores</button></nav>
      <main className="arcade-layout">
        <section className="play-area" aria-labelledby="play-title"><header className="section-heading"><span className="section-number">01</span><h2 id="play-title">Make your move.</h2><span className="tiny-label">{controller.joined ? controller.name : 'MARATHON'}</span></header>
          <div className="scoreboard"><div className="main-score"><span>SCORE</span><strong data-testid="game-score">{number(controller.view.score)}</strong></div><div><span>LINES</span><strong>{String(controller.view.lines).padStart(2, '0')}</strong></div><div><span>LEVEL</span><strong>{String(controller.view.level).padStart(2, '0')}</strong></div><button className="icon-button" disabled={!controller.joined || controller.view.status === 'over'} title={controller.view.status === 'paused' ? 'Resume game (P)' : 'Pause game (P)'} aria-label={controller.view.status === 'paused' ? 'Resume game' : 'Pause game'} onClick={() => controller.act(controller.view.status === 'paused' ? 'resume' : 'pause')}>{controller.view.status === 'paused' ? <Play size={19} /> : <Pause size={19} />}</button><button className="icon-button" disabled={!controller.joined || controller.busy} title="Restart game" aria-label="Restart game" onClick={() => { controller.act('pause'); setRestartOpen(true); }}><RotateCcw size={18} /></button></div>
          <div className="play-well"><div className="piece-rail hold-rail"><span className="eyebrow">HOLD</span><button className="hold-slot" disabled={!controller.joined || !controller.view.canHold || controller.view.status !== 'playing'} title="Hold piece (C)" aria-label="Hold current piece" onClick={() => controller.act('hold')}><PiecePreview piece={controller.view.hold} /></button><div className="rail-rank"><Trophy size={17} /><span>RANK</span><strong>{rank ? `#${rank}` : '--'}</strong></div></div>
            <div className="board-column"><GameBoard key={theme} view={controller.view} joined={controller.joined} suggestion={insight}>
              {!controller.joined ? <div className="board-overlay join-overlay"><div className="overlay-mark"><Mark /></div><span className="eyebrow">YOUR NEXT HIGH SCORE</span><h3>Let's play.</h3><form onSubmit={event => { event.preventDefault(); controller.join(); }}><label htmlFor="player-name">PLAYER NAME</label><input id="player-name" placeholder="Player name" value={controller.name} maxLength={16} minLength={2} required autoComplete="nickname" onChange={event => controller.setName(event.target.value)} /><button className="primary-button" type="submit" disabled={!controller.connected || controller.joining || !controller.room}>{controller.joining ? 'Joining...' : 'Enter the arcade'}<ArrowRight size={18} /></button></form><span className="join-footer">{controller.room?.online ?? 0} players in the room</span></div> : controller.view.status === 'paused' ? <div className="board-overlay pause-overlay"><Pause size={35} /><h3>Take a breath.</h3><span>GAME PAUSED</span><button className="primary-button" onClick={() => controller.act('resume')}><Play size={16} />Resume game</button></div> : controller.view.status === 'over' ? <div className="board-overlay gameover-overlay"><Trophy size={38} /><span className="eyebrow">RUN COMPLETE</span><h3>{number(controller.view.score)}</h3><span>{controller.view.lines} LINES / LEVEL {controller.view.level}</span><button className="primary-button" onClick={() => void controller.restart()} disabled={controller.busy}><RotateCcw size={16} />Play again</button></div> : null}
            </GameBoard><GameControls act={controller.act} disabled={!controller.joined || !controller.connected || controller.view.status === 'over'} paused={controller.view.status === 'paused'} /></div>
            <div className="piece-rail next-rail"><span className="eyebrow">NEXT</span>{controller.view.next.slice(0, 4).map((piece, index) => <div className="next-piece" key={index}><PiecePreview piece={piece} /></div>)}<span className="bag-label">7-BAG</span></div>
          </div>
          <div className="play-bottom"><span><i className="status-dot" />{controller.joined ? 'YOUR RUN IS LIVE' : 'READY WHEN YOU ARE'}</span><span>10 x 20 / SRS / HOLD</span></div>
          <div className="mobile-luna"><button disabled={!controller.joined || controller.busy || controller.view.status !== 'playing'} onClick={() => void controller.assist()}><Sparkles size={17} />{controller.busy ? 'Luna is choosing...' : 'Ask Luna'}<ArrowRight size={15} /></button>{insight?.pieceId === controller.view.pieceId && insight.status === 'ready' && <button onClick={controller.applySuggestion}><Check size={17} />Play move</button>}<span>{number(controller.metrics.input + controller.metrics.output)} tokens</span></div>
        </section>
        <div className="lab-column"><TokenLab controller={controller} /></div>
        <aside className="audience-column"><Leaderboard controller={controller} /><JoinQr room={controller.room} /><div className="session-totals"><span className="eyebrow">TOGETHER, THIS SESSION</span><div><strong>{number(controller.room?.metrics.cached ?? 0)}</strong><span>input tokens read from cache</span></div><div><strong>{number(controller.room?.metrics.compressionSaved ?? 0)}</strong><span>payload tokens saved <small>estimated</small></span></div></div></aside>
      </main>
    </>}
    <footer className="site-footer"><span><Mark />TOKENFALL / LIVE TOKEN ARCADE</span><span>STANDARD TETRIS RULES<span className="footer-separator"> / </span>REAL MODEL USAGE</span></footer>
    {controller.notice && <div className="notice" role="status"><span>{controller.notice}</span><button className="icon-button" title="Dismiss message" aria-label="Dismiss message" onClick={() => controller.setNotice('')}><X size={16} /></button></div>}
    {restartOpen && <div className="modal-backdrop"><div className="restart-dialog" role="dialog" aria-modal="true" aria-labelledby="restart-title"><RotateCcw size={28} /><h2 id="restart-title">Start a fresh run?</h2><p>Your best score stays on the leaderboard. Your token budget does not reset.</p><div><button className="secondary-button" onClick={() => { setRestartOpen(false); controller.act('resume'); }}>Keep playing</button><button className="primary-button" onClick={() => { setRestartOpen(false); void controller.restart(); }}>New game<ArrowRight size={15} /></button></div></div></div>}
  </div>;
}

export default App;
