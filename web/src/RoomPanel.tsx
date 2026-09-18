import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronLeft, ChevronRight, Copy, LocateFixed, Play, QrCode, RotateCcw, Settings2, Trash2, Trophy, Users, X } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { DEFAULT_TOKEN_TEXT, tokenLabel, tokenShape } from '../../shared/game.ts';
import { DEFAULT_TOKEN_ALLOWANCE, MAX_REQUEST_TOKENS, MAX_TOKEN_ALLOWANCE, reportedTokenBalance } from '../../shared/protocol.ts';
import type { RoomResetMode, RoomResetPreview, RoomResetResult, RoomView, TokenAllowance, TokenChip } from '../../shared/protocol.ts';
import { PiecePreview } from './GameBoard.tsx';
import { formatMoney } from './format.ts';
import type { useGame } from './useGame.ts';

function AllowanceInput({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const id = useId();
  return <div className="allowance-field"><label htmlFor={id}>AI token allowance</label><input id={id} type="number" inputMode="numeric" min={MAX_REQUEST_TOKENS} max={MAX_TOKEN_ALLOWANCE} step={1} required value={value} onChange={event => onChange(event.target.value)} disabled={disabled} aria-describedby={`${id}-scope`} /><small id={`${id}-scope`}>Luna + MCP input + reasoning. {MAX_REQUEST_TOKENS.toLocaleString()} to {MAX_TOKEN_ALLOWANCE.toLocaleString()} tokens.</small></div>;
}

export function AllowanceEditor({ allowance, room, disabled, pending, onSave }: {
  allowance: TokenAllowance; room: RoomView | null; disabled: boolean; pending: boolean; onSave: (limit: number) => void;
}) {
  const [limit, setLimit] = useState(String(allowance.limit));
  const value = Number(limit);
  const committed = allowance.used + allowance.reserved + allowance.unconfirmed;
  const valid = Number.isSafeInteger(value) && value >= Math.max(MAX_REQUEST_TOKENS, committed) && value <= MAX_TOKEN_ALLOWANCE;
  return <form className="allowance-form" onSubmit={event => { event.preventDefault(); if (valid && !disabled && !pending) onSave(value); }}>
    <dl className="allowance-breakdown"><div><dt>Your balance after reported usage</dt><dd>{reportedTokenBalance(allowance).toLocaleString()}</dd></div><div><dt>Reported tokens used</dt><dd>{allowance.used.toLocaleString()}</dd></div><div><dt>Held for in-flight request</dt><dd>{allowance.reserved.toLocaleString()}</dd></div><div><dt>Held for unreported usage <small>upper bound</small></dt><dd>{allowance.unconfirmed.toLocaleString()}</dd></div><div><dt>Your available tokens after holds</dt><dd>{allowance.remaining.toLocaleString()}</dd></div><div><dt>Shared room balance</dt><dd>{room?.allowance ? reportedTokenBalance(room.allowance).toLocaleString() : '--'}</dd></div><div><dt>Room available after holds</dt><dd>{room?.allowance?.remaining.toLocaleString() ?? '--'}</dd></div><div><dt>Shared room requests left</dt><dd>{room?.requestsRemaining?.toLocaleString() ?? '--'}</dd></div><div><dt>Per-request token cap</dt><dd>{MAX_REQUEST_TOKENS.toLocaleString()}</dd></div></dl>
    <AllowanceInput value={limit} onChange={setLimit} disabled={pending || disabled} />
    {value < committed && <p className="field-error">At least {committed.toLocaleString()} tokens are already used or held.</p>}
    <p className="prompt-comparison">One pool for all AI modes. MCP context is included in input; reasoning is included in output. Cached input counts as tokens at its discounted price. Used tokens persist across games. Your limit does not reserve the shared room balance.</p>
    <button type="submit" className="primary-button" disabled={disabled || pending || !valid}><Check size={18} />{pending ? 'Saving...' : 'Save allowance'}</button>
  </form>;
}

export function GameSetup({ initialText = DEFAULT_TOKEN_TEXT, initialTokenLimit = DEFAULT_TOKEN_ALLOWANCE, editing = false, disabled, pending, onSubmit }: {
  initialText?: string; initialTokenLimit?: number; editing?: boolean; disabled: boolean; pending: boolean;
  onSubmit: (setup: { name: string; text?: string; tokenLimit: number }) => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [text, setText] = useState(initialText);
  const [mode, setMode] = useState('sentence');
  const [tokenLimit, setTokenLimit] = useState(String(initialTokenLimit));
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
  const validLimit = Number.isSafeInteger(Number(tokenLimit)) && Number(tokenLimit) >= MAX_REQUEST_TOKENS && Number(tokenLimit) <= MAX_TOKEN_ALLOWANCE;
  return <form className="join-form" aria-label={editing ? 'Change sentence' : 'Join game'} onSubmit={event => { event.preventDefault(); if (!disabled && !pending && validName && validText && validLimit) onSubmit({ name: name.trim(), tokenLimit: Number(tokenLimit), ...(mode === 'sentence' ? { text } : {}) }); }}>
    {!editing && <><h2>Join game</h2><label htmlFor={`${id}-name`}>Name</label><input id={`${id}-name`} name="name" autoComplete="nickname" placeholder="Your name" required minLength={2} maxLength={16} value={name} onChange={event => setName(event.target.value)} disabled={pending} aria-describedby={name && !validName ? `${id}-name-error` : undefined} />{name && !validName && <small id={`${id}-name-error`} className="field-error">Use 2-16 letters, numbers, spaces, _ or -.</small>}
      <fieldset className="segmented-control"><legend>Pieces</legend>{['sentence', 'classic'].map(value => <label key={value}><input type="radio" name={`${id}-mode`} value={value} checked={mode === value} onChange={() => setMode(value)} disabled={pending} /><span>{value === 'sentence' ? 'Sentence' : 'Classic'}</span></label>)}</fieldset></>}
    {mode === 'sentence' && <><label htmlFor={`${id}-sentence`}>Your sentence</label><textarea id={`${id}-sentence`} name="sentence" rows={3} maxLength={500} required value={text} onChange={event => setText(event.target.value)} disabled={pending} aria-describedby={`${id}-preview-status`} />
      <div className="token-preview-status" id={`${id}-preview-status`} role="status"><span>{error ?? (!text.trim() ? 'Enter a sentence.' : current ? current.count > 256 ? 'Use at most 256 tokens.' : `${current.count} tokens / o200k_base` : 'Preparing blocks...')}</span><span>{text.length}/500</span>{error && <button type="button" className="icon-button" aria-label="Retry token preview" title="Retry token preview" onClick={() => { setFailure(null); setRetry(value => value + 1); }}><RotateCcw size={17} /></button>}</div>
      {current && current.count <= 256 && <ol className="token-stream" aria-label="Sentence blocks">{current.tokens.map((chip, index) => <li key={index} data-token-id={chip.id} data-piece={tokenShape(chip.id)} title={`Token ${chip.id} / ${tokenShape(chip.id)} piece`}><PiecePreview piece={tokenShape(chip.id)} /><span>{tokenLabel(chip.text)}</span></li>)}</ol>}
    </>}
    <AllowanceInput value={tokenLimit} onChange={setTokenLimit} disabled={pending} />
    <button type="submit" className="primary-button" disabled={disabled || pending || !validName || !validText || !validLimit}><Play size={18} />{pending ? editing ? 'Starting...' : 'Joining...' : editing ? 'Start with sentence' : 'Join game'}</button>
  </form>;
}

export function RoomMaintenance({ game }: { game: ReturnType<typeof useGame> }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const pending = useRef(false);
  const previewRequest = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RoomResetMode>('all');
  const [preview, setPreview] = useState<RoomResetPreview | null>(null);
  const [previewExpired, setPreviewExpired] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RoomResetResult | null>(null);
  const status = game.room?.maintenance;
  const blocked = status?.pendingRequests ? 'Waiting for pending Luna requests.' : status?.activeGames ? 'Pause the other active games before resetting.' : status?.resetting ? 'A room reset is already in progress.' : '';
  const expired = preview !== null && previewExpired;
  const valid = preview?.mode === mode && confirmation.trim() === preview.room && !expired && !blocked && game.connected && !loading && !submitting;
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  useEffect(() => () => previewRequest.current?.abort(), []);
  useEffect(() => {
    if (!preview) return;
    const timer = window.setTimeout(() => setPreviewExpired(true), Math.max(0, preview.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [preview]);

  async function refreshPreview(selected: RoomResetMode) {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreview(null);
    setPreviewExpired(false);
    setConfirmation('');
    setError('');
    setLoading(true);
    try {
      if (!await game.prepareMaintenance()) throw new Error('Could not pause and sync your game. Reconnect and try again.');
      const response = await fetch('/api/maintenance/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Room-Maintenance': '1' }, body: JSON.stringify({ mode: selected }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Preview unavailable.');
      if (!controller.signal.aborted) setPreview(data);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Preview unavailable.');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }

  async function submit() {
    if (!valid || !preview || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/maintenance/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Room-Maintenance': '1' }, body: JSON.stringify({ mode, confirmRoom: confirmation.trim(), confirmationId: preview.confirmationId }), signal: AbortSignal.timeout(30000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Reset failed. Refresh the preview before retrying.');
      setResult(data);
      setPreview(null);
      setConfirmation('');
    } catch (failure) {
      setPreview(null);
      setError(failure instanceof Error && failure.name !== 'TimeoutError' && failure.name !== 'TypeError' ? failure.message : 'The reset result could not be confirmed. Check the room and refresh the preview before retrying.');
    } finally { pending.current = false; setSubmitting(false); }
  }

  return <>
    <button className="information-button" aria-label="Room maintenance" aria-haspopup="dialog" title="Room maintenance (local test)" disabled={!game.connected || game.joining} onClick={() => { setOpen(true); setResult(null); void refreshPreview(mode); }}><Settings2 size={18} /><span>Admin</span></button>
    <dialog className="prompt-dialog reset-dialog" ref={dialog} aria-labelledby={`${id}-title`} onCancel={event => { if (pending.current) event.preventDefault(); }} onClose={() => { setOpen(false); previewRequest.current?.abort(); game.resumeAfterInspection(); }}>
      <header><div><h2 id={`${id}-title`}>Room maintenance</h2><small className="reset-local">Local test / no sign-in</small></div><button className="icon-button" aria-label="Close room maintenance" title="Close room maintenance" disabled={submitting} onClick={() => dialog.current?.close()}><X size={19} /></button></header>
      {open && (result ? <div className="reset-result" role="status" data-testid="reset-result"><Check size={24} /><h3>{result.mode === 'all' ? 'Leaderboard and history cleared' : 'Scores cleared'}</h3><p>{result.mode === 'all' ? `${result.before.players.toLocaleString()} saved ${result.before.players === 1 ? 'player' : 'players'} removed. Everyone must join again.` : `Scores reset for ${result.before.players.toLocaleString()} ${result.before.players === 1 ? 'player' : 'players'}. Names and AI usage retained.`}</p><dl className="allowance-breakdown"><div><dt>Room</dt><dd>{result.room}</dd></div><div><dt>Players remaining</dt><dd>{result.after.players.toLocaleString()}</dd></div><div><dt>AI requests retained</dt><dd>{result.after.requests.toLocaleString()}</dd></div></dl><p className="reset-backup">Recovery backup <code>{result.backup}</code></p><button className="primary-button" onClick={() => dialog.current?.close()}><Check size={18} />Done</button></div> : <form className="reset-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <fieldset className="reset-options" disabled={loading || submitting}><legend>Reset scope</legend>{(['all', 'scores'] as const).map(value => <label key={value}><input type="radio" name={`${id}-mode`} aria-label={value === 'all' ? 'Leaderboard and history' : 'Scores only'} checked={mode === value} onChange={() => { setMode(value); void refreshPreview(value); }} /><span>{value === 'all' ? 'Leaderboard + history' : 'Scores only'}<small>{value === 'all' ? 'Remove saved players, games and in-app AI usage.' : 'Keep player names and AI usage.'}</small></span></label>)}</fieldset>
        <div className="reset-preview-heading"><h3>Room {game.room?.code}</h3><button type="button" className="icon-button" aria-label="Refresh reset preview" title="Refresh reset preview" disabled={loading || submitting || !game.connected} onClick={() => void refreshPreview(mode)}><RotateCcw size={18} /></button></div>
        {loading ? <p role="status">Loading preview...</p> : preview && <dl className="allowance-breakdown" data-testid="reset-preview"><div><dt>Saved players</dt><dd data-testid="reset-player-count">{preview.before.players.toLocaleString()}</dd></div><div><dt>Nonzero scores</dt><dd>{preview.before.nonzeroScores.toLocaleString()}</dd></div><div><dt>AI requests</dt><dd>{preview.before.requests.toLocaleString()}</dd></div><div><dt>Tokens used</dt><dd>{preview.before.usedTokens.toLocaleString()}</dd></div></dl>}
        <dl className="allowance-breakdown reset-live"><div><dt>Active games</dt><dd data-testid="reset-active-games">{status?.activeGames ?? 0}</dd></div><div><dt>Pending Luna requests</dt><dd data-testid="reset-pending-requests">{status?.pendingRequests ?? 0}</dd></div></dl>
        {blocked && <p className="field-error" role="status">{blocked}</p>}
        {expired && <p className="field-error" role="status">Preview expired. Refresh before resetting.</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
        <p className="reset-warning">{mode === 'all' ? 'Saved players and in-app history will be deleted. Azure billing and the room link are unchanged.' : 'Current games and saved high scores will be cleared. Player names and AI usage are unchanged.'} A recovery backup is required.</p>
        <div className="allowance-field"><label htmlFor={`${id}-confirmation`}>Confirm room code</label><input id={`${id}-confirmation`} aria-label="Confirm room code" value={confirmation} onChange={event => setConfirmation(event.target.value.toUpperCase())} maxLength={6} placeholder={game.room?.code} autoComplete="off" spellCheck={false} disabled={!preview || loading || submitting} /></div>
        <div className="reset-actions"><button type="button" className="reset-cancel" disabled={submitting} onClick={() => dialog.current?.close()}>Cancel</button><button type="submit" className="primary-button reset-submit" disabled={!valid}><Trash2 size={18} />{submitting ? 'Resetting...' : mode === 'all' ? 'Clear room' : 'Reset scores'}</button></div>
      </form>)}
    </dialog>
  </>;
}

export function RoomShare({ game }: { game: ReturnType<typeof useGame> }) {
  const id = useId();
  const [sharing, setSharing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const qrDialog = useRef<HTMLDialogElement | null>(null);
  const room = game.room;
  useEffect(() => { if (sharing) qrDialog.current?.showModal(); }, [sharing]);
  const invite = new URL(room?.joinUrl ?? window.location.origin);
  invite.username = '';
  invite.password = '';
  invite.pathname = '/';
  invite.search = '';
  invite.hash = '';
  if (room) invite.searchParams.set('room', room.code);
  const audienceLink = Boolean(room) && !['localhost', '[::1]', '0.0.0.0'].includes(invite.hostname) && !invite.hostname.endsWith('.localhost') && !/^127\./.test(invite.hostname);
  async function copyInvite() {
    try { await navigator.clipboard.writeText(invite.href); setFeedback('Game link copied.'); }
    catch { setFeedback('Select the game link to copy it.'); }
  }
  return <>
    <button className="information-button" aria-label="Share game" aria-haspopup="dialog" disabled={!room} onClick={() => { setFeedback(''); setSharing(true); }}><QrCode size={18} /><span>Share game</span></button>
    <dialog className="prompt-dialog join-qr-dialog" ref={qrDialog} aria-labelledby={`${id}-qr-title`} onClose={() => setSharing(false)}>
      <header><h2 id={`${id}-qr-title`}>Join room {room?.code}</h2><button className="icon-button" aria-label="Close join QR code" title="Close QR code" onClick={() => qrDialog.current?.close()}><X size={19} /></button></header>
      {sharing && <>
        {audienceLink ? <QRCodeCanvas value={invite.href} size={1024} level="M" marginSize={4} role="img" aria-label="Audience join QR code" /> : <p className="field-error" role="status">Audience QR unavailable on localhost. A public or network-accessible game URL is required.</p>}
        <div className="invite-link"><input aria-label="Game invite link" readOnly value={invite.href} onFocus={event => event.target.select()} /><button className="icon-button" aria-label="Copy game link" title="Copy game link" onClick={() => void copyInvite()}><Copy size={18} /></button></div>
        <a className="qr-join-link" href={invite.href} target="_blank" rel="noopener noreferrer">{invite.href}</a>
        {feedback && <p role="status">{feedback}</p>}
      </>}
    </dialog>
  </>;
}

export function RoomPanel({ game, rankingsOpen, onCloseRankings, onReturn }: { game: ReturnType<typeof useGame>; rankingsOpen: boolean; onCloseRankings: () => void; onReturn: () => void }) {
  const id = useId();
  const [ranking, setRanking] = useState('points');
  const [page, setPage] = useState(0);
  const rankingsDialog = useRef<HTMLDialogElement | null>(null);
  const room = game.room;
  const entries = (ranking === 'points' ? room?.pointsLeaderboard : room?.leaderboard?.filter(entry => entry.challengeScore !== null)) ?? [];
  const pageCount = Math.max(1, Math.ceil(entries.length / 10));
  const currentPage = Math.min(page, pageCount - 1);
  const ownIndex = entries.findIndex(entry => entry.id === game.player?.id);
  useEffect(() => {
    if (rankingsOpen) {
      rankingsDialog.current?.showModal();
      rankingsDialog.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    }
  }, [rankingsOpen]);
  useEffect(() => { if (game.resetVersion) rankingsDialog.current?.close(); }, [game.resetVersion]);
  const leaderboard = <section className="leaderboard" aria-labelledby={`${id}-scores`}>
      <header><h2 id={`${id}-scores`} tabIndex={-1}><Trophy size={19} />Leaderboard</h2><span className={game.connected ? 'live-label' : ''}>{game.connected ? 'Live' : 'Offline'}</span>{rankingsOpen && <button className="icon-button" aria-label="Close leaderboard" title="Close leaderboard" onClick={() => rankingsDialog.current?.close()}><X size={19} /></button>}</header>
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
    </section>;
  return <aside className="room-panel" aria-label="Game room">
    <header className="room-heading"><div><span>ROOM <b data-testid="room-code">{room?.code ?? '------'}</b></span><small><Users size={14} />{game.connected ? `${room?.online ?? 0}/${room?.capacity ?? 50} online` : 'Reconnecting'}</small></div>{game.joined && <button className="icon-button" aria-label="Back to game" title="Back to game" onClick={onReturn}><ArrowUp size={19} /></button>}</header>
    <div className="allowance-strip" aria-label="AI allowance balances">
      {game.joined && <span>Personal <b data-testid="personal-tokens-left">{game.allowance ? reportedTokenBalance(game.allowance).toLocaleString() : '--'}</b> / <b data-testid="ai-token-limit">{game.allowance?.limit.toLocaleString() ?? '--'}</b></span>}<span>Room <b data-testid="room-tokens-left">{room?.allowance ? reportedTokenBalance(room.allowance).toLocaleString() : '--'}</b> tokens left</span><span><b data-testid="room-requests-left">{room?.requestsRemaining?.toLocaleString() ?? '--'}</b> room requests left</span>
      {game.joined && <span>Available now <b data-testid="available-tokens-now">{game.allowance && room?.allowance ? Math.min(game.allowance.remaining, room.allowance.remaining).toLocaleString() : '--'}</b></span>}
      {(game.busy || (game.allowance?.reserved ?? 0) > 0) && <span data-testid="allowance-reserved">{game.allowance?.reserved ? `${game.allowance.reserved.toLocaleString()} held for current request` : 'Reservation pending'}</span>}
      {(game.allowance?.unconfirmed ?? 0) > 0 && <span data-testid="allowance-unconfirmed">{game.allowance!.unconfirmed.toLocaleString()} held / usage unconfirmed</span>}
    </div>
    {!game.joined ? game.sessionName ? <div className="returning-player"><h2>{game.sessionName}</h2><button className="primary-button" disabled={!game.connected || game.joining} onClick={() => game.join()}><Play size={18} />{game.joining ? 'Reconnecting...' : 'Rejoin game'}</button></div> : <GameSetup disabled={!game.connected || !room || room.online >= room.capacity} pending={game.joining} onSubmit={game.join} /> : <div className="player-summary"><div><strong data-testid="player-name">{game.player?.name}</strong><p title={game.player?.tokenText}>{game.player?.tokenText || 'Classic pieces'}</p></div></div>}
    {!game.joined && room && room.online >= room.capacity && <p className="field-error" role="status">Room full. Waiting for a free spot.</p>}
    {!rankingsOpen && leaderboard}
    <dialog className="prompt-dialog leaderboard-dialog" ref={rankingsDialog} aria-labelledby={`${id}-scores`} onClose={onCloseRankings}>{rankingsOpen && leaderboard}</dialog>
  </aside>;
}