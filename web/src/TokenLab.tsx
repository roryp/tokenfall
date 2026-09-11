import { useDeferredValue, useEffect, useId, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, BookOpen, Bot, Braces, Check, ChevronRight, Clipboard, FileJson2, Layers3, ScanText, Sparkles, Timer, Zap } from 'lucide-react';
import type { GameController } from './useGame.ts';
import { PiecePreview } from './GameBoard.tsx';
import { formatMoney } from './format.ts';
import { tokenShape } from '../../shared/game.ts';
import { costForUsage, tokenCreditsUsed } from '../../shared/protocol.ts';
import type { Insight, TokenChip, TokenPricing } from '../../shared/protocol.ts';

const format = (value: number) => value.toLocaleString();
const formatRate = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

export function LiveRates({ pricing }: { pricing: TokenPricing | undefined }) {
  const snapshot = pricing?.snapshot;
  return <section className="live-rates" aria-label="Live Azure token rates">
    <header><strong>AZURE RETAIL RATES</strong><span className={`rate-status rate-${pricing?.status ?? 'loading'}`}>{pricing?.status === 'live' ? 'LIVE' : pricing?.status === 'stale' ? 'LAST VERIFIED' : pricing?.status === 'unavailable' ? 'UNAVAILABLE' : 'LOADING'}</span></header>
    {snapshot ? <><div className="rate-grid"><div><span>Input</span><strong data-testid="rate-input">{formatRate(snapshot.usdPerMillion.input)}</strong></div><div><span>Cache read</span><strong data-testid="rate-cache-read">{formatRate(snapshot.usdPerMillion.cachedInput)}</strong></div><div><span>Cache write</span><strong data-testid="rate-cache-write">{formatRate(snapshot.usdPerMillion.cacheWrite)}</strong></div><div><span>Output</span><strong data-testid="rate-output">{formatRate(snapshot.usdPerMillion.output)}</strong></div></div><p className="rate-scope">USD per 1 million tokens / Global Standard / short context / {snapshot.region}</p><div className="rate-source"><a href={snapshot.sourceUrl} target="_blank" rel="noreferrer">Azure price source<ArrowUpRight size={12} /></a><time dateTime={snapshot.checkedAt}>Checked {new Date(snapshot.checkedAt).toLocaleString()}</time></div>{pricing?.status === 'stale' && <p className="rate-warning" role="status">Live refresh failed. Costs use the last verified rates above.</p>}<p className="rate-caveat">Refreshed hourly. All session usage is valued at the shown rates. Retail estimate only; taxes and negotiated discounts are excluded.</p></> : <p className="rate-warning">{pricing?.status === 'unavailable' ? 'Live prices could not be verified.' : 'Checking Azure prices.'} Cost scores are pending; Tetris remains available. No fallback prices are invented.</p>}
  </section>;
}

function RequestCost({ insight, pricing }: { insight: Insight; pricing: TokenPricing | undefined }) {
  const rates = pricing?.snapshot?.usdPerMillion;
  if (!rates) return <p className="rate-warning">Request cost is unavailable until prices are verified.</p>;
  const cost = costForUsage(insight.usage, rates);
  const lines = [
    ['input', 'Ordinary input', insight.usage.input - insight.usage.cached - insight.usage.cacheWrites],
    ['cachedInput', 'Cache read', insight.usage.cached],
    ['cacheWrite', 'Cache write', insight.usage.cacheWrites],
    ['output', 'Output', insight.usage.output],
  ] as const;
  return <div className="cost-receipt"><div><span>EST. REQUEST COST</span><strong data-testid="request-cost">{formatMoney(cost.total)}</strong></div><dl>{lines.map(([key, label, count]) => <div key={key}><dt>{label}<small>{format(count)} tokens x {formatRate(rates[key])} / 1M</small></dt><dd data-testid={`cost-${key}`}>{formatMoney(cost[key])}</dd></div>)}</dl><p>Ordinary input excludes cache reads and writes. Each token is priced once.</p></div>;
}

export function TokenChips({ tokens }: { tokens: TokenChip[] }) {
  return <div className="token-chips">{tokens.map((token, index) => <span className={`token-chip token-tone-${index % 5}`} key={`${index}-${token.id}`} title={`Token ID ${token.id}`}><span>{token.text.replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}</span><small>{token.id}</small></span>)}</div>;
}

function TokenStream({ tokens, currentIndex }: { tokens: TokenChip[]; currentIndex?: number }) {
  return <ol className="token-piece-stream" aria-label="Token piece sequence">{tokens.map((token, index) => <li key={`${index}-${token.id}`} className={currentIndex === index ? 'current-token' : ''} aria-current={currentIndex === index ? 'step' : undefined} data-token-id={token.id} data-token-text={token.text}><span className="stream-position">{index + 1}</span><PiecePreview piece={tokenShape(token.id)} token={token} /><small>ID {token.id}</small></li>)}</ol>;
}

export function TokenSetup({ controller, onStart }: { controller: GameController; onStart: () => void }) {
  const textId = useId();
  const deferredText = useDeferredValue(controller.tokenText);
  const [preview, setPreview] = useState<{ source: string; count: number; tokens: TokenChip[] } | null>(null);
  const [error, setError] = useState('');
  const current = preview?.source === controller.tokenText;
  const valid = current && preview.count > 0 && preview.count <= 256 && !error;
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void fetch('/api/tokenize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: deferredText }), signal: abort.signal })
        .then(async response => { if (!response.ok) throw new Error('Token preview is unavailable. Try again in a moment.'); return response.json(); })
        .then(data => { if (!abort.signal.aborted) { setPreview({ ...data, source: deferredText }); setError(''); } })
        .catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    }, 200);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [deferredText]);
  return <section className="token-setup" aria-labelledby="setup-title">
    <div className="setup-heading"><span className="eyebrow">BEFORE THE FIRST PIECE</span><h2 id="setup-title">Make your token blocks.</h2><p>Your text becomes the falling pieces, in the exact token order below.</p></div>
    <form onSubmit={event => { event.preventDefault(); if (valid) { onStart(); controller.startTokenRun(); } }}>
      <label htmlFor={textId}>Text to turn into blocks</label><textarea id={textId} value={controller.tokenText} maxLength={500} onChange={event => controller.setTokenText(event.target.value)} rows={3} spellCheck={false} required aria-describedby={`${textId}-explanation`} />
      <p id={`${textId}-explanation`} className="setup-explanation">A token can be a whole word, a word fragment, punctuation, or whitespace. One token becomes one labeled piece. Its numeric ID chooses the shape; the shape is a game visualization, not part of the tokenizer.</p>
      <div className="setup-count"><span>o200k_base tokenizer</span><strong data-testid="setup-token-count" role="status">{current ? `${preview.count} tokens = ${preview.count} pieces` : 'Building your pieces...'}</strong></div>
      {error ? <p className="inline-error" role="alert">{error}</p> : current && preview.count > 256 ? <p className="inline-error" role="alert">This text makes more than 256 tokens. Shorten it before starting.</p> : current && preview.count === 0 ? <p className="setup-explanation">Enter text to create a token sequence.</p> : <TokenStream tokens={current ? preview.tokens : []} />}
      <p className="setup-explanation">The sequence repeats after its last token. {'\u2423'} marks a space; [byte] means part of a multi-byte character. Token setup makes no model calls.</p>
      <div className="setup-start"><div><label htmlFor={`${textId}-name`}>Player name</label><input id={`${textId}-name`} value={controller.name} onChange={event => controller.setName(event.target.value)} required minLength={2} maxLength={16} autoComplete="nickname" readOnly={controller.joined} placeholder="Player name" /></div><button className="primary-button" type="submit" disabled={!valid || !controller.connected || controller.joining || controller.busy}>{controller.joining ? 'Starting...' : controller.joined ? 'Start new token run' : 'Start game'}<ArrowRight size={18} /></button></div>
      {controller.joined && <div className="setup-return"><span>Your best score, spend, and remaining allowance stay.</span>{controller.view.tokens.length > 0 && <button className="text-action" type="button" onClick={controller.cancelTokenSetup}>Keep current run</button>}</div>}
    </form>
  </section>;
}

export function TokenPowerups({ controller }: { controller: GameController }) {
  const descriptionId = useId();
  const budget = controller.room?.playerTokenBudget ?? 16000;
  const remaining = Math.max(0, budget - tokenCreditsUsed(controller.metrics));
  const cacheEarned = controller.metrics.cached > 0;
  const compressionEarned = controller.metrics.compressionSaved > 0;
  const rates = controller.room?.pricing?.snapshot?.usdPerMillion;
  const readDiscount = rates && rates.input > 0 ? Math.round(100 * (1 - rates.cachedInput / rates.input)) : null;
  return <div className="powerup-console">
    <div className="challenge-bank"><div><span>FRESH TOKENS LEFT</span><strong data-testid="credits-remaining">{format(remaining)}<small> / {format(budget)}</small></strong></div><div className="model-cost"><span>EST. SESSION AI COST</span><strong data-testid="session-cost">{formatMoney(controller.cost?.total ?? null)}</strong></div></div>
    <div className={`budget-track ${remaining < budget * 0.3 ? 'budget-low' : ''}`} role="progressbar" aria-label="Remaining fresh-token allowance" aria-valuenow={remaining} aria-valuemin={0} aria-valuemax={budget}><i style={{ width: `${100 * remaining / budget}%` }} /></div>
    <p className="bank-rule">Allowance = fresh input + output. Cached reads do not use this allowance, but still cost money. New games do not reset it.</p>
    <div className={`pilot-console ${controller.autopilot ? 'pilot-enabled' : ''}`}><label className={`power-switch ${controller.autopilot ? 'enabled' : ''}`}><Bot size={23} /><span><strong>Luna autopilot</strong><small>{controller.autopilot ? 'AI CONTROL' : 'MANUAL CONTROL'}</small></span><input type="checkbox" aria-label="Luna autopilot" checked={controller.autopilot} disabled={!controller.joined || !controller.connected || controller.editingTokens || controller.view.status === 'over' || (!controller.autopilot && remaining === 0)} onChange={event => controller.toggleAutopilot(event.target.checked)} /><i className="switch-track" /></label><p className="pilot-status" role="status" data-testid="pilot-status">{controller.pilotStatus}</p><p className="pilot-description">Luna chooses and plays every move for you. The board waits while it thinks. Minimum {(controller.room?.autopilotCooldownMs ?? 1000) / 1000}s between requests; model latency still applies. Stops at game over, errors, or the token limit.</p></div>
    {controller.unmeteredRequests > 0 && <p className="rate-warning" role="status">{controller.unmeteredRequests} request(s) without usage. Cost is incomplete; ranking is pending.</p>}
    <div className="power-switches">
      <div className={`powerup ${compressionEarned ? 'earned' : ''}`}><label className={`power-switch ${controller.options.compression ? 'enabled compress' : ''}`}><FileJson2 size={19} /><span><strong>Compress</strong><small>{controller.options.compression ? 'PACKED / ON' : 'VERBOSE / OFF'}</small></span><input type="checkbox" aria-label="Compress prompts" aria-describedby={`${descriptionId}-compression`} checked={controller.options.compression} onChange={event => controller.setOptions(current => ({ ...current, compression: event.target.checked }))} /><i className="switch-track" /></label><div className="powerup-reward"><strong>Less input cost</strong><span>{compressionEarned ? <><Check size={12} />Used</> : 'Not used'}</span></div><p className="powerup-description" id={`${descriptionId}-compression`}>Same board, less text. Fewer input tokens lower the dollar cost of an AI move.</p></div>
      <div className={`powerup ${cacheEarned ? 'earned' : ''}`}><label className={`power-switch ${controller.options.cache ? 'enabled cache' : ''}`}><Layers3 size={19} /><span><strong>Cache prefix</strong><small>{controller.options.cache ? 'REUSE / ON' : 'REUSE / OFF'}</small></span><input type="checkbox" aria-label="Cache prefix" aria-describedby={`${descriptionId}-cache`} checked={controller.options.cache} onChange={event => controller.setOptions(current => ({ ...current, cache: event.target.checked }))} /><i className="switch-track" /></label><div className="powerup-reward"><strong>{readDiscount !== null && readDiscount > 0 ? `${readDiscount}% cheaper reads` : 'Discounted reads'}</strong><span>{cacheEarned ? <><Check size={12} />Hit</> : controller.options.cache ? 'Awaiting hit' : 'Off'}</span></div><p className="powerup-description" id={`${descriptionId}-cache`}>Reuse Luna's fixed rules, not its answer. Hits use the cache-read price; writes have their own charge. A write is not a hit.</p></div>
    </div>
    <p className="request-option-note" data-testid="inflight-options">{controller.requestOptions ? `In flight: ${controller.requestOptions.compression ? 'packed' : 'verbose'}, cache ${controller.requestOptions.cache ? 'on' : 'off'}. Changes apply to the next request.` : 'Cache and compression switches apply to the next AI request.'}</p>
    <p className="boost-rule"><strong>Score = Tetris points / AI cost in cents.</strong> More points at lower cost wins. No flat bonuses; a switch alone earns nothing.</p>
    <div className="powerup-savings"><span><FileJson2 size={12} />{format(controller.metrics.compressionSaved)} tokens saved <small>est.</small></span><span><Layers3 size={12} />{format(controller.metrics.cached)} cached tokens</span></div>
  </div>;
}

export function LunaControls({ controller, compact = false }: { controller: GameController; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const cooldown = Math.max(0, Math.ceil((controller.cooldownUntil - now) / 1000));
  const remaining = Math.max(0, (controller.room?.playerTokenBudget ?? 16000) - tokenCreditsUsed(controller.metrics));
  const insight = controller.insights[0];
  const canApply = !controller.autopilot && insight?.status === 'ready' && insight.pieceId === controller.view.pieceId && controller.view.status !== 'over';
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  return <div className="luna-actions"><button className="luna-button" onClick={() => void controller.assist()} disabled={!controller.joined || !controller.connected || controller.autopilot || controller.busy || cooldown > 0 || controller.view.status === 'over' || remaining === 0}><Sparkles size={20} /><span>{controller.autopilot ? 'Autopilot running' : controller.busy ? 'Luna is choosing...' : cooldown > 0 ? `Ready in ${cooldown}s` : compact ? 'Ask Luna' : 'Ask Luna for a move'}</span>{controller.busy ? <i className="loading-spinner" /> : <ChevronRight size={18} />}</button>{canApply && <button className="secondary-button" disabled={!controller.connected || controller.busy} onClick={controller.applySuggestion}><ArrowDown size={16} />Play move</button>}<p className="luna-rule">AI requests cost money. Manual hints have an {(controller.room?.aiCooldownMs ?? 8000) / 1000}s cooldown; autopilot has a {(controller.room?.autopilotCooldownMs ?? 1000) / 1000}s minimum. Manual moves are free.</p></div>;
}

export function GameRules({ budget, pricing }: { budget: number; pricing: TokenPricing | undefined }) {
  return <section className="game-rules" id="game-rules" aria-labelledby="game-rules-title">
    <header className="rules-heading"><BookOpen size={22} /><div><h2 id="game-rules-title">Game rules</h2><p>Goal: earn the most Tetris points per cent of AI cost. Clear lines, choose useful AI moves, and avoid wasting tokens.</p></div></header>
    <LiveRates pricing={pricing} />
    <div className="rules-grid">
      <section><h3>Score &amp; winning</h3><p>The highest <strong>points per cent</strong> wins. The leaderboard divides your best single-run Tetris score by the cost of all your session's AI requests, including earlier runs.</p><p className="rules-equation">Best Tetris points / (AI cost in USD x 100)</p><p className="rules-example">1,000 points at $0.002 = 5,000 points per cent. The same points at $0.001 = 10,000 points per cent.</p><p>Compression and caching affect score through their actual priced usage, not fixed bonuses. More AI requests increase spend; they only improve efficiency if the extra points justify their cost.</p><p>Zero-spend runs remain unranked in cost efficiency. At least one metered AI request is needed. Missing prices or missing request usage also pause ranking; zero cost is never assumed.</p></section>
      <section><h3>Compression &amp; caching</h3><dl><div><dt>Compress</dt><dd>Packs the same board into fewer input tokens without losing information. This lowers input cost and leaves more token allowance.</dd></div><div><dt>Cache prefix</dt><dd>Reuses computation for Luna's fixed game rules, not a previous answer. The changing board still needs a new answer.</dd></div><div><dt>Cache hit</dt><dd>Provider-confirmed reused input is charged at the cache-read rate, not the full input rate. It is discounted, not free.</dd></div><div><dt>Cache write / miss</dt><dd>A write prepares reusable data and is charged at the cache-write rate instead of ordinary input. It can cost more than uncached input. A miss has no reused input, and a later hit is not guaranteed.</dd></div></dl></section>
      <section><h3>Cost &amp; token allowance</h3><p>Each setup token is visualized as one four-cell piece. Those four cells are not four model tokens. Model-request cost comes from the encoded rules, board data, and answer, which are separate from the setup token count.</p><p>The receipt prices ordinary input, cache reads, cache writes, and output separately: tokens x rate / 1,000,000. Costs use actual provider usage and current published USD rates, not an Azure invoice. Taxes and negotiated discounts are excluded.</p><p>The separate {format(budget)} fresh-token allowance counts model input + output - cache reads. Each request reserves for a miss plus headroom, so some remaining allowance may be too little. Cached reads still cost money.</p><p>Restarting or changing token text preserves spend, best score, and remaining allowance. Manual Tetris and text setup remain free.</p></section>
      <section><h3>Your token pieces</h3><p>Before Start, the o200k_base tokenizer splits your text. Tokens can be whole words, fragments, punctuation, or spaces. The same token ID always chooses the same game shape. That mapping is a teaching visualization, not a property of the model.</p><p>Your token order repeats after the final token. Hold stores both shape and label; surviving labels move with their cells when rows clear. Next shows your upcoming tokens, and the ghost marks the landing. Different texts make different sequences, so this is not a standardized tournament.</p><p>A complete row of 10 cells clears. Drops, clears, combos, and special clears earn Tetris points. Higher levels fall faster; a blocked spawn ends the run. Pause keeps the labeled board visible.</p></section>
      <section><h3>Luna autopilot &amp; hints</h3><dl><div><dt>Autopilot</dt><dd>Requests and plays each legal move automatically, under your player name. The board waits for the model. It tries to improve your ranking, but a win is not guaranteed.</dd></div><div><dt>Speed &amp; limits</dt><dd>Autopilot has a one-second minimum between requests, plus model latency. Manual hints keep an eight-second cooldown. Both share the token budget, 40-attempt player limit, and room limits.</dd></div><div><dt>Live switches</dt><dd>Compression and cache settings apply to the next request, even while AI is running. The current request keeps its original settings. Request comparison shows actual modes, usage, cost, and time.</dd></div><div><dt>Stop</dt><dd>Stops automatic moves immediately; an in-flight request can still be charged. Autopilot also stops on errors, budget exhaustion, game over, hidden tabs, and disconnection. It does not restart itself.</dd></div><div><dt>Ask Luna / Play move</dt><dd>Manual mode buys a hint and lets you choose when to apply it. Expired and rejected responses with usage still count toward cost. The lab can stay open while autopilot runs.</dd></div></dl></section>
      <section><h3>The token receipt</h3><dl><div><dt>Input / output</dt><dd>Input is text sent to Luna, including the rules and board shapes. Output is its suggestion. Your custom setup text is not sent to the model.</dd></div><div><dt>Price breakdown</dt><dd>Ordinary input excludes cache reads and writes. The receipt prices each category once and sums them, without rounding before scoring.</dd></div><div><dt>Raw / packed</dt><dd>The original board data versus its compressed form. This request-payload saving is separate from your token-piece sequence.</dd></div><div><dt>Reasoning off</dt><dd>Accepted moves must report zero reasoning tokens.</dd></div><div><dt>Token stream</dt><dd>Shows the actual token IDs and labeled pieces you prepared. Edit text before starting the next run, not during the current one. Whitespace markers make otherwise invisible tokens visible.</dd></div></dl></section>
    </div>
  </section>;
}

export function TokenLab({ controller }: { controller: GameController }) {
  const [tab, setTab] = useState<'receipt' | 'stream'>('receipt');
  const [copied, setCopied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const insight = controller.insights[0];
  const canApply = !controller.autopilot && insight?.status === 'ready' && insight.pieceId === controller.view.pieceId && controller.view.status !== 'over';
  const rates = controller.room?.pricing?.snapshot?.usdPerMillion;

  return <section className="token-lab" aria-labelledby="token-title">
    <header className="section-heading"><span className="section-number">02</span><h2 id="token-title">Token lab</h2><span className="tiny-label">LIVE INFERENCE</span></header>
    <div className="lab-powers"><TokenPowerups controller={controller} /></div>
    <LunaControls controller={controller} />
    <div className="model-line"><i className="status-dot" /><span>GPT-5.6 LUNA</span><span>REASONING OFF</span></div>
    {controller.insights.length > 0 && <section className="request-history" aria-label="AI request comparison"><h3>Request comparison</h3><table><thead><tr><th scope="col">Mode</th><th scope="col">Input / read</th><th scope="col">USD est.</th><th scope="col">Time</th></tr></thead><tbody>{controller.insights.slice(0, 5).map(entry => <tr key={entry.id} data-cache={entry.cacheEnabled} data-compression={entry.compression}><td>{entry.compression ? 'Packed' : 'Verbose'}<small>Cache {entry.cacheEnabled ? 'on' : 'off'}</small></td><td>{format(entry.usage.input)}<small>{format(entry.usage.cached)} read</small></td><td>{formatMoney(rates ? costForUsage(entry.usage, rates).total : null)}</td><td>{(entry.latencyMs / 1000).toFixed(1)}s</td></tr>)}</tbody></table></section>}
    <LiveRates pricing={controller.room?.pricing} />
    <div className="lab-tabs" role="tablist" aria-label="Token lab views"><button role="tab" aria-selected={tab === 'receipt'} onClick={() => setTab('receipt')}><Zap size={15} />Live receipt</button><button role="tab" aria-selected={tab === 'stream'} onClick={() => setTab('stream')}><ScanText size={15} />Token stream</button></div>
    {tab === 'receipt' ? <div className="receipt-content" role="tabpanel">
      {insight ? <>
        <div className="receipt-top"><span className="receipt-label">REQUEST {String(controller.metrics.requests).padStart(2, '0')}</span><span><Timer size={12} />{(insight.latencyMs / 1000).toFixed(2)}s</span></div>
        <div className="receipt-modes"><span>PREFIX CACHE {insight.cacheEnabled ? 'ON' : 'OFF'}</span><span>{insight.compression ? 'PACKED' : 'VERBOSE'} PAYLOAD</span></div>
        <RequestCost insight={insight} pricing={controller.room?.pricing} />
        <div className={`cache-status ${insight.usage.cached > 0 ? 'cache-hit' : ''}`} role="status"><Layers3 size={16} /><strong>{insight.usage.cached > 0 ? 'Cache hit confirmed' : !insight.cacheEnabled ? 'Cache off' : insight.usage.cacheWrites > 0 ? 'Cache written / awaiting hit' : 'Cache miss / awaiting hit'}</strong><span>{insight.usage.cached > 0 ? 'Reused tokens billed at the cache-read rate' : insight.usage.cacheWrites > 0 ? 'Cache-write charge applies; no read discount yet' : 'No cache-read discount'}</span></div>
        <div className="usage-grid">
          <div><span>Input tokens</span><strong data-testid="input-tokens">{format(insight.usage.input)}</strong></div>
          <div><span>Output tokens</span><strong data-testid="output-tokens">{format(insight.usage.output)}</strong></div>
          <div className="cache-value"><span>Cache read</span><strong data-testid="cached-tokens">{format(insight.usage.cached)}</strong></div>
          <div><span>Cache write</span><strong>{format(insight.usage.cacheWrites)}</strong></div>
        </div>
        <div className="reasoning-row"><span>Azure-reported reasoning</span><strong data-testid="reasoning-tokens">{insight.usage.reasoning === null ? 'Unknown' : format(insight.usage.reasoning)}</strong></div>
        <div className="compression-line"><FileJson2 size={17} /><div><span>Payload tokens <small>estimated</small></span><strong>{format(insight.rawTokens)}<ArrowRight size={14} />{format(insight.packedTokens)}</strong></div><b>{insight.compression ? `${Math.round(100 * (1 - insight.packedTokens / insight.rawTokens))}% less` : 'Not applied'}</b></div>
        <div className={`suggestion ${canApply ? 'ready' : ''}`}><span className="eyebrow">{canApply ? 'LUNA PICK' : insight.status === 'invalid' ? 'MOVE REJECTED' : 'PREVIOUS PIECE'}</span><p>{insight.tip}</p><button className="text-action" onClick={controller.applySuggestion} disabled={!canApply}><ArrowDown size={16} />Play this move<ArrowRight size={14} /></button></div>
        <div className="output-heading"><span>GENERATED TOKENS</span><Braces size={14} /></div>
        <TokenChips tokens={insight.outputChips} />
        <button className="details-button" aria-expanded={showPrompt} onClick={() => setShowPrompt(current => !current)}><FileJson2 size={14} />{showPrompt ? 'Hide request data' : 'Inspect request data'}<ChevronRight size={14} /></button>
        {showPrompt && <div className="prompt-view"><div><span>{insight.compression ? 'PACKED' : 'VERBOSE'} BOARD</span><button className="icon-button" aria-label="Copy request JSON" title="Copy request JSON" onClick={() => { void navigator.clipboard.writeText(insight.prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => controller.setNotice('Clipboard access is unavailable.')); }}>{copied ? <Check size={15} /> : <Clipboard size={15} />}</button></div><pre>{insight.prompt}</pre></div>}
      </> : <div className="receipt-empty"><div className="token-journey"><span><Braces size={22} /></span><i /><span><Layers3 size={22} /></span><i /><span><Sparkles size={22} /></span></div><strong>No model requests yet</strong><span>Input <b>0</b> / Cached <b>0</b> / Output <b>0</b></span></div>}
      <dl className="token-facts"><div><dt>Cost score</dt><dd>Tetris points / model cost in cents</dd></div><div><dt>Provider usage</dt><dd>All input + output, including cache reads</dd></div><div><dt>Retail estimate</dt><dd>Actual usage x published rates, not an invoice</dd></div></dl>
    </div> : <div className="splitter-content" role="tabpanel">
      <div className="splitter-meta"><span>YOUR FALLING PIECES</span><strong>{controller.view.tokens.length} tokens</strong></div>
      <TokenStream tokens={controller.view.tokens} currentIndex={controller.view.activeTokenIndex % controller.view.tokens.length} />
      <p className="setup-explanation">These are the real tokens from your setup, in order. The highlighted token is the current piece. Your custom text is not included in Luna's model prompt.</p>
      <button className="text-action" disabled={controller.busy} onClick={controller.editTokens}><ScanText size={16} />Edit text for next run<ArrowRight size={14} /></button>
    </div>}
    <div className="lab-footer"><span><Check size={13} />Actual Azure usage</span><span>No simulated cache hits</span></div>
  </section>;
}