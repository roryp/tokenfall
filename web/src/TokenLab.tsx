import { useDeferredValue, useEffect, useState } from 'react';
import { ArrowDown, ArrowRight, Braces, Check, ChevronRight, Clipboard, FileJson2, Layers3, ScanText, Sparkles, Timer, Zap } from 'lucide-react';
import type { GameController } from './useGame.ts';
import type { TokenChip } from '../../shared/protocol.ts';

const format = (value: number) => value.toLocaleString();
export function TokenChips({ tokens }: { tokens: TokenChip[] }) {
  return <div className="token-chips">{tokens.map((token, index) => <span className={`token-chip token-tone-${index % 5}`} key={`${index}-${token.id}`} title={`Token ID ${token.id}`}><span>{token.text.replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}</span><small>{token.id}</small></span>)}</div>;
}

export function TokenLab({ controller }: { controller: GameController }) {
  const [tab, setTab] = useState<'receipt' | 'tokenizer'>('receipt');
  const [text, setText] = useState('Tetris turns tokens into moves.');
  const deferredText = useDeferredValue(text);
  const [tokenized, setTokenized] = useState<{ count: number; tokens: TokenChip[] } | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const insight = controller.insights[0];
  const budget = controller.room?.playerTokenBudget ?? 80000;
  const spent = controller.metrics.input + controller.metrics.output;
  const remaining = Math.max(0, budget - spent);
  const cooldown = Math.max(0, Math.ceil((controller.cooldownUntil - now) / 1000));
  const canApply = insight?.status === 'ready' && insight.pieceId === controller.view.pieceId && controller.view.status !== 'over';
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (tab !== 'tokenizer') return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void fetch('/api/tokenize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: deferredText }), signal: abort.signal })
        .then(async response => { if (!response.ok) throw new Error('The tokenizer is busy. Try again shortly.'); return response.json(); })
        .then(data => { setTokenized(data); setError(''); }).catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    }, 240);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [deferredText, tab]);

  return <section className="token-lab" aria-labelledby="token-title">
    <header className="section-heading"><span className="section-number">02</span><h2 id="token-title">Token lab</h2><span className="tiny-label">LIVE INFERENCE</span></header>
    <div className="budget-head"><span>YOUR TOKEN BANK</span><strong>{format(remaining)}<small> / {format(budget)}</small></strong></div>
    <div className="budget-track" role="progressbar" aria-label="Remaining model token budget" aria-valuenow={remaining} aria-valuemin={0} aria-valuemax={budget}><i style={{ width: `${Math.max(0, 100 * remaining / budget)}%` }} /></div>
    <div className="power-switches">
      <label className={`power-switch ${controller.options.cache ? 'enabled cache' : ''}`}><Layers3 size={19} /><span><strong>Cache prefix</strong><small>{controller.options.cache ? 'REUSE ON' : 'REUSE OFF'}</small></span><input type="checkbox" checked={controller.options.cache} onChange={event => controller.setOptions(current => ({ ...current, cache: event.target.checked }))} /><i className="switch-track" /></label>
      <label className={`power-switch ${controller.options.compression ? 'enabled compress' : ''}`}><FileJson2 size={19} /><span><strong>Compress</strong><small>{controller.options.compression ? 'PACKED' : 'VERBOSE'}</small></span><input type="checkbox" checked={controller.options.compression} onChange={event => controller.setOptions(current => ({ ...current, compression: event.target.checked }))} /><i className="switch-track" /></label>
    </div>
    <button className="luna-button" onClick={() => void controller.assist()} disabled={!controller.joined || controller.busy || cooldown > 0 || controller.view.status === 'over' || remaining === 0}><Sparkles size={20} /><span>{controller.busy ? 'Luna is choosing...' : cooldown > 0 ? `Ready in ${cooldown}s` : 'Ask Luna for a move'}</span>{controller.busy ? <i className="loading-spinner" /> : <ChevronRight size={18} />}</button>
    <div className="model-line"><i className="status-dot" /><span>GPT-5.6 LUNA</span><span>REASONING OFF</span></div>
    <div className="lab-tabs" role="tablist" aria-label="Token lab views"><button role="tab" aria-selected={tab === 'receipt'} onClick={() => setTab('receipt')}><Zap size={15} />Live receipt</button><button role="tab" aria-selected={tab === 'tokenizer'} onClick={() => setTab('tokenizer')}><ScanText size={15} />Token splitter</button></div>
    {tab === 'receipt' ? <div className="receipt-content" role="tabpanel">
      {insight ? <>
        <div className="receipt-top"><span className="receipt-label">REQUEST {String(controller.metrics.requests).padStart(2, '0')}</span><span><Timer size={12} />{(insight.latencyMs / 1000).toFixed(2)}s</span></div>
        <div className="receipt-modes"><span>PREFIX CACHE {insight.cacheEnabled ? 'ON' : 'OFF'}</span><span>{insight.compression ? 'PACKED' : 'VERBOSE'} PAYLOAD</span></div>
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
      <dl className="token-facts"><div><dt>Tokens</dt><dd>Chunks of text, not Tetris blocks.</dd></div><div><dt>Cache</dt><dd>Reuses prefix computation. Input still counts; writes can cost extra.</dd></div><div><dt>Compression</dt><dd>Same board. Less text sent to the model.</dd></div></dl>
    </div> : <div className="splitter-content" role="tabpanel">
      <label htmlFor="token-text">Text to tokenize</label><textarea id="token-text" value={text} maxLength={500} onChange={event => setText(event.target.value)} spellCheck={false} rows={3} />
      <div className="splitter-meta"><span>o200k_base / estimate</span><strong>{tokenized?.count ?? 0} tokens</strong></div>
      {error ? <p className="inline-error">{error}</p> : <TokenChips tokens={tokenized?.tokens ?? []} />}
      <div className="splitter-footer"><span>{text.length} characters</span><span>0 model calls</span></div>
    </div>}
    <div className="lab-footer"><span><Check size={13} />Actual Azure usage</span><span>No simulated cache hits</span></div>
  </section>;
}