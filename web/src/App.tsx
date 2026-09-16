import { useEffect, useRef, useState } from 'react';
import { Bot, Brain, Columns2, FileJson2, History, Layers3, Pause, Play, Plug, RotateCcw, ScanSearch, SlidersHorizontal, Trophy, Wifi, WifiOff, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { costForUsage, MAX_REQUEST_TOKENS, reportedTokenBalance } from '../../shared/protocol.ts';
import type { Insight, McpLookaheadResult, TokenRates } from '../../shared/protocol.ts';
import { GameBoard, GameControls, PiecePreview } from './GameBoard.tsx';
import { AllowanceEditor, GameSetup, RoomPanel } from './RoomPanel.tsx';
import { formatMoney } from './format.ts';
import { useGame } from './useGame.ts';
import type { RequestRecord } from './useGame.ts';
import './App.css';

const number = (value: number) => value.toLocaleString();
const signedMoney = (value: number | null) => value === null ? '--' : `${value < 0 ? '-' : value > 0 ? '+' : ''}${formatMoney(Math.abs(value))}`;
const cacheLabel = (insight: Insight) => insight.usage.cached > 0 ? 'Hit' : insight.usage.cacheWrites > 0 ? 'Miss / written' : insight.cacheEnabled ? 'Miss' : 'Off';
const cacheEffect = (insight: Insight, rates: TokenRates | undefined) => rates ? (insight.usage.cached * (rates.cachedInput - rates.input) + insight.usage.cacheWrites * (rates.cacheWrite - rates.input)) / 1000000 : null;

function CacheActivity({ records, selected, rates, pending, unknown, onSelect }: {
  records: RequestRecord[]; selected: Insight; rates: TokenRates | undefined;
  pending: boolean; unknown: number; onSelect: (insight: Insight) => void;
}) {
  const record = records.find(entry => entry.insight.id === selected.id);
  return <>
    <div className="activity-meta"><span>Latest {records.length} replies / since page load / max 20</span><span role="status" data-testid="cache-activity-pending">{pending ? 'Request in flight / outcome pending' : 'No request in flight'}</span></div>
    {unknown > 0 && <p className="activity-warning">{number(unknown)} request(s) without usage. Their cache outcomes are unknown.</p>}
    <div className="activity-table" tabIndex={0} aria-label="Recent cache requests"><table><thead><tr><th scope="col">Reply</th><th scope="col">Fixed instructions</th><th scope="col">Read / written</th><th scope="col">USD effect <small>est.</small></th></tr></thead><tbody>{records.map(entry => {
      const result = entry.insight;
      const effect = cacheEffect(result, rates);
      const selectedRow = result.id === selected.id;
      return <tr key={result.id} data-testid="cache-activity-row" data-reply={entry.number} data-outcome={cacheLabel(result)} className={selectedRow ? 'selected-reply' : ''}>
        <th scope="row"><button className="reply-button" aria-label={`Inspect cache reply ${entry.number}`} aria-pressed={selectedRow} title={new Date(entry.receivedAt).toLocaleTimeString()} onClick={() => onSelect(result)}>#{entry.number}<FileJson2 size={13} /></button></th>
        <td><strong>{cacheLabel(result)}</strong><small>{result.usage.cached > 0 ? 'Prefix reused' : result.usage.cacheWrites > 0 ? 'Prefix stored, not reused' : result.cacheEnabled ? 'Prefix not reused' : 'Cache bypassed'}</small></td>
        <td>{number(result.usage.cached)}<small>{number(result.usage.cacheWrites)} written</small></td>
        <td className={effect !== null && effect < 0 ? 'saved-cost' : effect !== null && effect > 0 ? 'write-premium' : ''}>{signedMoney(effect)}</td>
      </tr>;
    })}</tbody></table></div>
    <h3 className="activity-selection" data-testid="cache-selected-reply">{record ? `Reply #${record.number}` : 'Selected reply'} / {cacheLabel(selected)}</h3>
    <p data-testid="inspected-cache-result">{selected.usage.cached > 0 ? `Cache hit: ${number(selected.usage.cached)} input tokens reused${selected.usage.cacheWrites > 0 ? `; ${number(selected.usage.cacheWrites)} tokens also written` : ''}` : selected.usage.cacheWrites > 0 ? `Cache miss: ${number(selected.usage.cacheWrites)} tokens written, none reused` : selected.cacheEnabled ? 'Cache miss: no input tokens reused' : 'Cache was off for this request'}</p>
    <dl className="cache-content-breakdown"><div><dt>Fixed instructions</dt><dd>{selected.usage.cached > 0 ? 'Reused from the cached prefix' : selected.usage.cacheWrites > 0 ? 'Stored for later reuse; this was a miss' : selected.cacheEnabled ? 'Sent without a cache match' : 'Sent with caching disabled'}</dd></div><div><dt>Board and legal moves</dt><dd>Fresh input for this request, not a cache hit</dd></div><div><dt>Model output</dt><dd>{number(selected.usage.output)} output tokens generated{selected.usage.reasoning === null ? '; reasoning count not reported' : `, including ${number(selected.usage.reasoning)} reasoning tokens`}, not cached</dd></div></dl>
    <h3>Instruction text for this reply</h3>
    {selected.systemPrompt ? <pre tabIndex={0} data-testid="cached-instructions">{selected.systemPrompt}</pre> : <p>Instruction text is unavailable for this earlier reply.</p>}
    <small>Provider-confirmed token counts, not word-level cache offsets. Replies missing from this tab's history are not reconstructed.</small>
  </>;
}

function CompressionComparison({ insight }: { insight: Insight }) {
  const comparison = insight.promptComparison;
  const reduction = insight.rawTokens > 0 ? Math.round(100 * (1 - insight.packedTokens / insight.rawTokens)) : 0;
  if (!comparison) return <><p>Before/after data is unavailable for this earlier reply. Exact sent prompt:</p><pre tabIndex={0} data-testid="sent-prompt">{insight.prompt}</pre></>;
  return <>
    <p className="compression-verdict" data-testid="compression-verdict">{insight.compression ? 'Compression was ON. The after version was sent.' : 'Compression was OFF. The before version was sent; the after version was not.'}</p>
    <div className="comparison-metrics"><strong>{number(insight.rawTokens)} <span>-&gt;</span> {number(insight.packedTokens)} tokens</strong><span>{number(insight.rawTokens - insight.packedTokens)} fewer / {reduction}% reduction</span></div>
    <p className="prompt-comparison">Same board, occupied positions, and legal choices. Local board-token estimates; fixed instructions and output are separate.</p>
    <div className="prompt-pair">
      <section data-testid="compression-before"><header><h3>Before / cell JSON</h3><span>{insight.compression ? 'Equivalent, not sent' : 'Sent to Luna'}</span></header><pre tabIndex={0} data-testid={insight.compression ? 'verbose-prompt' : 'sent-prompt'}>{comparison.verbose}</pre></section>
      <section data-testid="compression-after"><header><h3>After / packed rows</h3><span>{insight.compression ? 'Sent to Luna' : 'Alternative, not sent'}</span></header><pre tabIndex={0} data-testid={insight.compression ? 'sent-prompt' : 'packed-prompt'}>{comparison.packed}</pre></section>
    </div>
    <small>Exact encodings from the same request snapshot. Opening this comparison makes no model call.</small>
  </>;
}

function CacheReceipt({ insight, rates, pending, enabled, hasHistory, canInspect, onInspect }: {
  insight: Insight | null; rates: TokenRates | undefined; pending: boolean;
  enabled: boolean; hasHistory: boolean; canInspect: boolean; onInspect: () => void;
}) {
  const usage = insight?.usage;
  const state = usage && usage.cached > 0 ? 'hit' : usage && usage.cacheWrites > 0 ? 'write' : insight?.cacheEnabled ? 'miss' : insight ? 'off' : 'pending';
  const label = state === 'hit' ? 'Cache hit' : state === 'write' ? 'Cache miss / written' : state === 'miss' ? 'Cache miss' : state === 'off' ? 'Cache was off' : pending ? 'Checking cache' : hasHistory ? 'No recent cache receipt' : enabled ? 'Cache ready' : 'Cache off';
  const adjustment = usage && rates ? (usage.cached * (rates.cachedInput - rates.input) + usage.cacheWrites * (rates.cacheWrite - rates.input)) / 1000000 : null;
  const instructions = usage ? usage.cached > 0 ? usage.cacheWrites > 0 ? `${number(usage.cached)} reused + ${number(usage.cacheWrites)} written` : `${number(usage.cached)} input tokens reused` : usage.cacheWrites > 0 ? `${number(usage.cacheWrites)} written; none reused` : '0 tokens reused' : pending ? 'Awaiting usage' : hasHistory ? 'Awaiting a new receipt' : enabled ? 'Eligible next request' : 'Reuse disabled';
  return <section className={`cache-receipt cache-${state}`} aria-label="Latest cache result" data-testid="cache-receipt" data-cache-state={state}>
    <header><Layers3 size={15} /><strong data-testid="cache-result-label">{label}</strong><small>{insight ? 'Last reply' : 'Next request'}</small><button className="icon-button" aria-label="Inspect cached instructions" title="Live cache activity and instruction text" disabled={!canInspect} onClick={onInspect}><History size={17} /></button></header>
    <div className="cache-parts"><div className="cached-part"><span>Fixed Tetris instructions</span><b data-testid="cache-reused">{instructions}</b></div><div><span>Board + next move</span><b>{insight ? 'Processed fresh' : 'Always processed fresh'}</b></div></div>
    {insight && <footer><span>Cache effect, this reply <small>est.</small></span><b data-testid="cache-request-adjustment" className={adjustment !== null && adjustment < 0 ? 'saved-cost' : adjustment !== null && adjustment > 0 ? 'write-premium' : ''}>{signedMoney(adjustment)}</b></footer>}
  </section>;
}

function McpResults({ record, rates }: { record: RequestRecord; rates: TokenRates | undefined }) {
  const lookup = record.insight.mcpLookup!;
  const analysis = lookup.tool === 'analyze_future_moves' ? JSON.parse(lookup.result) as McpLookaheadResult : null;
  const extraCost = lookup.addedInputTokens !== undefined && rates ? lookup.addedInputTokens * rates.input / 1000000 : null;
  return <>
    <p className="prompt-comparison">Reply #{record.number} / application-triggered / read only</p>
    {analysis && <>
      <div className="mcp-analysis-summary"><strong>2-piece lookahead</strong><span data-testid="mcp-analysis-counts">{number(analysis.candidatesEvaluated)} current moves / {number(analysis.continuationsEvaluated)} continuations tested</span></div>
      <div className="mcp-forecast-table" tabIndex={0} aria-label="Two-piece forecasts"><table><thead><tr><th scope="col">Move</th><th scope="col">Safe replies</th><th scope="col">Lowest-hole path</th><th scope="col">More-clear path</th></tr></thead><tbody>{analysis.moves.map(([move, replies, surviving, lowest, clears]) => <tr key={move} data-testid="mcp-forecast-row"><th scope="row">{move}</th><td>{surviving}/{replies}</td>{[lowest, clears].map((forecast, index) => <td key={index}>{forecast ? <><strong>{forecast[3]} lines / {forecast[4]} holes</strong><small>Height {forecast[5]} / {forecast[1]}{forecast[2] ? ' via Hold' : ''}</small></> : <span>{index === 0 ? 'No safe reply' : lowest ? 'Same path' : '--'}</span>}</td>)}</tr>)}</tbody></table></div>
      <p className="prompt-comparison">Achievable outcomes after two placements, not executed moves. Each path is a separate forecast; no survival guarantee beyond this horizon.</p>
    </>}
    <dl className="mcp-receipt"><div><dt>Server</dt><dd data-testid="mcp-server">{lookup.server}</dd></div><div><dt>Tool</dt><dd data-testid="mcp-tool">{lookup.tool}</dd></div><div><dt>Transport</dt><dd>JSON-RPC / {lookup.transport}</dd></div><div><dt>Analysis time</dt><dd>{number(lookup.durationMs)} ms</dd></div><div><dt>Result tokens <small>est.</small></dt><dd data-testid="mcp-result-tokens">{number(lookup.resultTokens)}</dd></div>{lookup.addedInputTokens !== undefined && <><div><dt>Extra input <small>est.</small></dt><dd data-testid="mcp-added-tokens">{number(lookup.addedInputTokens)} tokens</dd></div><div><dt>Extra input cost <small>est.</small></dt><dd data-testid="mcp-added-cost">{formatMoney(extraCost)}</dd></div></>}</dl>
    {lookup.addedInputTokens !== undefined && <p className="prompt-comparison">Incremental input at the displayed full input rate. Already included in AI cost; cache reuse can reduce it. Not a separate fee.</p>}
    <details className="mcp-raw"><summary>Exact tool arguments and result</summary><h3>Tool arguments</h3><pre tabIndex={0} data-testid="mcp-arguments">{JSON.stringify(lookup.arguments, null, 2)}</pre><h3>Tool result</h3><pre tabIndex={0} data-testid="mcp-result">{JSON.stringify(JSON.parse(lookup.result), null, 2)}</pre></details>
  </>;
}

function Switch({ label, icon: Icon, checked, disabled, onChange, title, detail }: {
  label: string; icon: LucideIcon; checked: boolean; disabled?: boolean;
  onChange: (checked: boolean) => void; title: string; detail?: string;
}) {
  return <label className={`game-switch ${checked ? 'is-on' : ''}`} title={title}>
    <Icon size={17} /><span>{label}{detail && <small id={`${label}-next`} data-testid={`${label.toLowerCase()}-next`}>{detail}</small>}</span>
    <input type="checkbox" aria-label={label} aria-describedby={detail ? `${label}-next` : undefined} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <i aria-hidden="true" />
  </label>;
}

export default function App() {
  const game = useGame();
  const [inspectedPrompt, setInspectedPrompt] = useState<Insight | null>(null);
  const [inspectInstructions, setInspectInstructions] = useState(false);
  const promptDialog = useRef<HTMLDialogElement | null>(null);
  const [editingSentence, setEditingSentence] = useState(false);
  const sentenceDialog = useRef<HTMLDialogElement | null>(null);
  const [editingAllowance, setEditingAllowance] = useState(false);
  const allowanceDialog = useRef<HTMLDialogElement | null>(null);
  const [inspectedLookup, setInspectedLookup] = useState<RequestRecord | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const mcpDialog = useRef<HTMLDialogElement | null>(null);
  const lastLookup = game.requestHistory.find(record => record.insight.mcpLookup);
  const lookupRecord = mcpOpen ? inspectedLookup ?? lastLookup : null;
  const latest = game.insight;
  const rates = game.room?.pricing.snapshot?.usdPerMillion;
  const compressionSaving = rates ? game.metrics.compressionSaved * rates.input / 1000000 : null;
  const cacheSaving = rates ? (game.metrics.cached * (rates.input - rates.cachedInput) - game.metrics.cacheWrites * (rates.cacheWrite - rates.input)) / 1000000 : null;
  const savings = compressionSaving !== null && cacheSaving !== null ? compressionSaving + cacheSaving : null;
  const compressionAdjustment = compressionSaving === null ? null : -compressionSaving;
  const cacheAdjustment = cacheSaving === null ? null : -cacheSaving;
  const beforeOptimizations = game.cost && savings !== null ? game.cost.total + savings : null;
  const cacheHits = game.metrics.cacheHits ?? 0;
  const cacheMisses = game.metrics.cacheMisses ?? 0;
  const unclassified = Math.max(0, game.metrics.requests - cacheHits - cacheMisses - (game.metrics.cacheBypassed ?? 0));
  const lastCost = latest && rates ? costForUsage(latest.usage, rates).total : null;
  const lastReduction = latest?.compression && latest.rawTokens > 0 ? Math.round(100 * latest.savedTokens / latest.rawTokens) : 0;
  const incomplete = game.busy || game.unmeteredRequests > 0;
  const remainingTokens = game.allowance && game.room?.allowance ? Math.min(reportedTokenBalance(game.allowance), reportedTokenBalance(game.room.allowance)) : null;
  const availableTokens = game.allowance && game.room?.allowance ? Math.min(game.allowance.remaining, game.room.allowance.remaining) : null;
  const pricing = game.room?.pricing.status;
  const status = !game.connected ? 'Connecting' : !game.joined ? 'Ready' : game.busy ? 'Luna is thinking' : game.autopilot ? game.inspectionPaused || game.autopilotStatus === 'blocked' ? 'Luna paused' : game.autopilotStatus === 'retrying' ? 'Luna retrying' : 'Luna playing' : game.view.status === 'over' ? 'Game over' : game.view.status === 'paused' ? 'Paused' : 'Manual play';
  const cacheResult = latest ? latest.usage.cached > 0 ? `${number(latest.usage.cached)} cached` : latest.usage.cacheWrites > 0 ? `${number(latest.usage.cacheWrites)} cache write` : latest.cacheEnabled ? 'Cache miss' : 'Cache off' : '';
  useEffect(() => { if (inspectedPrompt) promptDialog.current?.showModal(); }, [inspectedPrompt]);
  useEffect(() => { if (editingSentence) sentenceDialog.current?.showModal(); }, [editingSentence]);
  useEffect(() => { if (editingAllowance) allowanceDialog.current?.showModal(); }, [editingAllowance]);
  useEffect(() => { if (mcpOpen) mcpDialog.current?.showModal(); }, [mcpOpen]);

  function inspect(instructions = false) {
    const selected = latest ?? (instructions ? game.requestHistory[0]?.insight : null);
    if (!selected) return;
    if (!instructions) game.pauseForInspection();
    else if (!game.autopilot) game.act('pause');
    setInspectInstructions(instructions);
    setInspectedPrompt(selected);
  }

  function showRankings() {
    if (!game.autopilot) game.act('pause');
    document.querySelector<HTMLElement>('.leaderboard h2')?.focus({ preventScroll: true });
    document.querySelector('.room-panel')?.scrollIntoView({ block: 'start' });
  }

  function showMcpResults() {
    game.pauseForInspection();
    setInspectedLookup(lastLookup ?? null);
    setMcpOpen(true);
  }

  return <main className="room-layout" data-playing={game.joined}>
    <div className="tetris-app" data-playing={game.joined} data-autopilot={game.autopilot}>
    <header className="game-header">
      <h1><span className="tetris-mark" aria-hidden="true"><i /><i /><i /><i /></span>TETRIS</h1>
      <div className="header-actions">
        <span className={`connection ${game.connected ? 'connected' : ''}`} title={game.connected ? 'Connected' : 'Reconnecting'} aria-label={game.connected ? 'Connected' : 'Reconnecting'}>{game.connected ? <Wifi size={16} /> : <WifiOff size={16} />}</span>
        <button className="icon-button" aria-label="Show leaderboard" title="Leaderboard" onClick={showRankings}><Trophy size={19} /></button>
        <button className="icon-button" aria-label={game.autopilot ? 'Stop Luna' : game.view.status === 'paused' ? 'Resume game' : 'Pause game'} title={game.autopilot ? 'Stop Luna' : game.view.status === 'paused' ? 'Resume (P)' : 'Pause (P)'} disabled={!game.joined || game.view.status === 'over'} onClick={() => game.autopilot ? game.toggleAutopilot(false) : game.act(game.view.status === 'paused' ? 'resume' : 'pause')}>
          {game.view.status === 'paused' && !game.autopilot ? <Play size={20} /> : <Pause size={20} />}
        </button>
        <button className="icon-button" aria-label="New game" title="New game" disabled={!game.joined || game.busy || game.joining} onClick={() => void game.restart()}><RotateCcw size={19} /></button>
      </div>
      {(game.notice || game.autopilotStatus === 'blocked') && <div className="notice" role="alert"><span>{game.notice || 'Luna is paused.'}</span>{game.autopilotStatus === 'blocked' && <button className="icon-button" aria-label="Retry Luna" title="Retry Luna" disabled={!game.joined || !game.connected} onClick={game.retryAutopilot}><RotateCcw size={18} /></button>}<button className="icon-button" aria-label="Dismiss message" title="Dismiss" onClick={() => game.setNotice('')}><X size={18} /></button></div>}
    </header>

    <section className="cost-ticker" aria-label="AI cost ticker" aria-live="polite" aria-atomic="true">
      <div className="total-cost" title="Total reported AI spend across your games, at published USD rates. This is an estimate, not an invoice.">
        <span>{incomplete ? 'AI COST / PENDING USAGE' : 'AI COST / USD EST.'}</span>
        <strong data-testid="ai-cost" key={`cost-${game.metrics.requests}`}>{formatMoney(game.cost?.total ?? null)}</strong>
        <small>{pricing === 'live' ? 'Live rates' : pricing === 'stale' ? 'Last verified rates' : 'Rates unavailable'}</small>
      </div>
      <button className="token-balance" aria-label="Adjust AI allowance" title="Balance after reported usage. Pending holds are shown separately in allowance details; opening pauses play." disabled={!game.joined || !game.allowance || !game.connected || game.joining} onClick={() => { game.pauseForInspection(); game.setNotice(''); setEditingAllowance(true); }}>
        <span>AI TOKENS LEFT<SlidersHorizontal size={12} /></span><strong data-testid="ai-tokens-left" className={remainingTokens !== null && remainingTokens < MAX_REQUEST_TOKENS ? 'write-premium' : ''}>{remainingTokens === null ? '--' : number(remainingTokens)}</strong><small><b data-testid="ai-tokens">{number(game.metrics.input + game.metrics.output)}</b> used</small>
      </button>
      <div title={`Estimated compression saving: ${formatMoney(compressionSaving)}. Cache-read saving minus cache-write premium: ${formatMoney(cacheSaving)}.`}>
        <span>{savings !== null && savings < 0 ? 'EXTRA WRITE COST' : 'SAVED / EST.'}</span>
        <strong className={savings !== null && savings < 0 ? 'write-premium' : 'saved-cost'} data-testid="ai-savings">{formatMoney(savings !== null ? Math.abs(savings) : null)}</strong>
        <small>Compression + cache</small>
      </div>
      <dl className="cost-adjustments" aria-label="Session cost adjustments">
        <div><dt>Compression <small>est.</small></dt><dd className="saved-cost" data-testid="compression-adjustment">{signedMoney(compressionAdjustment)}</dd><span>{number(game.metrics.compressionSaved)} tokens removed</span></div>
        <div><dt>Cache <small>net</small></dt><dd className={cacheAdjustment !== null && cacheAdjustment > 0 ? 'write-premium' : 'saved-cost'} data-testid="cache-adjustment">{signedMoney(cacheAdjustment)}</dd><span data-testid="cache-totals" title="Cache-enabled requests only. A write without a read is a miss.">{number(cacheHits)} {cacheHits === 1 ? 'hit' : 'hits'} / {number(cacheMisses)} {cacheMisses === 1 ? 'miss' : 'misses'}</span></div>
      </dl>
      <p className="cost-baseline"><span>Before optimizations <small>est.</small> <b data-testid="unoptimized-cost">{formatMoney(beforeOptimizations)}</b></span><small data-testid="ai-requests">{number(game.metrics.requests)} requests</small>{unclassified > 0 && <span data-testid="cache-unclassified">{number(unclassified)} earlier {unclassified === 1 ? 'request' : 'requests'} unclassified</span>}</p>
      <CacheReceipt insight={latest} rates={rates} pending={game.busy} enabled={game.options.cache} hasHistory={game.metrics.requests > 0} canInspect={game.requestHistory.length > 0} onInspect={() => inspect(true)} />
    </section>

    <div className="luna-controls" aria-label="Luna controls">
      <Switch label="Ask Luna" icon={Bot} checked={game.autopilot} disabled={!game.autopilot && (!game.joined || !game.connected || game.view.status === 'over' || availableTokens === 0 || game.room?.requestsRemaining === 0)} onChange={game.toggleAutopilot} title="Let Luna play the game automatically. Uses paid AI requests. Switch off to stop." />
      <div className="luna-reasoning">
        <Switch label="Reasoning" icon={Brain} checked={Boolean(game.options.reasoning)} disabled={!game.autopilot} onChange={reasoning => game.setOptions(current => ({ ...current, reasoning }))} detail={game.options.reasoning ? 'Low effort next' : 'Off next'} title="Enable low reasoning effort for the next Luna request. Can take longer and use more billed output tokens. Changing this does not start Luna." />
        <dl className="reasoning-usage" aria-label="Reasoning token usage" aria-live="polite" aria-atomic="true" title="Provider-reported reasoning tokens. Already included in output tokens and AI cost; missing counts are not estimated.">
          <div><dt><span className="reasoning-label-detail">Reported </span>total</dt><dd data-testid="reasoning-tokens">{number(game.metrics.reasoning)}</dd></div>
          <div><dt>Last<span className="reasoning-label-detail">{latest ? ` reply / ${latest.reasoningEnabled ? 'low' : 'off'}` : ' reply'}</span></dt><dd data-testid="last-reasoning-tokens">{game.busy ? 'Pending' : latest ? latest.usage.reasoning === null ? 'Not reported' : number(latest.usage.reasoning) : '--'}</dd></div>
        </dl>
      </div>
      <div className="luna-mcp"><Switch label="MCP" icon={Plug} checked={Boolean(game.options.mcp)} disabled={!game.autopilot} onChange={mcp => game.setOptions(current => ({ ...current, mcp }))} detail={game.options.mcp ? '2-piece next' : 'Off next'} title="Simulate the next two placements through the real MCP tool before Luna chooses. Adds analysis input tokens and latency. Does not start Luna." /><button className="mcp-results-button mcp-results-desktop" aria-label="Inspect MCP lookup" title="MCP analysis and added input cost; pauses play" onClick={showMcpResults}><ScanSearch size={16} />Results</button></div>
      <Switch label="Compression" icon={FileJson2} checked={game.options.compression} disabled={!game.autopilot} onChange={compression => game.setOptions(current => ({ ...current, compression }))} detail={game.options.compression ? 'Packed rows next' : 'Cell JSON next'} title="Send the same board in fewer tokens. Applies to the next request, not past costs." />
      <Switch label="Cache" icon={Layers3} checked={game.options.cache} disabled={!game.autopilot} onChange={cache => game.setOptions(current => ({ ...current, cache }))} detail={game.options.cache ? 'Reuse rules next' : 'Full input next'} title="Reuse fixed instructions at the cache-read rate. Writes can cost extra; a hit is not guaranteed. Applies to the next request, not past costs." />
    </div>

    <div className="game-status" role="status">
      <span className={game.autopilot ? 'luna-active' : ''} data-testid="game-status"><i className={game.busy ? 'thinking' : ''} />{status}</span>
      <span className="request-status" data-testid="request-status" title={game.requestOptions ? 'Changes to the switches apply to the next request.' : undefined}>
        {game.requestOptions ? `In flight: ${game.requestOptions.compression ? 'Packed' : 'Verbose'} / cache ${game.requestOptions.cache ? 'on' : 'off'} / reasoning ${game.requestOptions.reasoning ? 'low' : 'off'} / MCP ${game.requestOptions.mcp ? 'on' : 'off'}` : latest ? `${latest.compression ? 'Packed' : 'Verbose'} / ${cacheResult}${latest.mcpLookup ? ' / MCP used' : ''}` : ''}
      </span>
      <div className="prompt-summary">
        <div><span data-testid="compression-detail">{latest ? latest.compression ? `Last board: ${number(latest.rawTokens)} -> ${number(latest.packedTokens)} tokens (-${lastReduction}%)` : `Last board: ${number(latest.rawTokens)} tokens, uncompressed` : game.metrics.requests ? 'Prompt available after next reply' : 'No prompt sent yet'}</span><small data-testid="last-request-cost">{latest ? `Last request ${signedMoney(lastCost)} / USD est.` : 'No charge for changing settings'}</small></div>
        <button className="mcp-results-button mcp-results-mobile" aria-label="Inspect MCP lookup" title="MCP analysis and added input cost; pauses play" onClick={showMcpResults}><ScanSearch size={16} /><span>MCP<br />Results</span></button>
        <button className="icon-button" aria-label="Inspect last prompt" title="Compare compression before and after; pauses play" disabled={!latest} onClick={() => inspect()}><Columns2 size={18} /></button>
      </div>
    </div>

    <section className="game-stage" aria-label="Tetris game">
      <div className="scoreboard">
        <div className="main-score"><span>SCORE</span><strong data-testid="game-score">{number(game.view.score)}</strong></div>
        <div><span>LINES</span><strong data-testid="game-lines">{number(game.view.lines)}</strong></div>
        <div><span>LEVEL</span><strong data-testid="game-level">{number(game.view.level)}</strong></div>
      </div>
      <div className="play-well">
        <aside className="piece-rail"><span>HOLD</span><button className="hold-slot" title="Hold (C)" aria-label="Hold current piece" disabled={!game.joined || game.autopilot || !game.view.canHold || game.view.status !== 'playing'} onClick={() => game.act('hold')}><PiecePreview piece={game.view.hold} token={game.view.holdToken} /></button></aside>
        <div className="board-column">
          <GameBoard view={game.view} joined={game.joined} suggestion={latest}>
            {!game.joined ? <div className="board-overlay"><strong>{game.joining ? 'Connecting...' : 'Ready'}</strong></div>
              : game.view.status === 'over' ? <div className="board-overlay gameover-overlay"><h2>Game over</h2><strong>{number(game.view.score)}</strong><button className="primary-button" disabled={game.busy} onClick={() => void game.restart()}><RotateCcw size={17} />Play again</button></div>
              : game.view.status === 'paused' && !game.autopilot ? <div className="board-overlay pause-overlay"><button className="resume-button" aria-label="Resume" title="Resume (P)" onClick={() => game.act('resume')}><Play size={30} /></button><span>PAUSED</span></div> : null}
          </GameBoard>
          <GameControls act={game.act} disabled={!game.joined || game.autopilot || !game.connected || game.view.status === 'over'} paused={game.view.status === 'paused'} />
        </div>
        <aside className="piece-rail next-rail"><span>NEXT</span>{game.view.next.slice(0, 3).map((piece, index) => <div className="next-piece" key={index}><PiecePreview piece={piece} token={game.view.nextTokens[index]} /></div>)}</aside>
      </div>
    </section>
    </div>
    <RoomPanel game={game} onEdit={() => { game.pauseForInspection(); game.setNotice(''); setEditingSentence(true); }} onReturn={() => { window.scrollTo({ top: 0 }); document.querySelector<HTMLButtonElement>('.game-header button[aria-label="Resume game"]')?.focus({ preventScroll: true }); }} />
    <dialog className="prompt-dialog allowance-dialog" ref={allowanceDialog} aria-labelledby="allowance-title" onClose={() => { setEditingAllowance(false); game.resumeAfterInspection(); }}>
      <header><h2 id="allowance-title">AI token allowance</h2><button className="icon-button" aria-label="Close allowance" title="Close allowance" onClick={() => allowanceDialog.current?.close()}><X size={19} /></button></header>
      {editingAllowance && game.notice && <p className="field-error" role="alert">{game.notice}</p>}
      {editingAllowance && game.allowance && <AllowanceEditor allowance={game.allowance} room={game.room} disabled={!game.connected} pending={game.joining} onSave={async limit => { if (await game.adjustAllowance(limit)) allowanceDialog.current?.close(); }} />}
    </dialog>
    <dialog className="prompt-dialog mcp-dialog" ref={mcpDialog} aria-labelledby="mcp-title" onClose={() => { setMcpOpen(false); setInspectedLookup(null); game.resumeAfterInspection(); }}>
      <header><h2 id="mcp-title">MCP lookup</h2><button className="icon-button" aria-label="Close MCP lookup" title="Close MCP lookup" onClick={() => mcpDialog.current?.close()}><X size={19} /></button></header>
      {lookupRecord?.insight.mcpLookup ? <McpResults record={lookupRecord} rates={rates} /> : <p data-testid="mcp-empty" role="status">{game.requestOptions?.mcp ? 'MCP-enabled request in progress. Result pending.' : 'No MCP results received in this tab.'}</p>}
    </dialog>
    <dialog className="prompt-dialog sentence-dialog" ref={sentenceDialog} aria-labelledby="sentence-title" onClose={() => { setEditingSentence(false); game.resumeAfterInspection(); }}>
      <header><h2 id="sentence-title">New sentence</h2><button className="icon-button" aria-label="Close sentence editor" title="Close sentence editor" onClick={() => sentenceDialog.current?.close()}><X size={19} /></button></header>
      {editingSentence && game.notice && <p className="field-error" role="alert">{game.notice}</p>}
      {editingSentence && <GameSetup editing initialText={game.player?.tokenText || undefined} initialTokenLimit={game.allowance?.limit} disabled={!game.connected} pending={game.joining} onSubmit={async setup => { if (await game.restart(setup.text, setup.tokenLimit)) sentenceDialog.current?.close(); }} />}
    </dialog>
    <dialog className={`prompt-dialog ${inspectInstructions ? 'activity-dialog' : 'compression-dialog'}`} ref={promptDialog} aria-labelledby="prompt-title" onClose={() => { setInspectedPrompt(null); if (!inspectInstructions) game.resumeAfterInspection(); }}>
      <header><h2 id="prompt-title">{inspectInstructions ? 'Cache activity' : 'Compression before / after'}</h2><div className="inspector-actions">{inspectInstructions && game.autopilot && <button className="icon-button" aria-label="Stop Luna in inspector" title="Stop Luna" onClick={() => game.toggleAutopilot(false)}><Pause size={19} /></button>}<button className="icon-button" aria-label="Close prompt" title="Close prompt" onClick={() => promptDialog.current?.close()}><X size={19} /></button></div></header>
      {inspectedPrompt && (inspectInstructions ? <CacheActivity records={game.requestHistory} selected={inspectedPrompt} rates={rates} pending={game.busy} unknown={game.unmeteredRequests} onSelect={setInspectedPrompt} /> : <CompressionComparison insight={inspectedPrompt} />)}
    </dialog>
  </main>;
}