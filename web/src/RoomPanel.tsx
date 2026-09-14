import { useEffect, useId, useState } from 'react';
import { ArrowUp, ChevronLeft, ChevronRight, Copy, Link2, LocateFixed, Play, Quote, RotateCcw, Trophy, Users } from 'lucide-react';
import { DEFAULT_TOKEN_TEXT, tokenLabel, tokenShape } from '../../shared/game.ts';
import type { TokenChip } from '../../shared/protocol.ts';
import { PiecePreview } from './GameBoard.tsx';
import { formatMoney } from './format.ts';
import type { useGame } from './useGame.ts';

export function GameSetup({ initialText = DEFAULT_TOKEN_TEXT, editing = false, disabled, pending, onSubmit }: {
  initialText?: string; editing?: boolean; disabled: boolean; pending: boolean;
  onSubmit: (setup: { name: string; text?: string }) => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [text, setText] = useState(initialText);
  const [mode, setMode] = useState('sentence');
  const [preview, setPreview] = useState<{ text: string; count: number; tokens: TokenChip[] } | null>(null);
  const [failure, setFailure] = useState<{ text: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (mode !== 'sentence' || !text.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/tokenize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.tokens) || !Number.isSafeInteger(result.count)) throw new Error('Token preview unavailable. Try again.');
        if (!controller.signal.aborted) { setPreview({ text, count: result.count, tokens: result.tokens }); setFailure(null); }
      } catch {
        if (!controller.signal.aborted) setFailure({ text, message: 'Token preview unavailable. Try again.' });
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, text, retry]);
  const current = preview?.text === text ? preview : null;
  const error = failure?.text === text ? failure.message : null;
  const validName = editing || /^[\p{L}\p{N} _-]{2,16}$/u.test(name.trim());
  const validText = mode === 'classic' || Boolean(text.trim() && current && current.count > 0 && current.count <= 256 && !error);
  return <form className="join-form" aria-label={editing ? 'Change sentence' : 'Join game'} onSubmit={event => { event.preventDefault(); if (!disabled && !pending && validName && validText) onSubmit({ name: name.trim(), ...(mode === 'sentence' ? { text } : {}) }); }}>
    {!editing && <><h2>Join game</h2><label htmlFor={`${id}-name`}>Name</label><input id={`${id}-name`} name="name" autoComplete="nickname" placeholder="Your name" required minLength={2} maxLength={16} value={name} onChange={event => setName(event.target.value)} disabled={pending} aria-describedby={name && !validName ? `${id}-name-error` : undefined} />{name && !validName && <small id={`${id}-name-error`} className="field-error">Use 2-16 letters, numbers, spaces, _ or -.</small>}
      <fieldset className="segmented-control"><legend>Pieces</legend>{['sentence', 'classic'].map(value => <label key={value}><input type="radio" name={`${id}-mode`} value={value} checked={mode === value} onChange={() => setMode(value)} disabled={pending} /><span>{value === 'sentence' ? 'Sentence' : 'Classic'}</span></label>)}</fieldset></>}
    {mode === 'sentence' && <><label htmlFor={`${id}-sentence`}>Your sentence</label><textarea id={`${id}-sentence`} name="sentence" rows={3} maxLength={500} required value={text} onChange={event => setText(event.target.value)} disabled={pending} aria-describedby={`${id}-preview-status`} />
      <div className="token-preview-status" id={`${id}-preview-status`} role="status"><span>{error ?? (!text.trim() ? 'Enter a sentence.' : current ? current.count > 256 ? 'Use at most 256 tokens.' : `${current.count} tokens / o200k_base` : 'Preparing blocks...')}</span><span>{text.length}/500</span>{error && <button type="button" className="icon-button" aria-label="Retry token preview" title="Retry token preview" onClick={() => { setFailure(null); setRetry(value => value + 1); }}><RotateCcw size={17} /></button>}</div>
      {current && current.count <= 256 && <ol className="token-stream" aria-label="Sentence blocks">{current.tokens.map((chip, index) => <li key={index} data-token-id={chip.id} data-piece={tokenShape(chip.id)} title={`Token ${chip.id} / ${tokenShape(chip.id)} piece`}><PiecePreview piece={tokenShape(chip.id)} /><span>{tokenLabel(chip.text)}</span></li>)}</ol>}
    </>}
    <button type="submit" className="primary-button" disabled={disabled || pending || !validName || !validText}><Play size={18} />{pending ? editing ? 'Starting...' : 'Joining...' : editing ? 'Start with sentence' : 'Join game'}</button>
  </form>;
}

export function RoomPanel({ game, onEdit, onReturn }: { game: ReturnType<typeof useGame>; onEdit: () => void; onReturn: () => void }) {
  const id = useId();
  const [ranking, setRanking] = useState('points');
  const [page, setPage] = useState(0);
  const [sharing, setSharing] = useState(false);
  const room = game.room;
  const entries = (ranking === 'points' ? room?.pointsLeaderboard : room?.leaderboard?.filter(entry => entry.challengeScore !== null)) ?? [];
  const pageCount = Math.max(1, Math.ceil(entries.length / 10));
  const currentPage = Math.min(page, pageCount - 1);
  const ownIndex = entries.findIndex(entry => entry.id === game.player?.id);
  const invite = new URL(room?.joinUrl ?? window.location.origin);
  if (room) invite.searchParams.set('room', room.code);
  async function copyInvite() {
    try { await navigator.clipboard.writeText(invite.href); game.setNotice('Game link copied.'); }
    catch { game.setNotice('Select the game link to copy it.'); }
  }
  return <aside className="room-panel" aria-label="Game room">
    <header className="room-heading"><div><span>ROOM <b data-testid="room-code">{room?.code ?? '------'}</b></span><small><Users size={14} />{game.connected ? `${room?.online ?? 0}/${room?.capacity ?? 50} online` : 'Reconnecting'}</small></div><div className="room-actions"><button className="icon-button" aria-label="Share game" title="Share game" aria-expanded={sharing} disabled={!room} onClick={() => setSharing(value => !value)}><Link2 size={19} /></button>{game.joined && <button className="icon-button" aria-label="Back to game" title="Back to game" onClick={onReturn}><ArrowUp size={19} /></button>}</div></header>
    {sharing && <div className="invite-link"><input aria-label="Game invite link" readOnly value={invite.href} onFocus={event => event.target.select()} /><button className="icon-button" aria-label="Copy game link" title="Copy game link" onClick={() => void copyInvite()}><Copy size={17} /></button></div>}
    {!game.joined ? game.sessionName ? <div className="returning-player"><h2>{game.sessionName}</h2><button className="primary-button" disabled={!game.connected || game.joining} onClick={() => game.join()}><Play size={18} />{game.joining ? 'Reconnecting...' : 'Rejoin game'}</button></div> : <GameSetup disabled={!game.connected || !room || room.online >= room.capacity} pending={game.joining} onSubmit={game.join} /> : <div className="player-summary"><div><strong data-testid="player-name">{game.player?.name}</strong><p title={game.player?.tokenText}>{game.player?.tokenText || 'Classic pieces'}</p></div><button className="icon-button" aria-label="Change sentence" title="Change sentence" disabled={game.busy || game.joining || !game.connected} onClick={onEdit}><Quote size={19} /></button></div>}
    {!game.joined && room && room.online >= room.capacity && <p className="field-error" role="status">Room full. Waiting for a free spot.</p>}
    <section className="leaderboard" aria-labelledby={`${id}-scores`}>
      <header><h2 id={`${id}-scores`} tabIndex={-1}><Trophy size={19} />Leaderboard</h2><span className={game.connected ? 'live-label' : ''}>{game.connected ? 'Live' : 'Offline'}</span></header>
      <fieldset className="segmented-control"><legend className="visually-hidden">Rank by</legend>{['points', 'efficiency'].map(value => <label key={value}><input type="radio" name={`${id}-ranking`} checked={ranking === value} onChange={() => { setRanking(value); setPage(0); }} /><span>{value === 'points' ? 'Points' : 'Points / cent'}</span></label>)}</fieldset>
      <table><caption className="visually-hidden">Top 50 by {ranking === 'points' ? 'best Tetris score' : 'points per estimated US cent'}</caption><thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">{ranking === 'points' ? 'Points' : 'Pts / cent'}</th></tr></thead><tbody>
        {entries.slice(currentPage * 10, (currentPage + 1) * 10).map((entry, index) => <tr key={entry.id} data-testid="leaderboard-row" data-player-id={entry.id} aria-current={entry.id === game.player?.id ? 'true' : undefined}>
          <td className="rank-number">{currentPage * 10 + index + 1}</td><th scope="row"><div className="rank-player"><i className={entry.online ? 'player-online' : ''} aria-label={entry.online ? 'Online' : 'Offline'} title={entry.online ? 'Online' : 'Offline'} /><span>{entry.name}</span>{entry.id === game.player?.id && <small>You</small>}</div><small className="rank-cost">{formatMoney(entry.costUsd)} est.{entry.unmeteredRequests > 0 ? ' / usage pending' : ''}</small></th>
          <td className="rank-score"><strong>{(ranking === 'points' ? entry.score : entry.challengeScore!).toLocaleString(undefined, { maximumFractionDigits: ranking === 'points' ? 0 : 1 })}</strong><small>{entry.lines.toLocaleString()} lines</small></td>
        </tr>)}
        {!entries.length && <tr><td colSpan={3} className="empty-ranking">{!room ? 'Connecting to the room...' : ranking === 'points' ? 'No players yet.' : 'No ranked scores yet.'}</td></tr>}
      </tbody></table>
      <footer><span>{entries.length} listed / top 50</span><div><button className="icon-button" aria-label="Previous leaderboard page" title="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18} /></button><span data-testid="leaderboard-page">{currentPage + 1}/{pageCount}</span><button className="icon-button" aria-label="Next leaderboard page" title="Next page" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight size={18} /></button></div></footer>
      {game.joined && <div className="own-rank"><span>Your position <b data-testid="own-rank">{ownIndex >= 0 ? `#${ownIndex + 1}` : ranking === 'points' ? 'Outside top 50' : 'Unranked'}</b></span><button className="icon-button" aria-label="Show my ranking" title="Show my ranking" disabled={ownIndex < 0} onClick={() => setPage(Math.floor(ownIndex / 10))}><LocateFixed size={18} /></button></div>}
    </section>
  </aside>;
}