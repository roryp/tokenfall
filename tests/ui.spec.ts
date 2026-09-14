import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { createApplication } from '../server/app.ts';
import { POLICY, PREFIX_TOKENS, RequestError } from '../server/model.ts';
import type { ModelGateway } from '../server/model.ts';
import { buildPrompts, tokenChips, unpackBoard } from '../server/tokens.ts';
import { Game, placementsFor } from '../shared/game.ts';
import { costForUsage, emptyMetrics } from '../shared/protocol.ts';
import type { AiOptions, Usage } from '../shared/protocol.ts';

let browser: Browser;
const screenshots = path.resolve('data/tetris-qa');
before(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  mkdirSync(screenshots, { recursive: true });
});
after(async () => { await browser?.close(); });

async function fixture(viewport = { width: 1366, height: 768 }) {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'tetris-ui-'));
  const controls = { hold: false, chooseHold: false, invalid: false, fail: false, cacheMiss: false, mixedCache: false, firstPlacement: false, inFlight: 0, maxInFlight: 0 };
  const events = new EventEmitter();
  const releases: (() => void)[] = [];
  const calls: { options: AiOptions; usage: Usage; prompt: string; verbose: string; packed: string; rawTokens: number; packedTokens: number }[] = [];
  let cacheWarm = false;
  const gateway: ModelGateway = { complete: async (game, options) => {
    controls.inFlight += 1;
    controls.maxInFlight = Math.max(controls.maxInFlight, controls.inFlight);
    const invalid = controls.invalid;
    const fail = controls.fail;
    const placements = placementsFor(game);
    const selected = controls.chooseHold ? placements.find(placement => placement.useHold && !placement.gameOver)! : controls.firstPlacement ? placements[0] : [...placements].sort((first, second) => first.holes - second.holes || second.clearedLines - first.clearedLines || first.aggregateHeight - second.aggregateHeight)[0];
    const prompts = buildPrompts(game, placements);
    const input = PREFIX_TOKENS + (options.compression ? prompts.packedTokens : prompts.rawTokens);
    const cached = options.cache && cacheWarm && !controls.cacheMiss ? controls.mixedCache ? Math.floor(PREFIX_TOKENS / 2) : PREFIX_TOKENS : 0;
    const cacheWrites = options.cache && !cacheWarm ? PREFIX_TOKENS : cached > 0 && controls.mixedCache ? PREFIX_TOKENS - cached : 0;
    const usage = { input, output: 20, cached, cacheWrites, total: input + 20, reasoning: 0 };
    if (options.cache) cacheWarm = true;
    calls.push({ options: { ...options }, usage, prompt: options.compression ? prompts.packed : prompts.verbose, verbose: prompts.verbose, packed: prompts.packed, rawTokens: prompts.rawTokens, packedTokens: prompts.packedTokens });
    const pieceId = game.pieceId;
    try {
      const pending = controls.hold ? new Promise<void>(resolve => releases.push(resolve)) : null;
      events.emit('request');
      if (pending) await pending;
      if (fail) throw new RequestError('Test model unavailable.', 'unavailable');
      return {
        id: randomUUID(), pieceId, status: invalid ? 'invalid' : 'ready',
        placement: invalid ? null : { column: selected.column, row: selected.row, rotation: selected.rotation, piece: selected.piece, useHold: selected.useHold },
        tip: 'Synthetic browser test, not a live model.', usage, latencyMs: 45,
        rawTokens: prompts.rawTokens, packedTokens: prompts.packedTokens,
        savedTokens: options.compression ? prompts.rawTokens - prompts.packedTokens : 0,
        compression: options.compression, cacheEnabled: options.cache,
        prompt: options.compression ? prompts.packed : prompts.verbose, systemPrompt: POLICY, promptComparison: { verbose: prompts.verbose, packed: prompts.packed }, outputText: '{}',
        inputChips: [], outputChips: tokenChips('{}'),
      };
    } finally { controls.inFlight -= 1; }
  } };
  const application = createApplication({ port: 0, endpoint: 'https://fixture.invalid', deployment: 'gpt-5.6-luna', tenantId: 'fixture', dataDirectory }, gateway);
  let seed = 0;
  const gameFor = application.room.gameFor.bind(application.room);
  application.room.gameFor = text => text ? gameFor(text) : new Game(`standard-ui-${seed++}`);
  const inputs = application.room.inputs.bind(application.room);
  application.room.inputs = (...args) => { const result = inputs(...args); events.emit('inputs'); return result; };
  const admittedAt: number[] = [];
  const acquire = application.room.gate.acquire.bind(application.room.gate);
  application.room.gate.acquire = (...args) => { const release = acquire(...args); admittedAt.push(args[4] ?? Date.now()); return release; };
  application.room.pricing = { status: 'live', snapshot: {
    model: 'gpt-5.6-luna', region: 'eastus2', sku: 'GlobalStandard', currency: 'USD',
    usdPerMillion: { input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20 },
    checkedAt: new Date().toISOString(), sourceUrl: 'https://prices.azure.com/api/retail/prices',
    meters: Object.fromEntries(['input', 'cachedInput', 'cacheWrite', 'output'].map(key => [key, { id: key, name: `Test ${key}`, effectiveFrom: '2026-08-01T00:00:00Z' }])) as Record<'input' | 'cachedInput' | 'cacheWrite' | 'output', { id: string; name: string; effectiveFrom: string }>,
  } };
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address() as { port: number };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  const player = () => [...application.room.players.values()].find(candidate => candidate.socketId)!;
  return {
    page, controls, calls, application, errors, admittedAt, player,
    waitForCalls: async (count: number) => { while (calls.length < count) await once(events, 'request', { signal: AbortSignal.timeout(8000) }); },
    waitForGame: async (predicate: (game: Game) => boolean) => { while (!predicate(player().game)) await once(events, 'inputs', { signal: AbortSignal.timeout(8000) }); },
    release: () => { const release = releases.shift(); assert.ok(release, 'Expected a pending model fixture'); release(); },
    close: async () => { controls.hold = false; releases.splice(0).forEach(release => release()); await context.close(); await application.close(); rmSync(dataDirectory, { recursive: true, force: true }); },
  };
}

const numeric = (text: string | null) => Number(text?.replace(/[^\d.-]/g, ''));
async function waitPieces(page: Page, count: number) {
  await page.waitForFunction(expected => Number(document.querySelector('.game-canvas')?.getAttribute('data-pieces')) >= expected, count);
}
async function waitRequests(page: Page, count: number) {
  await page.waitForFunction(expected => Number(document.querySelector('[data-testid="ai-requests"]')?.textContent?.replace(/\D/g, '')) === expected, count);
}

test('normal Tetris opens immediately with standard pieces and free manual controls', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  assert.equal(await page.getByRole('heading', { name: 'TETRIS', exact: true }).count(), 1);
  assert.equal(await page.locator('form, textarea, nav, [role="tablist"], .token-lab, .round-clock, .leaderboard').count(), 0);
  assert.deepEqual(setup.player().game.tokens, []);
  assert.equal(await page.getByRole('checkbox').count(), 3);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await page.getByRole('button', { name: 'Hold current piece', exact: true }).click();
  await page.getByRole('button', { name: 'Hard drop (Space)', exact: true }).click();
  await waitPieces(page, 1);
  await page.getByRole('button', { name: 'Pause game', exact: true }).click();
  await setup.waitForGame(game => game.status === 'paused' && game.pieces === 1);
  assert.ok(numeric(await page.getByTestId('game-score').textContent()) > 0);
  assert.equal(numeric(await page.getByTestId('ai-cost').textContent()), 0);
  assert.equal(numeric(await page.getByTestId('ai-tokens').textContent()), 0);
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('optimization switches give immediate next-request feedback without inventing costs or cache hits', async context => {
  const setup = await fixture({ width: 390, height: 844 });
  context.after(setup.close);
  const { page } = setup;
  assert.equal(await page.getByTestId('compression-next').innerText(), 'Cell JSON next');
  assert.equal(await page.getByTestId('cache-next').innerText(), 'Full input next');
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Cache off');
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).check();
  assert.equal(await page.getByTestId('compression-next').innerText(), 'Packed rows next');
  assert.equal(await page.getByTestId('cache-next').innerText(), 'Reuse rules next');
  for (const id of ['ai-cost', 'ai-savings', 'compression-adjustment', 'cache-adjustment', 'unoptimized-cost']) assert.equal(numeric(await page.getByTestId(id).textContent()), 0);
  assert.equal(await page.getByTestId('cache-totals').innerText(), '0 hits / 0 misses');
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Cache ready');
  assert.equal(await page.getByRole('button', { name: 'Inspect cached instructions', exact: true }).isEnabled(), false);
  assert.equal(await page.getByRole('button', { name: 'Inspect last prompt', exact: true }).isEnabled(), false);
  assert.equal(setup.calls.length, 0);
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).uncheck();
  assert.equal(await page.getByTestId('compression-next').innerText(), 'Cell JSON next');
  assert.equal(await page.getByTestId('cache-next').innerText(), 'Full input next');
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('Ask Luna plays an entire standard game and stops at game over without restarting', { timeout: 35000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  setup.controls.firstPlacement = true;
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await page.getByRole('heading', { name: 'Game over', exact: true }).waitFor({ timeout: 30000 });
  await setup.waitForGame(game => game.status === 'over');
  assert.ok(setup.calls.length >= 5);
  assert.equal(setup.player().game.pieces, setup.calls.length);
  assert.equal(setup.player().metrics.requests, setup.calls.length);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  assert.equal(setup.controls.maxInFlight, 1);
  assert.ok(setup.admittedAt.slice(1).every((time, index) => time - setup.admittedAt[index] >= 1000));
  assert.deepEqual(setup.errors, []);
});

test('a Luna-selected Hold is executed and synchronized as one placement without a substitute move', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  setup.controls.chooseHold = true;
  const original = setup.player().game.piece;
  const next = setup.player().game.queue.peek()[0];
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  const offered = JSON.parse(setup.calls[0].prompt).placements;
  assert.ok(offered.some((placement: { useHold: boolean; piece: string }) => placement.useHold && placement.piece === next));
  setup.release();
  await waitPieces(page, 1);
  await page.getByRole('button', { name: 'Stop Luna', exact: true }).click();
  await setup.waitForGame(game => game.pieces === 1 && game.hold === original);
  assert.equal(await page.locator('.hold-slot [role="img"]').getAttribute('aria-label'), `${original} piece`);
  assert.equal(setup.player().game.tokensTaken, 3);
  assert.equal(setup.player().game.events.filter(event => event.action === 'hold').length, 1);
  assert.equal(setup.player().game.events.filter(event => event.action === 'hardDrop').length, 1);
  assert.equal(setup.calls.length, 1);
  assert.deepEqual(setup.errors, []);
});

test('Luna snapshots live settings, prices actual usage, and cannot apply a move after Stop', { timeout: 18000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).check();
  assert.deepEqual(setup.calls[0].options, { compression: false, cache: false, autopilot: true });
  assert.match(await page.getByTestId('request-status').innerText(), /Verbose \/ cache off/);
  assert.equal(await page.getByTestId('compression-next').innerText(), 'Packed rows next');
  assert.equal(await page.getByTestId('cache-next').innerText(), 'Reuse rules next');
  assert.equal(numeric(await page.getByTestId('ai-cost').textContent()), 0);
  assert.equal(await page.getByTestId('cache-totals').innerText(), '0 hits / 0 misses');
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Checking cache');
  setup.release();
  await waitPieces(page, 1);
  await setup.waitForCalls(2);
  assert.deepEqual(setup.calls[1].options, { compression: true, cache: true, autopilot: true });
  assert.equal(setup.calls[1].usage.cached, 0);
  assert.ok(setup.calls[1].usage.cacheWrites > 0);
  assert.match(await page.getByTestId('compression-detail').innerText(), /uncompressed/);
  assert.equal(await page.getByTestId('cache-totals').innerText(), '0 hits / 0 misses');
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Cache was off');
  setup.release();
  await waitPieces(page, 2);
  await setup.waitForCalls(3);
  assert.ok(setup.calls[2].usage.cached > 0);
  assert.equal(await page.getByTestId('cache-totals').innerText(), '0 hits / 1 miss');
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Cache miss / written');
  assert.match(await page.getByTestId('cache-reused').innerText(), /written; none reused/);
  assert.ok(numeric(await page.getByTestId('cache-request-adjustment').textContent()) > 0);
  assert.match(await page.getByTestId('compression-adjustment').innerText(), /^-\$/);
  assert.match(await page.getByTestId('cache-adjustment').innerText(), /^\+\$/);
  await page.getByRole('button', { name: 'Stop Luna', exact: true }).click();
  setup.release();
  await waitRequests(page, 3);
  await setup.waitForGame(game => game.pieces === 2 && game.status === 'paused');
  const metrics = setup.player().metrics;
  const rates = setup.application.room.pricing.snapshot!.usdPerMillion;
  const expected = costForUsage(metrics, rates).total;
  assert.ok(Math.abs(numeric(await page.getByTestId('ai-cost').textContent()) - expected) < 1e-8);
  assert.equal(numeric(await page.getByTestId('ai-tokens').textContent()), metrics.input + metrics.output);
  const saving = (metrics.compressionSaved * rates.input + metrics.cached * (rates.input - rates.cachedInput) - metrics.cacheWrites * (rates.cacheWrite - rates.input)) / 1000000;
  assert.ok(Math.abs(numeric(await page.getByTestId('ai-savings').textContent()) - saving) < 1e-8);
  assert.ok(saving > 0);
  assert.equal(metrics.cacheHits, 1);
  assert.equal(metrics.cacheMisses, 1);
  assert.equal(metrics.cacheBypassed, 1);
  assert.equal(await page.getByTestId('cache-totals').innerText(), '1 hit / 1 miss');
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Cache hit');
  assert.equal(await page.getByTestId('cache-receipt').getByText('Fixed Tetris instructions', { exact: true }).isVisible(), true);
  assert.equal(await page.getByTestId('cache-receipt').getByText('Board + next move', { exact: true }).isVisible(), true);
  assert.match(await page.getByTestId('cache-reused').innerText(), /input tokens reused/);
  assert.equal(numeric(await page.getByTestId('cache-reused').textContent()), setup.calls[2].usage.cached);
  const lastCacheDelta = setup.calls[2].usage.cached * (rates.cachedInput - rates.input) / 1000000;
  assert.ok(Math.abs(numeric(await page.getByTestId('cache-request-adjustment').textContent()) - lastCacheDelta) < 1e-8);
  const compressionDelta = numeric(await page.getByTestId('compression-adjustment').textContent());
  const cacheDelta = numeric(await page.getByTestId('cache-adjustment').textContent());
  const before = numeric(await page.getByTestId('unoptimized-cost').textContent());
  assert.ok(compressionDelta < 0 && cacheDelta < 0);
  assert.ok(Math.abs(before + compressionDelta + cacheDelta - expected) < 3e-8);
  const costText = await page.getByTestId('ai-cost').textContent();
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).uncheck();
  assert.equal(await page.getByTestId('ai-cost').textContent(), costText);
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Cache hit');
  assert.equal(numeric(await page.getByTestId('compression-adjustment').textContent()), compressionDelta);
  assert.equal(numeric(await page.getByTestId('cache-adjustment').textContent()), cacheDelta);
  assert.match(await page.getByTestId('compression-detail').innerText(), /tokens \(-\d+%\)/);
  await page.getByRole('button', { name: 'Inspect last prompt', exact: true }).click();
  await page.getByRole('dialog', { name: 'Compression before / after' }).waitFor();
  assert.equal(await page.getByTestId('sent-prompt').textContent(), setup.calls[2].prompt);
  assert.equal(await page.getByTestId('compression-before').locator('pre').textContent(), setup.calls[2].verbose);
  assert.equal(await page.getByTestId('compression-after').locator('pre').textContent(), setup.calls[2].packed);
  assert.match(await page.getByTestId('compression-verdict').innerText(), /Compression was ON/);
  const { board: rawBoard, ...rawState } = JSON.parse(setup.calls[2].verbose);
  const { board: packedBoard, ...packedState } = JSON.parse(setup.calls[2].packed);
  assert.deepEqual(rawBoard.map((cell: { value: unknown }) => cell.value), unpackBoard(packedBoard));
  assert.deepEqual(rawState, packedState);
  assert.ok(JSON.parse((await page.getByTestId('sent-prompt').textContent())!).board.every((row: unknown) => typeof row === 'string'));
  await page.getByTestId('sent-prompt').focus();
  await page.keyboard.press('KeyP');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('.game-canvas').getAttribute('data-status'), 'paused');
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '2');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(setup.controls.maxInFlight, 1);
  assert.equal(setup.calls.length, 3);
  await page.screenshot({ path: path.join(screenshots, 'live-cost-desktop.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: width === 320 ? 710 : 844 });
    const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, boxes: ['.cost-ticker', '.cost-adjustments', '.cache-receipt', '.cache-parts', '.luna-controls', '.prompt-summary', '.scoreboard', '.game-canvas', '.game-controls'].map(selector => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect();
      return { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, clipped: element.scrollWidth > element.clientWidth + 1 };
    }) }));
    assert.ok(layout.documentWidth <= layout.width, JSON.stringify(layout));
    for (const box of layout.boxes) assert.ok(box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= layout.height + 1 && !box.clipped, JSON.stringify({ width, box }));
    await page.screenshot({ path: path.join(screenshots, `optimization-feedback-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Inspect last prompt', exact: true }).click();
    const dialog = await page.getByRole('dialog').boundingBox();
    assert.ok(dialog && dialog.x >= 0 && dialog.x + dialog.width <= width && dialog.y >= 0 && dialog.y + dialog.height <= layout.height, JSON.stringify(dialog));
    await page.screenshot({ path: path.join(screenshots, `prompt-inspector-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Close prompt', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect cached instructions', exact: true }).click();
    await page.getByRole('dialog', { name: 'Cache activity' }).waitFor();
    assert.equal(await page.getByTestId('cache-activity-row').count(), 3);
    assert.deepEqual(await page.getByTestId('cache-activity-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-outcome'))), ['Hit', 'Miss / written', 'Off']);
    assert.equal(await page.getByTestId('cached-instructions').textContent(), POLICY);
    assert.match(await page.getByTestId('inspected-cache-result').innerText(), /Cache hit:/);
    const prefixDialog = await page.getByRole('dialog').boundingBox();
    assert.ok(prefixDialog && prefixDialog.x >= 0 && prefixDialog.x + prefixDialog.width <= width && prefixDialog.y >= 0 && prefixDialog.y + prefixDialog.height <= layout.height, JSON.stringify(prefixDialog));
    await page.screenshot({ path: path.join(screenshots, `cache-instructions-${width}.png`), animations: 'disabled' });
    await page.getByTestId('cached-instructions').focus();
    await page.keyboard.press('KeyP');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('.game-canvas').getAttribute('data-status'), 'paused');
    assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '2');
    await page.keyboard.press('Escape');
  }
  await page.reload();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(await page.getByTestId('cache-totals').innerText(), '1 hit / 1 miss');
  assert.equal(await page.getByTestId('ai-cost').textContent(), costText);
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'No recent cache receipt');
  assert.equal(await page.getByRole('button', { name: 'Inspect cached instructions', exact: true }).isEnabled(), false);
  assert.equal(setup.calls.length, 3);
  assert.deepEqual(setup.errors, []);
});

test('prompt inspection freezes the displayed request while a stopped in-flight response is still billed', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).check();
  setup.release();
  await waitPieces(page, 1);
  await setup.waitForCalls(2);
  await page.getByRole('button', { name: 'Inspect last prompt', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByTestId('sent-prompt').textContent(), setup.calls[0].prompt);
  assert.equal(await page.getByTestId('compression-before').locator('pre').textContent(), setup.calls[0].verbose);
  assert.equal(await page.getByTestId('compression-after').locator('pre').textContent(), setup.calls[0].packed);
  assert.match(await page.getByTestId('compression-verdict').textContent() ?? '', /Compression was OFF.*after version was not/);
  assert.ok(JSON.parse((await page.getByTestId('sent-prompt').textContent())!).board.every((cell: unknown) => typeof cell === 'object'));
  setup.release();
  await waitRequests(page, 2);
  assert.equal(await page.getByTestId('sent-prompt').textContent(), setup.calls[0].prompt);
  assert.equal(await page.getByTestId('compression-after').locator('pre').textContent(), setup.calls[0].packed);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '1');
  await page.getByRole('button', { name: 'Close prompt', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect last prompt', exact: true }).click();
  assert.equal(await page.getByTestId('sent-prompt').textContent(), setup.calls[1].prompt);
  assert.equal(await page.getByTestId('compression-before').locator('pre').textContent(), setup.calls[1].verbose);
  assert.match(await page.getByTestId('compression-verdict').textContent() ?? '', /Compression was ON/);
  await page.getByRole('button', { name: 'Close prompt', exact: true }).click();
  assert.equal(setup.calls.length, 2);
  assert.deepEqual(setup.errors, []);
});

test('cache activity runs live and preserves selected hits and misses as later replies arrive', { timeout: 18000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  setup.controls.mixedCache = true;
  setup.release();
  await waitPieces(page, 1);
  await setup.waitForCalls(2);
  await page.getByRole('button', { name: 'Inspect cached instructions', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cache activity' });
  await dialog.waitFor();
  assert.equal(await page.locator('.tetris-app').getAttribute('data-autopilot'), 'true');
  assert.equal(await page.getByTestId('cache-activity-row').count(), 1);
  assert.match(await page.getByTestId('cache-activity-pending').innerText(), /outcome pending/);
  const receipt = await page.getByTestId('inspected-cache-result').textContent();
  assert.match(receipt!, /Cache miss:.*tokens written, none reused/);
  assert.equal(await page.getByTestId('cached-instructions').textContent(), POLICY);
  setup.controls.mixedCache = false;
  setup.controls.cacheMiss = true;
  setup.release();
  await waitRequests(page, 2);
  await waitPieces(page, 2);
  assert.equal(await page.getByTestId('cache-activity-row').count(), 2);
  assert.equal(await page.getByTestId('inspected-cache-result').textContent(), receipt);
  assert.equal(await page.getByTestId('cache-result-label').textContent(), 'Cache hit');
  const usage = setup.calls[1].usage;
  assert.ok(usage.cached > 0 && usage.cacheWrites > 0);
  assert.match(await page.getByTestId('cache-reused').textContent() ?? '', /reused \+ .* written/);
  const rates = setup.application.room.pricing.snapshot!.usdPerMillion;
  const net = (usage.cached * (rates.cachedInput - rates.input) + usage.cacheWrites * (rates.cacheWrite - rates.input)) / 1000000;
  assert.ok(Math.abs(numeric(await page.getByTestId('cache-request-adjustment').textContent()) - net) < 1e-8);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '2');
  await dialog.getByRole('button', { name: 'Inspect cache reply 2', exact: true }).click();
  assert.match(await page.getByTestId('inspected-cache-result').innerText(), /Cache hit:.*also written/);
  await dialog.getByRole('button', { name: 'Inspect cache reply 1', exact: true }).click();
  assert.equal(await page.getByTestId('inspected-cache-result').textContent(), receipt);
  await setup.waitForCalls(3);
  assert.equal(await page.getByTestId('cache-result-label').textContent(), 'Cache hit');
  await dialog.getByRole('button', { name: 'Stop Luna in inspector', exact: true }).click();
  setup.release();
  await waitRequests(page, 3);
  assert.equal(await page.getByTestId('cache-activity-row').count(), 3);
  assert.equal(await page.getByTestId('inspected-cache-result').textContent(), receipt);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '2');
  assert.equal(await page.locator('.tetris-app').getAttribute('data-autopilot'), 'false');
  assert.deepEqual(await page.getByTestId('cache-activity-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-outcome'))), ['Miss', 'Hit', 'Miss / written']);
  await dialog.getByRole('button', { name: 'Inspect cache reply 3', exact: true }).click();
  assert.equal(await page.getByTestId('cached-instructions').textContent(), POLICY);
  assert.match(await page.getByTestId('inspected-cache-result').innerText(), /no input tokens reused/);
  assert.equal(await dialog.getByText('Sent without a cache match', { exact: true }).isVisible(), true);
  assert.equal(await dialog.getByText('Fresh input for this request, not a cache hit', { exact: true }).isVisible(), true);
  assert.equal(await page.getByTestId('cache-result-label').textContent(), 'Cache miss');
  assert.equal(await page.getByTestId('cache-reused').textContent(), '0 tokens reused');
  assert.equal(numeric(await page.getByTestId('cache-request-adjustment').textContent()), 0);
  await dialog.getByRole('button', { name: 'Close prompt', exact: true }).click();
  assert.equal(setup.calls.length, 3);
  assert.deepEqual(setup.errors, []);
});

test('a cache write alone shows a premium, while missing usage or prices never become free', { timeout: 18000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  await page.getByRole('button', { name: 'Stop Luna', exact: true }).click();
  setup.release();
  await waitRequests(page, 1);
  assert.equal(await page.getByText('EXTRA WRITE COST', { exact: true }).isVisible(), true);
  assert.ok(numeric(await page.getByTestId('ai-savings').textContent()) > 0);
  assert.match(await page.getByTestId('request-status').innerText(), /cache write/);
  assert.match(await page.getByTestId('cache-adjustment').innerText(), /^\+\$/);
  assert.equal(await page.getByTestId('cache-totals').innerText(), '0 hits / 1 miss');
  setup.application.room.pricing = { status: 'unavailable', snapshot: null };
  await page.waitForFunction(() => document.querySelector('[data-testid="ai-cost"]')?.textContent === '--');
  assert.equal(await page.getByTestId('ai-savings').textContent(), '--');
  assert.equal(await page.getByTestId('compression-adjustment').textContent(), '--');
  assert.equal(await page.getByTestId('cache-adjustment').textContent(), '--');
  assert.equal(await page.getByTestId('unoptimized-cost').textContent(), '--');
  assert.match(await page.getByTestId('cache-request-adjustment').innerText(), /^--/);
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Cache miss / written');
  setup.controls.hold = false;
  setup.controls.fail = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await page.getByText('Test model unavailable.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  assert.equal(setup.player().record.attempts, 2);
  assert.equal(setup.player().metrics.requests, 1);
  await page.getByText('AI COST / PENDING USAGE', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('cache-totals').innerText(), '0 hits / 1 miss');
  await page.getByRole('button', { name: 'Inspect cached instructions', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cache activity' });
  await dialog.waitFor();
  assert.equal(await page.getByTestId('cache-activity-row').count(), 1);
  assert.match(await dialog.locator('.activity-warning').innerText(), /1 request\(s\) without usage/);
  assert.equal(await page.getByTestId('cache-activity-row').locator('td').last().innerText(), '--');
  await dialog.getByRole('button', { name: 'Close prompt', exact: true }).click();
  assert.deepEqual(setup.errors, []);
});

test('the running cache history is bounded, survives a new game, and never reconstructs absent replies', { timeout: 40000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="ai-requests"]')?.textContent?.replace(/\D/g, '')) >= 22, null, { timeout: 32000 });
  await page.getByRole('button', { name: 'Stop Luna', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect cached instructions', exact: true }).click();
  const replies = await page.getByTestId('cache-activity-row').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-reply'))));
  assert.equal(replies.length, 20);
  assert.equal(replies[0], setup.player().metrics.requests);
  assert.equal(replies[19], replies[0] - 19);
  assert.equal(new Set(replies).size, 20);
  await page.getByRole('button', { name: 'Close prompt', exact: true }).click();
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.game-canvas')?.getAttribute('data-pieces') === '0');
  await page.getByRole('button', { name: 'Inspect cached instructions', exact: true }).click();
  assert.deepEqual(await page.getByTestId('cache-activity-row').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-reply')))), replies);
  const requests = setup.calls.length;
  await page.getByRole('button', { name: 'Close prompt', exact: true }).click();
  await page.reload();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Inspect cached instructions', exact: true }).isEnabled(), false);
  assert.equal(numeric(await page.getByTestId('ai-requests').textContent()), requests);
  assert.equal(setup.calls.length, requests);
  assert.deepEqual(setup.errors, []);
});

test('private usage reaches the ticker even when the player is outside every legacy ranking', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  const player = setup.player();
  for (let index = 0; index < 51; index += 1) {
    const socketId = `legacy-${index}`;
    setup.application.room.join(`Previous ${index}`, setup.application.room.code, undefined, socketId);
    const previous = setup.application.room.playerFor(socketId);
    previous.record.best_score = 10000;
    previous.record.attempts = 1;
    previous.metrics = { ...emptyMetrics(), requests: 1, input: 100, output: 10 };
    setup.application.room.disconnect(socketId);
  }
  assert.equal(setup.application.room.view().leaderboard.some(entry => entry.id === player.record.id), false);
  assert.equal(setup.application.room.view().pointsLeaderboard.some(entry => entry.id === player.record.id), false);
  setup.controls.fail = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await page.getByText('Test model unavailable.', { exact: true }).waitFor();
  await page.getByText('AI COST / PENDING USAGE', { exact: true }).waitFor();
  assert.equal(player.record.attempts, 1);
  assert.equal(player.metrics.requests, 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  assert.deepEqual(setup.errors, []);
});

test('ordinary play continues past thirty seconds with no timer or forced recap', { timeout: 40000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  await page.waitForFunction(() => Number(document.querySelector('.game-canvas')?.getAttribute('data-frame')) > 1920, null, { timeout: 36000 });
  assert.equal(await page.locator('.game-canvas').getAttribute('data-status'), 'playing');
  assert.equal(await page.locator('[role="dialog"], .round-recap, .round-clock').count(), 0);
  assert.equal(await page.getByTestId('game-status').textContent(), 'Manual play');
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('returning prototype sessions become classic games and retain costs and options on restart', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  const previous = setup.application.room.join('Old Player', setup.application.room.code, undefined, 'prototype', 'old token pieces');
  const old = setup.application.room.playerFor('prototype');
  old.metrics = { ...emptyMetrics(), requests: 1, input: 1234, output: 20 };
  old.record.attempts = 1;
  setup.application.room.disconnect('prototype');
  await page.evaluate(session => sessionStorage.setItem('tokenfall-session', JSON.stringify(session)), { token: previous.token, name: previous.name, room: setup.application.room.code });
  await page.reload();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(setup.player().record.id, previous.playerId);
  assert.deepEqual(setup.player().game.tokens, []);
  assert.equal(setup.player().record.token_text, '');
  await waitRequests(page, 1);
  const cost = await page.getByTestId('ai-cost').textContent();
  assert.equal(await page.getByTestId('cache-unclassified').textContent(), '1 earlier request unclassified');
  assert.equal(await page.getByTestId('cache-totals').textContent(), '0 hits / 0 misses');
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).check();
  await page.getByRole('button', { name: 'Pause game', exact: true }).click();
  const seed = setup.player().game.seed;
  setup.player().started -= 3000;
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.game-canvas')?.getAttribute('data-status') === 'playing');
  await page.reload();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.notEqual(setup.player().game.seed, seed);
  assert.equal(await page.getByTestId('ai-cost').textContent(), cost);
  assert.equal(await page.getByRole('checkbox', { name: 'Cache', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Compression', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('hidden tabs and reconnects stop Luna without dropping charged usage', { timeout: 20000 }, async context => {
  for (const transition of ['hidden', 'disconnect']) await context.test(transition, async child => {
    const setup = await fixture();
    child.after(setup.close);
    const { page } = setup;
    setup.controls.hold = true;
    await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
    await setup.waitForCalls(1);
    if (transition === 'hidden') await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    else for (const socket of setup.application.io.sockets.sockets.values()) socket.conn.close();
    setup.release();
    await page.locator('.tetris-app[data-playing="true"]').waitFor();
    await waitRequests(page, 1);
    assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
    assert.equal(setup.player().game.pieces, 0);
    assert.equal(setup.player().metrics.requests, 1);
    assert.equal(setup.calls.length, 1);
    assert.deepEqual(setup.errors, []);
  });
});

test('the game, cost ticker and controls fit laptop and phone viewports with visible canvas pixels', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  for (const viewport of [{ width: 320, height: 710 }, { width: 390, height: 844 }, { width: 768, height: 900 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const selectors = ['.game-header', '.cost-ticker', '.luna-controls', '.scoreboard', '.game-canvas', '.game-controls'];
      const boxes = selectors.map(selector => { const element = document.querySelector<HTMLElement>(selector)!; const rect = element.getBoundingClientRect(); return { selector, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, clipped: element.scrollWidth > element.clientWidth + 1 }; });
      const canvas = document.querySelector<HTMLCanvasElement>('.game-canvas')!;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set<string>();
      for (let offset = 0; offset < pixels.length; offset += 16) colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
      const targets = [...document.querySelectorAll('.game-controls button, .game-switch input, .cache-receipt button')].map(element => { const rect = element.getBoundingClientRect(); return { name: element.getAttribute('aria-label'), width: rect.width, height: rect.height }; });
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, boxes, colors: colors.size, targets };
    });
    assert.ok(layout.documentWidth <= layout.width, JSON.stringify(layout));
    for (const box of layout.boxes) assert.ok(box.top >= 0 && box.bottom <= layout.height + 1 && box.left >= 0 && box.right <= layout.width && !box.clipped, JSON.stringify({ viewport, box }));
    for (const target of layout.targets) assert.ok(target.width >= 44 && target.height >= 44, JSON.stringify({ viewport, target }));
    assert.ok(layout.colors > 4, 'The canvas must contain visible board and piece pixels');
    await page.screenshot({ path: path.join(screenshots, `tetris-${viewport.width}.png`), animations: 'disabled' });
  }
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});