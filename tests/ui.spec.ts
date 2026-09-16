import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { createApplication } from '../server/app.ts';
import { maxCompletionTokens, MCP_GUIDANCE, POLICY, PREFIX_TOKENS, RequestError } from '../server/model.ts';
import type { ModelGateway } from '../server/model.ts';
import { buildPrompts, countTokens, gameTokens, tokenChips, unpackBoard } from '../server/tokens.ts';
import { lookaheadSnapshot, lookupFutureMoves, McpLookupError, mcpPromptContext } from '../server/mcp.ts';
import { Game, placementsFor, tokenLabel, tokenShape } from '../shared/game.ts';
import { costForUsage, emptyMetrics } from '../shared/protocol.ts';
import type { AiOptions, McpLookup, Usage } from '../shared/protocol.ts';

const jsQR = createRequire(import.meta.url)('jsqr') as typeof import('jsqr').default;
let browser: Browser;
const screenshots = path.resolve('data/tetris-qa');
before(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  mkdirSync(screenshots, { recursive: true });
});
after(async () => { await browser?.close(); });

async function fixture(viewport = { width: 1366, height: 768 }, autoJoin = true, networkJoin = false, initialOptions?: Partial<AiOptions>) {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'tetris-ui-'));
  const controls = { hold: false, chooseHold: false, invalid: false, truncated: false, fail: false, mcpFail: false, cacheMiss: false, mixedCache: false, missingReasoning: false, firstPlacement: false, inFlight: 0, maxInFlight: 0 };
  const events = new EventEmitter();
  const releases: (() => void)[] = [];
  const calls: { options: AiOptions; usage: Usage; prompt: string; verbose: string; packed: string; rawTokens: number; packedTokens: number; mcpLookup?: McpLookup }[] = [];
  let cacheWarm = false;
  const gateway: ModelGateway = { complete: async (game, options) => {
    if (options.mcp && controls.mcpFail) throw new McpLookupError();
    const mcpLookup = options.mcp ? await lookupFutureMoves(lookaheadSnapshot(game)) : undefined;
    controls.inFlight += 1;
    controls.maxInFlight = Math.max(controls.maxInFlight, controls.inFlight);
    const invalid = controls.invalid || controls.truncated;
    const fail = controls.fail;
    const placements = placementsFor(game);
    const selected = controls.chooseHold ? placements.find(placement => placement.useHold && !placement.gameOver)! : controls.firstPlacement ? placements[0] : [...placements].sort((first, second) => first.holes - second.holes || second.clearedLines - first.clearedLines || first.aggregateHeight - second.aggregateHeight)[0];
    let prompts = buildPrompts(game, placements);
    const originalTokens = options.compression ? prompts.packedTokens : prompts.rawTokens;
    const systemPrompt = POLICY + (mcpLookup ? MCP_GUIDANCE : '');
    if (mcpLookup) {
      const context = mcpPromptContext(mcpLookup);
      const verbose = JSON.stringify({ ...JSON.parse(prompts.verbose), mcpLookup: context });
      const packed = JSON.stringify({ ...JSON.parse(prompts.packed), mcpLookup: context });
      prompts = { verbose, packed, rawTokens: countTokens(verbose), packedTokens: countTokens(packed) };
      mcpLookup.addedInputTokens = (options.compression ? prompts.packedTokens : prompts.rawTokens) - originalTokens + countTokens(systemPrompt) - PREFIX_TOKENS;
    }
    const input = countTokens(systemPrompt) + (options.compression ? prompts.packedTokens : prompts.rawTokens);
    const cached = options.cache && cacheWarm && !controls.cacheMiss ? controls.mixedCache ? Math.floor(PREFIX_TOKENS / 2) : PREFIX_TOKENS : 0;
    const cacheWrites = options.cache && !cacheWarm ? PREFIX_TOKENS : cached > 0 && controls.mixedCache ? PREFIX_TOKENS - cached : 0;
    const reasoning = options.reasoning ? controls.truncated ? maxCompletionTokens(options) : 256 : 0;
    const output = controls.truncated ? maxCompletionTokens(options) : 20 + reasoning;
    const usage = { input, output, cached, cacheWrites, total: input + output, reasoning: controls.missingReasoning ? null : reasoning };
    if (options.cache) cacheWarm = true;
    calls.push({ options: { ...options }, usage, prompt: options.compression ? prompts.packed : prompts.verbose, verbose: prompts.verbose, packed: prompts.packed, rawTokens: prompts.rawTokens, packedTokens: prompts.packedTokens, mcpLookup });
    const pieceId = game.pieceId;
    try {
      const pending = controls.hold ? new Promise<void>(resolve => releases.push(resolve)) : null;
      events.emit('request');
      if (pending) await pending;
      if (fail) throw new RequestError('Test model unavailable.', 'unavailable');
      return {
        id: randomUUID(), pieceId, status: invalid ? 'invalid' : 'ready',
        placement: invalid ? null : { column: selected.column, row: selected.row, rotation: selected.rotation, piece: selected.piece, useHold: selected.useHold },
        tip: controls.truncated ? `The reply hit its ${maxCompletionTokens(options)}-token completion cap, not your total allowance. Usage was recorded; no move was applied.` : 'Synthetic browser test, not a live model.', usage, latencyMs: 45,
        rawTokens: prompts.rawTokens, packedTokens: prompts.packedTokens,
        savedTokens: options.compression ? prompts.rawTokens - prompts.packedTokens : 0,
        compression: options.compression, cacheEnabled: options.cache, reasoningEnabled: Boolean(options.reasoning),
        ...(mcpLookup ? { mcpLookup } : {}),
        prompt: options.compression ? prompts.packed : prompts.verbose, systemPrompt, promptComparison: { verbose: prompts.verbose, packed: prompts.packed }, outputText: '{}',
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
  await new Promise<void>(resolve => application.server.listen(0, networkJoin ? '0.0.0.0' : '127.0.0.1', resolve));
  const address = application.server.address() as { port: number };
  if (networkJoin) {
    const network = Object.values(os.networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal);
    assert.ok(network, 'A network address is required for the audience join test');
    application.room.config.publicUrl = `http://${network.address}:${address.port}`;
  }
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (initialOptions) await context.addInitScript(options => {
    if (sessionStorage.getItem('tetris-luna-options') === null) {
      sessionStorage.setItem('tetris-luna-options', JSON.stringify({ compression: false, cache: false, ...options }));
    }
  }, initialOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  if (autoJoin) {
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Test Player');
    await page.getByRole('radio', { name: 'Classic', exact: true }).check();
    await page.getByRole('button', { name: 'Join game', exact: true }).click();
    await page.locator('.tetris-app[data-playing="true"]').waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
  }
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

async function scanQr(canvas: Locator): Promise<string> {
  const image = await canvas.evaluate((element: HTMLCanvasElement) => {
    const bounds = element.getBoundingClientRect();
    const rendered = document.createElement('canvas');
    rendered.width = Math.round(bounds.width);
    rendered.height = Math.round(bounds.height);
    const context = rendered.getContext('2d')!;
    context.drawImage(element, 0, 0, rendered.width, rendered.height);
    return { width: rendered.width, height: rendered.height, pixels: Array.from(context.getImageData(0, 0, rendered.width, rendered.height).data) };
  });
  assert.equal(image.width, image.height);
  assert.ok(image.pixels.slice(0, image.width * 4).every(channel => channel === 255), 'QR must retain its white quiet zone in every theme');
  const decoded = jsQR(new Uint8ClampedArray(image.pixels), image.width, image.height, { inversionAttempts: 'dontInvert' });
  assert.ok(decoded, 'Rendered QR pixels must decode at their displayed size');
  return decoded.data;
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`Luna-dependent switches require Ask Luna and retain settings at ${viewport.width}px`, async context => {
    const setup = await fixture(viewport);
    context.after(setup.close);
    const { page } = setup;
    setup.controls.hold = true;
    const luna = page.getByRole('checkbox', { name: 'Ask Luna', exact: true });
    const options = ['Reasoning', 'MCP', 'Compression', 'Cache'].map(name => page.getByRole('checkbox', { name, exact: true }));
    assert.equal(await luna.isChecked(), false);
    for (const option of options) {
      assert.equal(await option.isDisabled(), true);
      await option.click({ force: true });
      assert.equal(await option.isChecked(), false);
    }
    await luna.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.luna-controls input:focus').count(), 0);
    assert.equal(setup.calls.length, 0);
    await page.screenshot({ path: path.join(screenshots, `luna-controls-off-${viewport.width}.png`), animations: 'disabled' });
    await luna.check();
    await setup.waitForCalls(1);
    for (const option of options) {
      assert.equal(await option.isEnabled(), true);
      await option.check();
    }
    await page.screenshot({ path: path.join(screenshots, `luna-controls-on-${viewport.width}.png`), animations: 'disabled' });
    assert.deepEqual(setup.calls[0].options, { compression: false, cache: false, reasoning: false, mcp: false, autopilot: true });
    await luna.uncheck();
    for (const option of options) {
      assert.equal(await option.isDisabled(), true);
      assert.equal(await option.isChecked(), true);
    }
    setup.release();
    await waitRequests(page, 1);
    assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '0');
    await page.reload();
    await page.locator('.tetris-app[data-playing="true"]').waitFor();
    assert.equal(await luna.isChecked(), false);
    for (const option of options) {
      assert.equal(await option.isDisabled(), true);
      assert.equal(await option.isChecked(), true);
    }
    assert.equal(setup.calls.length, 1);
    await luna.check();
    await setup.waitForCalls(2);
    assert.deepEqual(setup.calls[1].options, { compression: true, cache: true, reasoning: true, mcp: true, autopilot: true });
    for (const option of options) {
      assert.equal(await option.isEnabled(), true);
      await option.uncheck();
    }
    await luna.uncheck();
    for (const option of options) assert.equal(await option.isDisabled(), true);
    setup.release();
    await waitRequests(page, 2);
    assert.deepEqual(setup.errors, []);
  });
}

test('Luna remains enabled across window visibility changes without background moves', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  const luna = page.getByRole('checkbox', { name: 'Ask Luna', exact: true });
  await luna.check();
  await setup.waitForCalls(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await luna.isChecked(), true);
  setup.release();
  await waitRequests(page, 1);
  await page.waitForTimeout(1200);
  assert.equal(setup.calls.length, 1);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '0');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await setup.waitForCalls(2);
  assert.equal(await luna.isChecked(), true);
  setup.release();
  await waitPieces(page, 1);
  await luna.uncheck();
  assert.equal(setup.controls.maxInFlight, 1);
  assert.equal(setup.player().metrics.requests, 2);
  assert.deepEqual(setup.errors, []);
});

test('classic Tetris joins by name with standard pieces, live rankings, and free manual controls', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  assert.equal(await page.getByRole('heading', { name: 'TETRIS', exact: true }).count(), 1);
  assert.equal(await page.locator('form, textarea, .token-lab, .round-clock').count(), 0);
  assert.equal(await page.locator('.leaderboard').count(), 1);
  assert.equal(await page.getByTestId('player-name').innerText(), 'Test Player');
  assert.deepEqual(setup.player().game.tokens, []);
  assert.equal(await page.getByRole('checkbox').count(), 5);
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

test('sentence blocks preview real tokens, label hold and drops, and survive reload and reconfiguration', async context => {
  const setup = await fixture({ width: 390, height: 844 }, false);
  context.after(setup.close);
  const { page } = setup;
  const sentence = 'Code makes bright blocks.';
  const chips = gameTokens(sentence);
  assert.equal(setup.application.room.players.size, 0);
  await page.evaluate(() => {
    const scope = window as unknown as { paintedTokens: string[] };
    scope.paintedTokens = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, left, top, maxWidth) {
      if (scope.paintedTokens.length < 1000) scope.paintedTokens.push(text);
      original.call(this, text, left, top, maxWidth!);
    };
  });
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Sentence Player');
  await page.getByRole('textbox', { name: 'Your sentence', exact: true }).fill(sentence);
  await page.waitForFunction(count => document.querySelectorAll('.token-stream li').length === count, chips.length);
  assert.deepEqual(await page.locator('.token-stream li').evaluateAll(elements => elements.map(element => ({ id: Number(element.getAttribute('data-token-id')), piece: element.getAttribute('data-piece') }))), chips.map(chip => ({ id: chip.id, piece: tokenShape(chip.id) })));
  await page.getByRole('button', { name: 'Join game', exact: true }).click();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  const playerId = setup.player().record.id;
  assert.deepEqual(setup.player().game.tokens, chips);
  assert.equal(setup.player().record.token_text, sentence);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-token-count'), String(chips.length));
  const first = setup.player().game.view().activeToken!;
  await page.getByRole('button', { name: 'Hold current piece', exact: true }).click();
  assert.equal(await page.locator('.hold-slot .piece-token').innerText(), tokenLabel(first.text));
  const dropped = chips[1];
  await page.getByRole('button', { name: 'Hard drop (Space)', exact: true }).click();
  await waitPieces(page, 1);
  await page.getByRole('button', { name: 'Pause game', exact: true }).click();
  await setup.waitForGame(game => game.pieces === 1 && game.status === 'paused');
  await page.waitForFunction(label => (window as unknown as { paintedTokens: string[] }).paintedTokens.includes(label), tokenLabel(dropped.text));
  const score = setup.player().game.score;
  const board = setup.player().game.view().board;
  assert.ok(score > 0);
  await page.reload();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(setup.player().record.id, playerId);
  assert.deepEqual(setup.player().game.tokens, chips);
  assert.deepEqual(setup.player().game.view().board, board);
  assert.equal(numeric(await page.getByTestId('game-score').innerText()), score);
  assert.equal(await page.locator('.hold-slot .piece-token').innerText(), tokenLabel(first.text));
  setup.player().started -= 2100;
  await page.getByRole('button', { name: 'Change sentence', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New sentence', exact: true });
  const replacement = 'Small pieces. Fresh start.';
  await editor.getByRole('textbox', { name: 'Your sentence', exact: true }).fill(replacement);
  await editor.getByRole('button', { name: 'Start with sentence', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(setup.player().record.id, playerId);
  assert.deepEqual(setup.player().game.tokens, gameTokens(replacement));
  assert.equal(setup.player().record.best_score, score);
  assert.equal(setup.player().game.pieces, 0);
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('sentence preview recovers from failure and blocks invalid names and oversized token streams', async context => {
  const setup = await fixture({ width: 390, height: 844 }, false);
  context.after(setup.close);
  const { page } = setup;
  let unavailable = true;
  await page.route('**/api/tokenize', route => unavailable ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Retry Player');
  await page.getByRole('textbox', { name: 'Your sentence', exact: true }).fill('Retry this sentence.');
  await page.getByRole('button', { name: 'Retry token preview', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Join game', exact: true }).isEnabled(), false);
  unavailable = false;
  await page.getByRole('button', { name: 'Retry token preview', exact: true }).click();
  await page.locator('.token-stream li').first().waitFor();
  await page.getByRole('textbox', { name: 'Your sentence', exact: true }).fill('\u0378'.repeat(500));
  await page.getByText('Use at most 256 tokens.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Join game', exact: true }).isEnabled(), false);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('<script>');
  await page.getByRole('radio', { name: 'Classic', exact: true }).check();
  assert.equal(await page.getByRole('button', { name: 'Join game', exact: true }).isEnabled(), false);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Retry Player');
  await page.getByRole('button', { name: 'Join game', exact: true }).click();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(setup.application.room.players.size, 1);
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('shared leaderboard joins independent players, updates scores, pages all entries, and preserves ranking order', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page, application } = setup;
  await page.getByRole('button', { name: 'Pause game', exact: true }).click();
  for (let index = 0; index < 12; index += 1) {
    const socketId = `rank-${index}`;
    const joined = application.room.join(`Rank ${index + 1}`, application.room.code, undefined, socketId);
    const player = application.room.players.get(joined.playerId)!;
    player.record.best_score = (12 - index) * 100;
    player.record.best_lines = index + 1;
    player.record.attempts = 1;
    player.metrics = { ...emptyMetrics(), requests: 1, input: (12 - index) ** 2 * 1000 };
    application.room.disconnect(socketId);
  }
  await page.getByTestId('leaderboard-page').filter({ hasText: '1/2' }).waitFor();
  assert.equal(await page.getByTestId('leaderboard-row').count(), 10);
  const ids = () => page.getByTestId('leaderboard-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-player-id')));
  assert.deepEqual(await ids(), application.room.view().pointsLeaderboard.slice(0, 10).map(entry => entry.id));
  await page.getByRole('button', { name: 'Show my ranking', exact: true }).click();
  assert.equal(await page.getByTestId('leaderboard-page').innerText(), '2/2');
  assert.equal(await page.locator('.leaderboard tr[aria-current="true"]').count(), 1);
  await page.getByRole('radio', { name: 'Points / cent', exact: true }).check();
  assert.deepEqual(await ids(), application.room.view().leaderboard.filter(entry => entry.challengeScore !== null).slice(0, 10).map(entry => entry.id));
  assert.equal(await page.getByTestId('own-rank').innerText(), 'Unranked');
  await page.getByRole('radio', { name: 'Points', exact: true }).check();
  await page.getByRole('button', { name: 'Share game', exact: true }).click();
  const invite = await page.getByRole('textbox', { name: 'Game invite link', exact: true }).inputValue();
  assert.equal(new URL(invite).searchParams.get('room'), application.room.code);
  assert.equal(new URL(invite).searchParams.has('token'), false);
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  context.after(() => secondContext.close());
  const second = await secondContext.newPage();
  await second.goto(invite);
  await second.getByRole('textbox', { name: 'Name', exact: true }).fill('Guest Player');
  await second.getByRole('radio', { name: 'Classic', exact: true }).check();
  await second.getByRole('button', { name: 'Join game', exact: true }).click();
  await second.locator('.tetris-app[data-playing="true"]').waitFor();
  const guest = [...application.room.players.values()].find(player => player.record.name === 'Guest Player')!;
  assert.notEqual(guest.record.id, setup.player().record.id);
  await second.getByRole('button', { name: 'Hard drop (Space)', exact: true }).click();
  await waitPieces(second, 1);
  await second.getByRole('button', { name: 'Pause game', exact: true }).click();
  await page.getByRole('button', { name: 'Show my ranking', exact: true }).click();
  await page.waitForFunction(id => Number(document.querySelector(`[data-player-id="${id}"] .rank-score strong`)?.textContent?.replaceAll(',', '')) > 0, guest.record.id);
  assert.equal(await page.locator('.room-heading small').innerText(), '2/50 online');
  const guestRow = page.locator(`[data-player-id="${guest.record.id}"]`);
  assert.equal(numeric(await guestRow.locator('.rank-score strong').innerText()), guest.record.best_score);
  assert.equal(await guestRow.getByTitle('Online', { exact: true }).count(), 1);
  await secondContext.close();
  await guestRow.getByTitle('Offline', { exact: true }).waitFor();
  assert.equal(await page.locator('.room-heading small').innerText(), '1/50 online');
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('audience QR codes decode at desktop and mobile sizes and join an independent player', { timeout: 45000 }, async context => {
  const setup = await fixture({ width: 1366, height: 900 }, false, true);
  let audience: BrowserContext | undefined;
  context.after(async () => { await audience?.close(); await setup.close(); });
  const { page, application } = setup;
  await page.goto(`${new URL(page.url()).origin}/?token=do-not-share&name=Private#private`);
  await page.getByRole('button', { name: 'Share game', exact: true }).click();
  const inlineQr = page.getByRole('img', { name: 'Audience join QR code', exact: true });
  await inlineQr.waitFor();
  const invite = await scanQr(inlineQr);
  context.diagnostic('Inline QR decoded');
  assert.equal(invite, application.room.view().joinUrl);
  assert.deepEqual([...new URL(invite).searchParams.keys()], ['room']);
  assert.equal(new URL(invite).searchParams.get('room'), application.room.code);
  assert.equal(new URL(invite).hash, '');
  assert.equal(await page.getByRole('textbox', { name: 'Game invite link', exact: true }).inputValue(), invite);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { copiedInvite: string }).copiedInvite = value; } } });
  });
  await page.getByRole('button', { name: 'Copy game link', exact: true }).click();
  assert.equal(await page.evaluate(() => (window as unknown as { copiedInvite: string }).copiedInvite), invite);
  assert.equal(application.room.players.size, 0);
  await page.getByRole('button', { name: 'Enlarge join QR code', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Join room ${application.room.code}`, exact: true });
  await dialog.waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 710 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await scanQr(dialog.getByRole('img', { name: 'Audience join QR code', exact: true })), invite);
      const bounds = await dialog.boundingBox();
      const usableWidth = await page.evaluate(() => document.documentElement.clientWidth);
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= usableWidth + 1 && bounds.y + bounds.height <= viewport.height + 1);
      assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
      const close = await dialog.getByRole('button', { name: 'Close join QR code', exact: true }).boundingBox();
      assert.ok(close && close.width >= 44 && close.height >= 44);
      await page.screenshot({ path: path.join(screenshots, `audience-qr-${theme}-${viewport.width}.png`), animations: 'disabled' });
    }
  }
  audience = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  context.diagnostic('All responsive QR views decoded');
  const phone = await audience.newPage();
  phone.setDefaultTimeout(8000);
  phone.setDefaultNavigationTimeout(12000);
  await phone.goto(invite);
  await phone.getByRole('textbox', { name: 'Name', exact: true }).fill('QR Guest');
  await phone.getByRole('radio', { name: 'Classic', exact: true }).check();
  await phone.getByRole('button', { name: 'Join game', exact: true }).click();
  await phone.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(await phone.getByTestId('room-code').innerText(), application.room.code);
  assert.equal(await phone.getByTestId('player-name').innerText(), 'QR Guest');
  assert.equal(await phone.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  await phone.getByRole('button', { name: 'Hard drop (Space)', exact: true }).click();
  await waitPieces(phone, 1);
  await phone.getByRole('button', { name: 'Pause game', exact: true }).click();
  assert.equal(application.room.players.size, 1);
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('sharing an audience QR never interrupts Luna or changes the selected room link', async context => {
  const setup = await fixture(undefined, true, false, { compression: true });
  context.after(setup.close);
  const { page, application } = setup;
  application.room.config.publicUrl = 'https://audience.example.test/ignored?token=private#private';
  setup.controls.hold = true;
  const luna = page.getByRole('checkbox', { name: 'Ask Luna', exact: true });
  await luna.check();
  await setup.waitForCalls(1);
  await page.getByRole('button', { name: 'Share game', exact: true }).click();
  await page.getByRole('button', { name: 'Enlarge join QR code', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Join room ${application.room.code}`, exact: true });
  const expected = `https://audience.example.test/?room=${application.room.code}`;
  assert.equal(await scanQr(dialog.getByRole('img', { name: 'Audience join QR code', exact: true })), expected);
  await page.keyboard.press('KeyP');
  assert.equal(await luna.isChecked(), true);
  setup.release();
  await waitPieces(page, 1);
  await setup.waitForCalls(2);
  assert.equal(await luna.isChecked(), true);
  assert.equal(await dialog.getByRole('link').getAttribute('href'), expected);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await luna.isChecked(), true);
  await luna.uncheck();
  setup.release();
  await waitRequests(page, 2);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '1');
  assert.equal(setup.calls.length, 2);
  assert.deepEqual(setup.errors, []);
});

test('localhost sharing does not display an unusable audience QR and copy failures retain the link', async context => {
  const setup = await fixture({ width: 320, height: 710 }, false);
  context.after(setup.close);
  const { page } = setup;
  await page.getByRole('button', { name: 'Share game', exact: true }).click();
  await page.getByText(/Audience QR unavailable on localhost/).waitFor();
  assert.equal(await page.getByRole('img', { name: 'Audience join QR code', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Enlarge join QR code', exact: true }).count(), 0);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Clipboard denied'); } } }); });
  await page.getByRole('button', { name: 'Copy game link', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Select the game link to copy it.' }).waitFor();
  const input = page.getByRole('textbox', { name: 'Game invite link', exact: true });
  await input.focus();
  assert.equal(await input.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!), (await input.inputValue()).length);
  await page.getByRole('button', { name: 'Share game', exact: true }).click();
  assert.equal(await input.count(), 0);
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('sentence games retain Luna-selected Hold moves and reported AI spend across sentence changes', async context => {
  const setup = await fixture({ width: 1366, height: 768 }, false, false, { compression: true, cache: true });
  context.after(setup.close);
  const { page } = setup;
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Sentence Pilot');
  await page.getByRole('button', { name: 'Join game', exact: true }).click();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  const original = setup.player().game.view().activeToken!;
  const playerId = setup.player().record.id;
  setup.controls.hold = true;
  setup.controls.chooseHold = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  assert.equal(JSON.parse(setup.calls[0].prompt).randomizer, 'repeating');
  setup.release();
  await waitPieces(page, 1);
  await page.getByRole('button', { name: 'Stop Luna', exact: true }).click();
  await setup.waitForGame(game => game.pieces === 1 && game.status === 'paused');
  assert.equal(await page.locator('.hold-slot .piece-token').innerText(), tokenLabel(original.text));
  assert.equal(setup.player().game.events.filter(event => event.action === 'hold').length, 1);
  const metrics = { ...setup.player().metrics };
  const cost = await page.getByTestId('ai-cost').innerText();
  const score = setup.player().record.best_score;
  assert.ok(numeric(cost) > 0);
  setup.player().started -= 2100;
  await page.getByRole('button', { name: 'Change sentence', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New sentence', exact: true });
  await editor.getByRole('textbox', { name: 'Your sentence', exact: true }).fill('A fresh sequence keeps the receipt.');
  await editor.getByRole('button', { name: 'Start with sentence', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(setup.player().record.id, playerId);
  assert.equal(setup.player().record.best_score, score);
  assert.deepEqual(setup.player().metrics, metrics);
  assert.equal(await page.getByTestId('ai-cost').innerText(), cost);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: 'Cache', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Compression', exact: true }).isChecked(), true);
  assert.equal(setup.calls.length, 1);
  assert.deepEqual(setup.errors, []);
});

test('room onboarding, sentence controls and leaderboard fit narrow screens and both themes', async context => {
  const setup = await fixture({ width: 390, height: 844 }, false);
  context.after(setup.close);
  const { page } = setup;
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Visual Review');
  await page.locator('.token-stream li').first().waitFor();
  for (const width of [305, 320, 390, 768, 1366, 1920]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    const fit = await page.evaluate(() => ({ width: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth, boxes: ['.game-header', '.join-form', '.join-form textarea', '.join-form > input', '.token-stream', '.join-form > button', '.leaderboard'].map(selector => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect();
      return { selector, left: rect.left, right: rect.right, clipped: element.scrollWidth > element.clientWidth + 1 };
    }) }));
    assert.ok(fit.documentWidth <= fit.width, JSON.stringify(fit));
    for (const box of fit.boxes) assert.ok(box.left >= 0 && box.right <= fit.width + 1 && !box.clipped, JSON.stringify({ width, box }));
    if ([320, 390, 1366].includes(width)) await page.screenshot({ path: path.join(screenshots, `sentence-lobby-${width}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('button', { name: 'Join game', exact: true }).click();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  await page.getByRole('button', { name: 'Hard drop (Space)', exact: true }).click();
  await waitPieces(page, 1);
  await page.getByRole('button', { name: 'Show leaderboard', exact: true }).focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('.game-canvas').getAttribute('data-status'), 'paused');
  assert.equal(await page.locator('.leaderboard h2').evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Space');
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '1');
  await page.getByRole('button', { name: 'Back to game', exact: true }).click();
  assert.equal(await page.evaluate(() => scrollY), 0);
  for (const theme of ['light', 'dark']) {
    await page.goto(`${page.url().split('?')[0]}?scoutTheme=${theme}`);
    await page.locator('.tetris-app[data-playing="true"]').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    await page.getByRole('button', { name: 'Change sentence', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New sentence', exact: true });
    await dialog.waitFor();
    await dialog.getByRole('textbox', { name: 'Your sentence', exact: true }).fill('W'.repeat(500));
    await page.getByTestId('room-code').waitFor();
    const bounds = await dialog.boundingBox();
    const usableWidth = await page.evaluate(() => document.documentElement.clientWidth);
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= usableWidth + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 844, JSON.stringify(bounds));
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.game-canvas').getAttribute('data-status'), 'paused');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(screenshots, `sentence-game-320-${theme}.png`), animations: 'disabled' });
  }
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('expired sessions and full rooms recover without silent joins or leaking sentence text', async context => {
  const setup = await fixture({ width: 390, height: 844 }, false);
  context.after(setup.close);
  const { page, application } = setup;
  await page.evaluate(room => sessionStorage.setItem('tokenfall-session', JSON.stringify({ token: 'a'.repeat(64), name: 'Expired', room })), application.room.code);
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'Your previous session expired.' }).waitFor();
  await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
  assert.equal(application.room.players.size, 0);
  await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
  for (let index = 0; index < 50; index += 1) application.room.join(`Guest ${index}`, application.room.code, undefined, `full-${index}`);
  await page.getByText('Room full. Waiting for a free spot.', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('New Player');
  await page.getByRole('textbox', { name: 'Your sentence', exact: true }).fill('Private sentence is not public room data.');
  assert.equal(await page.getByRole('button', { name: 'Join game', exact: true }).isEnabled(), false);
  application.room.disconnect('full-0');
  await page.getByRole('button', { name: 'Join game', exact: true }).click();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(application.room.online, 50);
  const published = await page.request.get(new URL('/api/room', page.url()).href);
  const publicData = await published.text();
  assert.equal(publicData.includes('Private sentence'), false);
  assert.equal(publicData.includes('token_hash'), false);
  assert.equal(publicData.includes('tokenText'), false);
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('sentence editor shows server failures in the dialog and can retry without losing the run', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page, application } = setup;
  await page.getByRole('button', { name: 'Change sentence', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New sentence', exact: true });
  const run = setup.player().runId;
  const restart = application.room.restart.bind(application.room);
  application.room.restart = () => { throw new RequestError('Wait a moment before restarting.', 'cooldown', 2000); };
  await editor.getByRole('button', { name: 'Start with sentence', exact: true }).click();
  await editor.getByRole('alert').filter({ hasText: 'Wait a moment before restarting.' }).waitFor();
  assert.equal(setup.player().runId, run);
  application.room.restart = restart;
  setup.player().started -= 2100;
  await editor.getByRole('button', { name: 'Start with sentence', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.notEqual(setup.player().runId, run);
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('AI allowance setup counts Luna, MCP and reasoning together and can be raised without resetting the game', async context => {
  const setup = await fixture({ width: 390, height: 844 }, false, false, { compression: true, reasoning: true, mcp: true });
  context.after(setup.close);
  const { page } = setup;
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Allowance Player');
  const allowanceInput = page.getByRole('spinbutton', { name: 'AI token allowance', exact: true });
  assert.equal(await allowanceInput.inputValue(), '1000000');
  await allowanceInput.fill('15999');
  assert.equal(await page.getByRole('button', { name: 'Join game', exact: true }).isEnabled(), false);
  await allowanceInput.fill('16000');
  await page.getByRole('button', { name: 'Join game', exact: true }).click();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 16000);
  assert.equal(setup.player().record.token_limit, 16000);
  assert.ok(setup.player().game.tokens.length > 0);
  setup.controls.hold = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="allowance-reserved"]')?.textContent ?? ''));
  const pending = setup.application.room.usage(setup.player()).allowance;
  assert.equal(pending.used, 0);
  assert.ok(pending.reserved > 0);
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 16000);
  assert.equal(numeric(await page.getByTestId('available-tokens-now').innerText()), pending.remaining);
  assert.equal(setup.calls[0].options.mcp, true);
  assert.equal(setup.calls[0].options.reasoning, true);
  setup.release();
  await waitPieces(page, 1);
  await waitRequests(page, 1);
  await page.getByRole('alert').filter({ hasText: 'Not enough token credits in your AI allowance' }).waitFor();
  const spent = setup.calls[0].usage.input + setup.calls[0].usage.output;
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 16000 - spent);
  assert.equal(numeric(await page.getByTestId('ai-tokens').innerText()), spent);
  assert.equal(numeric(await page.getByTestId('reasoning-tokens').innerText()), 256);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
  assert.equal(await page.getByTestId('game-status').innerText(), 'Luna paused');
  assert.equal(setup.calls.length, 1);
  const run = setup.player().runId;
  const score = await page.getByTestId('game-score').innerText();
  const cost = await page.getByTestId('ai-cost').innerText();
  await page.getByRole('button', { name: 'Adjust AI allowance', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI token allowance', exact: true });
  await dialog.waitFor();
  for (const width of [320, 390, 1366]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 768 });
    const bounds = await dialog.boundingBox();
    const usableWidth = await page.evaluate(() => document.documentElement.clientWidth);
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= usableWidth + 1 && bounds.y >= 0 && bounds.y + bounds.height <= (width < 600 ? 844 : 768));
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
    await page.screenshot({ path: path.join(screenshots, `token-allowance-dialog-${width}.png`), animations: 'disabled' });
  }
  await dialog.getByRole('spinbutton', { name: 'AI token allowance', exact: true }).fill('100000');
  await dialog.getByRole('button', { name: 'Save allowance', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(setup.player().runId, run);
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 100000 - spent);
  assert.equal(await page.getByTestId('game-score').innerText(), score);
  assert.equal(await page.getByTestId('ai-cost').innerText(), cost);
  await setup.waitForCalls(2);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).uncheck();
  setup.release();
  await waitRequests(page, 2);
  const totalSpent = spent + setup.calls[1].usage.input + setup.calls[1].usage.output;
  await page.reload();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(numeric(await page.getByTestId('ai-token-limit').innerText()), 100000);
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 100000 - totalSpent);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  assert.equal(setup.calls.length, 2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(screenshots, 'token-countdown-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshots, 'token-countdown-mobile.png'), animations: 'disabled' });
  assert.deepEqual(setup.errors, []);
});

test('the token balance only falls with reported usage and never rebounds when reservations release', async context => {
  const setup = await fixture(undefined, true, false, { compression: true });
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  await page.evaluate(() => {
    const counter = document.querySelector('[data-testid="ai-tokens-left"]')!;
    const value = () => Number(counter.textContent?.replace(/\D/g, ''));
    const history: number[] = [value()];
    (window as unknown as { balanceHistory: number[] }).balanceHistory = history;
    new MutationObserver(() => { if (history.at(-1) !== value()) history.push(value()); }).observe(counter, { childList: true, characterData: true, subtree: true });
  });
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="allowance-reserved"]')?.textContent ?? ''));
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 1000000);
  assert.ok(numeric(await page.getByTestId('available-tokens-now').innerText()) < 1000000);
  setup.release();
  await waitPieces(page, 1);
  await setup.waitForCalls(2);
  const firstUsed = setup.calls[0].usage.total;
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 1000000 - firstUsed);
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="available-tokens-now"]')?.textContent?.replace(/\D/g, '')) < Number(document.querySelector('[data-testid="ai-tokens-left"]')?.textContent?.replace(/\D/g, '')));
  await page.getByRole('button', { name: 'Stop Luna', exact: true }).click();
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 1000000 - firstUsed);
  setup.release();
  await waitRequests(page, 2);
  const totalUsed = firstUsed + setup.calls[1].usage.total;
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 1000000 - totalUsed);
  assert.equal(numeric(await page.getByTestId('available-tokens-now').innerText()), 1000000 - totalUsed);
  const history = await page.evaluate(() => (window as unknown as { balanceHistory: number[] }).balanceHistory);
  assert.deepEqual(history, [1000000, 1000000 - firstUsed, 1000000 - totalUsed]);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '1');
  assert.equal(setup.calls.length, 2);
  assert.deepEqual(setup.errors, []);
});

test('a completion token cap is reported separately while the remaining allowance stays visible', async context => {
  const setup = await fixture(undefined, true, false, { compression: true, reasoning: true });
  context.after(setup.close);
  const { page } = setup;
  setup.controls.truncated = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await page.getByRole('alert').filter({ hasText: 'completion cap, not your total allowance' }).waitFor();
  await waitRequests(page, 1);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).uncheck();
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '0');
  const used = setup.calls[0].usage.input + setup.calls[0].usage.output;
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 1000000 - used);
  assert.equal(numeric(await page.getByTestId('reasoning-tokens').innerText()), 2048);
  assert.ok(numeric(await page.getByTestId('ai-cost').innerText()) > 0);
  assert.equal(setup.calls.length, 1);
  assert.deepEqual(setup.errors, []);
});

test('allowance countdown separates shared room tokens, request slots, and unreported usage', async context => {
  const setup = await fixture({ width: 1366, height: 768 });
  context.after(setup.close);
  const { page, application } = setup;
  const other = application.room.join('Other Budget', application.room.code, undefined, 'other-budget');
  const otherPlayer = application.room.players.get(other.playerId)!;
  otherPlayer.metrics = { ...emptyMetrics(), requests: 1999, input: 7980000 };
  otherPlayer.record.attempts = 1999;
  application.room.disconnect('other-budget');
  await page.waitForFunction(() => document.querySelector('[data-testid="room-requests-left"]')?.textContent === '1');
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 20000);
  assert.equal(numeric(await page.getByTestId('personal-tokens-left').innerText()), 1000000);
  assert.equal(numeric(await page.getByTestId('room-tokens-left').innerText()), 20000);
  setup.controls.hold = true;
  setup.controls.fail = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  setup.release();
  await page.getByRole('alert').filter({ hasText: 'Test model unavailable.' }).waitFor();
  await page.getByTestId('allowance-unconfirmed').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="room-requests-left"]')?.textContent === '0');
  assert.equal(numeric(await page.getByTestId('ai-tokens-left').innerText()), 20000);
  assert.equal(numeric(await page.getByTestId('available-tokens-now').innerText()), 4000);
  assert.equal(numeric(await page.getByTestId('ai-tokens').innerText()), 0);
  assert.equal(numeric(await page.getByTestId('personal-tokens-left').innerText()), 1000000);
  await page.getByRole('button', { name: 'Retry Luna', exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isEnabled(), true);
  assert.equal(setup.calls.length, 1);
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).uncheck();
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isEnabled(), false);
  assert.deepEqual(setup.errors, []);
});

test('MCP toggles call the actual tool and preserve its exact lookup in a paused inspector', async context => {
  const setup = await fixture({ width: 390, height: 844 }, true, false, { compression: true, reasoning: true, mcp: true });
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  assert.equal(await page.getByRole('checkbox', { name: 'MCP', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'MCP', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Inspect MCP lookup', exact: true }).click();
  await page.getByTestId('mcp-empty').waitFor();
  assert.equal(setup.calls.length, 0);
  await page.getByRole('button', { name: 'Close MCP lookup', exact: true }).click();
  assert.equal(await page.getByTestId('mcp-next').innerText(), '2-piece next');
  assert.equal(setup.calls.length, 0);
  assert.equal(numeric(await page.getByTestId('ai-cost').innerText()), 0);
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  const lookup = setup.calls[0].mcpLookup!;
  assert.equal(lookup.transport, 'stdio');
  assert.equal(setup.calls[0].options.mcp, true);
  assert.equal(setup.calls[0].options.reasoning, true);
  assert.deepEqual(JSON.parse(setup.calls[0].prompt).mcpLookup.analysis, JSON.parse(lookup.result));
  await page.getByRole('checkbox', { name: 'MCP', exact: true }).uncheck();
  assert.equal(await page.getByTestId('mcp-next').innerText(), 'Off next');
  assert.match(await page.getByTestId('request-status').innerText(), /MCP on/);
  setup.release();
  await waitPieces(page, 1);
  await setup.waitForCalls(2);
  assert.equal(setup.calls[1].options.mcp, false);
  assert.equal(setup.calls[1].mcpLookup, undefined);
  await page.getByRole('button', { name: 'Inspect MCP lookup', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'MCP lookup', exact: true });
  await dialog.waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
  assert.equal(await dialog.getByTestId('mcp-server').innerText(), 'tetris-board-facts');
  assert.equal(await dialog.getByTestId('mcp-tool').innerText(), 'analyze_future_moves');
  assert.equal(await dialog.getByTestId('mcp-forecast-row').count(), JSON.parse(lookup.result).candidatesEvaluated);
  assert.equal(numeric(await dialog.getByTestId('mcp-added-tokens').innerText()), lookup.addedInputTokens);
  const extraCost = lookup.addedInputTokens! * setup.application.room.pricing.snapshot!.usdPerMillion.input / 1000000;
  assert.ok(Math.abs(numeric(await dialog.getByTestId('mcp-added-cost').innerText()) - extraCost) < 1e-8);
  await dialog.locator('.mcp-raw summary').click();
  assert.deepEqual(JSON.parse(await dialog.getByTestId('mcp-arguments').innerText()), lookup.arguments);
  assert.deepEqual(JSON.parse(await dialog.getByTestId('mcp-result').innerText()), JSON.parse(lookup.result));
  assert.equal(numeric(await dialog.getByTestId('mcp-result-tokens').innerText()), lookup.resultTokens);
  setup.release();
  await waitRequests(page, 2);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '1');
  assert.deepEqual(JSON.parse(await dialog.getByTestId('mcp-result').innerText()), JSON.parse(lookup.result));
  await dialog.locator('.mcp-raw summary').click();
  for (const width of [320, 390, 1366]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    const box = await dialog.boundingBox();
    const usableWidth = await page.evaluate(() => document.documentElement.clientWidth);
    assert.ok(box && box.x >= 0 && box.x + box.width <= usableWidth + 1 && box.y >= 0 && box.y + box.height <= (width < 600 ? 844 : 900));
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
    await page.screenshot({ path: path.join(screenshots, `mcp-lookup-${width}.png`), animations: 'disabled' });
  }
  await dialog.locator('.mcp-raw summary').click();
  await dialog.getByTestId('mcp-result').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyP');
  assert.equal(await page.locator('.game-canvas').getAttribute('data-status'), 'paused');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await setup.waitForCalls(3);
  await page.getByRole('checkbox', { name: 'MCP', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).uncheck();
  setup.release();
  await waitRequests(page, 3);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '1');
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const separated = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const room = bounds('.room-panel');
    const controls = bounds('.game-controls');
    const prompt = bounds('.prompt-summary');
    const toggle = bounds('.luna-mcp .game-switch');
    const results = bounds('.mcp-results-desktop');
    return { roomTop: room.top, controlsBottom: controls.bottom, promptBottom: prompt.bottom, toggleRight: toggle.right, resultsLeft: results.left };
  });
  assert.ok(separated.roomTop >= Math.max(separated.controlsBottom, separated.promptBottom), JSON.stringify(separated));
  assert.ok(separated.resultsLeft >= separated.toggleRight, JSON.stringify(separated));
  assert.equal(await page.getByRole('checkbox', { name: 'MCP', exact: true }).isDisabled(), true);
  await page.reload();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'MCP', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  await page.getByRole('button', { name: 'Inspect MCP lookup', exact: true }).click();
  await page.getByTestId('mcp-empty').waitFor();
  assert.equal(await page.getByTestId('mcp-forecast-row').count(), 0);
  assert.equal(setup.calls.length, 3);
  assert.deepEqual(setup.errors, []);
});

test('MCP failures retain Luna selection without phantom cost and recover after an options change', async context => {
  const setup = await fixture(undefined, true, false, { compression: true, mcp: true });
  context.after(setup.close);
  const { page } = setup;
  setup.controls.mcpFail = true;
  setup.controls.hold = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await page.getByRole('alert').filter({ hasText: 'MCP lookup failed before contacting Luna.' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
  assert.equal(setup.calls.length, 0);
  assert.equal(numeric(await page.getByTestId('ai-cost').innerText()), 0);
  assert.equal(setup.player().record.attempts, 0);
  assert.equal(setup.application.room.usage(setup.player()).unmeteredRequests, 0);
  await page.getByRole('checkbox', { name: 'MCP', exact: true }).uncheck();
  await setup.waitForCalls(1);
  await page.getByRole('button', { name: 'Stop Luna', exact: true }).click();
  setup.release();
  await waitRequests(page, 1);
  assert.equal(setup.calls[0].options.mcp, false);
  assert.equal(setup.calls[0].mcpLookup, undefined);
  assert.deepEqual(setup.errors, []);
});

test('Luna automatically recovers from transient MCP, provider and invalid-reply errors', async context => {
  for (const failure of ['mcp', 'provider', 'invalid']) await context.test(failure, async child => {
    const setup = await fixture(undefined, true, false, { compression: true, mcp: failure === 'mcp' });
    child.after(setup.close);
    const { page } = setup;
    setup.controls.mcpFail = failure === 'mcp';
    setup.controls.fail = failure === 'provider';
    setup.controls.invalid = failure === 'invalid';
    const luna = page.getByRole('checkbox', { name: 'Ask Luna', exact: true });
    await luna.check();
    await page.getByRole('alert').filter({ hasText: 'Retrying in' }).waitFor();
    assert.equal(await luna.isChecked(), true);
    assert.equal(setup.player().game.pieces, 0);
    if (failure === 'mcp') {
      assert.equal(setup.calls.length, 0);
      assert.equal(setup.player().record.attempts, 0);
    }
    setup.controls.mcpFail = false;
    setup.controls.fail = false;
    setup.controls.invalid = false;
    setup.controls.hold = true;
    await setup.waitForCalls(failure === 'mcp' ? 1 : 2);
    setup.release();
    await waitPieces(page, 1);
    await luna.uncheck();
    assert.equal(setup.application.room.usage(setup.player()).unmeteredRequests, failure === 'provider' ? 1 : 0);
    assert.equal(setup.controls.maxInFlight, 1);
    assert.deepEqual(setup.errors, []);
  });
});

test('Luna bounds automatic retries and an explicit Stop cancels recovery', { timeout: 30000 }, async context => {
  const setup = await fixture(undefined, true, false, { compression: true });
  context.after(setup.close);
  const { page } = setup;
  setup.controls.invalid = true;
  const luna = page.getByRole('checkbox', { name: 'Ask Luna', exact: true });
  await luna.check();
  const retry = page.getByRole('button', { name: 'Retry Luna', exact: true });
  await retry.waitFor({ timeout: 20000 });
  assert.equal(await luna.isChecked(), true);
  assert.equal(await page.getByTestId('game-status').innerText(), 'Luna paused');
  assert.equal(setup.calls.length, 4);
  await page.waitForTimeout(2200);
  assert.equal(setup.calls.length, 4);
  assert.equal(setup.player().game.pieces, 0);
  setup.controls.invalid = false;
  setup.controls.hold = true;
  await retry.click();
  await setup.waitForCalls(5);
  await luna.uncheck();
  setup.release();
  await waitRequests(page, 5);
  await page.waitForTimeout(2200);
  assert.equal(await luna.isChecked(), false);
  assert.equal(setup.calls.length, 5);
  assert.equal(setup.player().game.pieces, 0);
  assert.equal(setup.controls.maxInFlight, 1);
  assert.deepEqual(setup.errors, []);
});

test('reasoning toggles apply to the next request, report actual tokens and retain late billed usage', async context => {
  const setup = await fixture({ width: 390, height: 844 }, true, false, { compression: true, reasoning: true });
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  assert.equal(await page.getByRole('checkbox', { name: 'Reasoning', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Reasoning', exact: true }).isDisabled(), true);
  assert.equal(await page.getByTestId('reasoning-tokens').innerText(), '0');
  assert.equal(await page.getByTestId('last-reasoning-tokens').innerText(), '--');
  assert.equal(await page.getByTestId('reasoning-next').innerText(), 'Low effort next');
  assert.equal(setup.calls.length, 0);
  assert.equal(numeric(await page.getByTestId('ai-cost').innerText()), 0);
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  assert.equal(setup.calls[0].options.reasoning, true);
  assert.equal(await page.getByTestId('last-reasoning-tokens').innerText(), 'Pending');
  await page.getByRole('checkbox', { name: 'Reasoning', exact: true }).uncheck();
  assert.equal(await page.getByTestId('reasoning-next').innerText(), 'Off next');
  assert.match(await page.getByTestId('request-status').innerText(), /reasoning low/);
  setup.release();
  await waitPieces(page, 1);
  await setup.waitForCalls(2);
  assert.equal(setup.calls[1].options.reasoning, false);
  assert.equal(numeric(await page.getByTestId('reasoning-tokens').innerText()), 256);
  await page.getByRole('checkbox', { name: 'Reasoning', exact: true }).check();
  setup.release();
  await waitPieces(page, 2);
  await setup.waitForCalls(3);
  assert.equal(setup.calls[2].options.reasoning, true);
  await page.getByRole('button', { name: 'Stop Luna', exact: true }).click();
  setup.release();
  await waitRequests(page, 3);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '2');
  assert.equal(numeric(await page.getByTestId('reasoning-tokens').innerText()), 512);
  assert.equal(numeric(await page.getByTestId('last-reasoning-tokens').innerText()), 256);
  const rates = setup.application.room.pricing.snapshot!.usdPerMillion;
  const cost = setup.calls.reduce((sum, call) => sum + costForUsage(call.usage, rates).total, 0);
  assert.ok(Math.abs(numeric(await page.getByTestId('ai-cost').innerText()) - cost) < 1e-8);
  assert.equal(setup.player().metrics.output, 572);
  assert.equal(setup.player().metrics.reasoning, 512);
  await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
  for (const viewport of [{ width: 320, height: 710 }, { width: 390, height: 844 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    const luna = await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).boundingBox();
    const reasoning = await page.getByRole('checkbox', { name: 'Reasoning', exact: true }).boundingBox();
    assert.ok(luna && reasoning && reasoning.y >= luna.y + luna.height && reasoning.width >= 44 && reasoning.height >= 44);
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: innerHeight, boxes: ['.luna-reasoning', '.reasoning-usage', '.game-status', '.prompt-summary', '.game-canvas', '.game-controls'].map(selector => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect();
      return { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, clipped: element.scrollWidth > element.clientWidth + 1 };
    }) }));
    for (const box of layout.boxes) assert.ok(box.left >= 0 && box.right <= layout.width + 1 && box.top >= 0 && box.bottom <= layout.height + 1 && !box.clipped, JSON.stringify({ viewport, box }));
    await page.screenshot({ path: path.join(screenshots, `reasoning-tokens-${viewport.width}.png`), animations: 'disabled' });
  }
  await page.reload();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Reasoning', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  assert.equal(numeric(await page.getByTestId('reasoning-tokens').innerText()), 512);
  assert.equal(await page.getByTestId('last-reasoning-tokens').innerText(), '--');
  assert.equal(setup.controls.maxInFlight, 1);
  assert.deepEqual(setup.errors, []);
});

test('missing reasoning counts stay unknown and old preferences default reasoning off', async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  await page.evaluate(() => sessionStorage.setItem('tetris-luna-options', JSON.stringify({ compression: true, cache: true })));
  await page.reload();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Reasoning', exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: 'Compression', exact: true }).isChecked(), true);
  setup.controls.hold = true;
  setup.controls.missingReasoning = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  await page.getByRole('checkbox', { name: 'Reasoning', exact: true }).check();
  setup.release();
  await waitPieces(page, 1);
  await setup.waitForCalls(2);
  assert.equal(setup.calls[1].options.reasoning, true);
  await page.getByRole('button', { name: 'Stop Luna', exact: true }).click();
  setup.release();
  await waitRequests(page, 2);
  assert.equal(await page.getByTestId('last-reasoning-tokens').innerText(), 'Not reported');
  assert.equal(await page.getByTestId('reasoning-tokens').innerText(), '0');
  assert.ok(numeric(await page.getByTestId('ai-cost').innerText()) > 0);
  assert.deepEqual(setup.errors, []);
});

test('optimization switches give immediate next-request feedback without inventing costs or cache hits', async context => {
  const setup = await fixture({ width: 390, height: 844 });
  context.after(setup.close);
  const { page } = setup;
  assert.equal(await page.getByTestId('compression-next').innerText(), 'Cell JSON next');
  assert.equal(await page.getByTestId('cache-next').innerText(), 'Full input next');
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Cache off');
  setup.controls.hold = true;
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
  await setup.waitForCalls(1);
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).check();
  assert.equal(await page.getByTestId('compression-next').innerText(), 'Packed rows next');
  assert.equal(await page.getByTestId('cache-next').innerText(), 'Reuse rules next');
  for (const id of ['ai-cost', 'ai-savings', 'compression-adjustment', 'cache-adjustment', 'unoptimized-cost']) assert.equal(numeric(await page.getByTestId(id).textContent()), 0);
  assert.equal(await page.getByTestId('cache-totals').innerText(), '0 hits / 0 misses');
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Checking cache');
  assert.equal(await page.getByRole('button', { name: 'Inspect cached instructions', exact: true }).isEnabled(), false);
  assert.equal(await page.getByRole('button', { name: 'Inspect last prompt', exact: true }).isEnabled(), false);
  assert.equal(setup.calls.length, 1);
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).uncheck();
  assert.equal(await page.getByTestId('compression-next').innerText(), 'Cell JSON next');
  assert.equal(await page.getByTestId('cache-next').innerText(), 'Full input next');
  assert.equal(setup.calls.length, 1);
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).uncheck();
  setup.release();
  await waitRequests(page, 1);
  assert.deepEqual(setup.errors, []);
});

for (const scenario of [
  { name: 'Luna only', options: {} },
  { name: 'Compression', options: { compression: true } },
  { name: 'Cache', options: { cache: true } },
  { name: 'Reasoning', options: { reasoning: true } },
  { name: 'MCP', options: { mcp: true } },
  { name: 'all options', options: { compression: true, cache: true, reasoning: true, mcp: true } },
]) {
  test(`Ask Luna plays an entire standard game starting with ${scenario.name}`, { timeout: 60000 }, async context => {
    const options = { compression: false, cache: false, reasoning: false, mcp: false, ...scenario.options };
    const setup = await fixture(undefined, true, false, options);
    context.after(setup.close);
    const { page } = setup;
    setup.controls.firstPlacement = true;
    const run = setup.player().runId;
    await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
    await page.waitForFunction(() => document.querySelector('.game-canvas')?.getAttribute('data-status') === 'over' || document.querySelector('[data-testid="game-status"]')?.textContent === 'Luna paused', null, { timeout: 55000 });
    let beforeRecovery = Infinity;
    if (setup.player().game.status !== 'over') {
      assert.match(await page.locator('.notice').innerText(), /per-request cap/);
      assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
      assert.equal(await page.locator('.luna-controls input:enabled').count(), 5);
      beforeRecovery = setup.calls.length;
      assert.equal(setup.player().metrics.requests, beforeRecovery);
      assert.equal(setup.application.room.usage(setup.player()).unmeteredRequests, 0);
      await page.getByRole('checkbox', { name: 'Compression', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Reasoning', exact: true }).uncheck();
      await page.getByRole('checkbox', { name: 'MCP', exact: true }).uncheck();
      await page.getByRole('heading', { name: 'Game over', exact: true }).waitFor({ timeout: 30000 });
    }
    await setup.waitForGame(game => game.status === 'over');
    const requests = setup.calls.length;
    const metrics = setup.player().metrics;
    context.diagnostic(`${scenario.name}: ${requests} placements; ${beforeRecovery === Infinity ? 'no request-cap interruption' : `request-cap recovery after ${beforeRecovery} requests`}`);
    assert.ok(requests >= 5);
    assert.equal(setup.player().runId, run);
    assert.equal(setup.player().record.token_limit, 1000000);
    assert.equal(setup.player().game.pieces, requests);
    assert.equal(metrics.requests, requests);
    for (const [index, call] of setup.calls.entries()) {
      const expected = index < beforeRecovery ? options : { compression: true, cache: options.cache, reasoning: Boolean(call.options.reasoning), mcp: Boolean(call.options.mcp) };
      assert.ok(!expected.reasoning || options.reasoning);
      assert.ok(!expected.mcp || options.mcp);
      assert.deepEqual(call.options, { ...expected, autopilot: true });
      assert.equal(call.usage.reasoning, expected.reasoning ? 256 : 0);
      assert.equal(call.prompt, expected.compression ? call.packed : call.verbose);
      assert.equal(call.mcpLookup?.transport, expected.mcp ? 'stdio' : undefined);
      assert.equal(call.mcpLookup?.tool, expected.mcp ? 'analyze_future_moves' : undefined);
    }
    if (beforeRecovery !== Infinity) assert.deepEqual(setup.calls.at(-1)!.options, { compression: true, cache: options.cache, reasoning: false, mcp: false, autopilot: true });
    assert.equal(metrics.reasoning, setup.calls.reduce((total, call) => total + call.usage.reasoning!, 0));
    assert.equal(metrics.cacheHits, options.cache ? requests - 1 : 0);
    assert.equal(metrics.cacheMisses, options.cache ? 1 : 0);
    assert.equal(metrics.cacheBypassed, options.cache ? 0 : requests);
    assert.equal(metrics.compressionSaved > 0, options.compression || beforeRecovery !== Infinity);
    const cost = costForUsage(metrics, setup.application.room.pricing.snapshot!.usdPerMillion).total;
    assert.ok(Math.abs(numeric(await page.getByTestId('ai-cost').innerText()) - cost) < 1e-8);
    const score = numeric(await page.getByTestId('game-score').innerText());
    assert.equal(score, setup.player().game.score);
    assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
    assert.equal(await page.locator('.luna-controls input:enabled').count(), 0);
    assert.equal(setup.controls.maxInFlight, 1);
    assert.ok(setup.admittedAt.slice(1).every((time, index) => time - setup.admittedAt[index] >= 1000));
    for (const viewport of [{ width: 320, height: 710 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.scrollTo(0, 0));
      const overlay = await page.locator('.gameover-overlay').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, children: [...element.children].map(child => {
          const rect = child.getBoundingClientRect();
          return { text: child.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        }) };
      });
      for (const child of overlay.children) assert.ok(child.left >= overlay.left - 1 && child.right <= overlay.right + 1 && child.top >= overlay.top - 1 && child.bottom <= overlay.bottom + 1, JSON.stringify({ scenario: scenario.name, viewport, overlay }));
      await page.screenshot({ path: path.join(screenshots, `game-over-${scenario.name.replaceAll(' ', '-').toLowerCase()}-${viewport.width}.png`), animations: 'disabled' });
    }
    await page.reload();
    await page.locator('.tetris-app[data-playing="true"]').waitFor();
    await page.getByRole('heading', { name: 'Game over', exact: true }).waitFor();
    assert.equal(numeric(await page.getByTestId('game-score').innerText()), score);
    assert.equal(numeric(await page.getByTestId('ai-requests').innerText()), requests);
    assert.equal(await page.locator('.luna-controls input:enabled').count(), 0);
    await page.getByRole('button', { name: 'Play again', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.game-canvas')?.getAttribute('data-status') === 'playing');
    assert.notEqual(setup.player().runId, run);
    assert.equal(numeric(await page.getByTestId('game-score').innerText()), 0);
    assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
    assert.equal(await page.locator('.luna-controls input:disabled').count(), 4);
    assert.equal(setup.player().record.best_score, score);
    assert.equal(setup.calls.length, requests);
    assert.deepEqual(setup.errors, []);
  });
}

test('a Luna-selected Hold is executed and synchronized as one placement without a substitute move', async context => {
  const setup = await fixture(undefined, true, false, { compression: true });
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  setup.controls.chooseHold = true;
  const original = setup.player().game.piece;
  const next = setup.player().game.queue.peek()[0];
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
  assert.deepEqual(setup.calls[0].options, { compression: false, cache: false, reasoning: false, mcp: false, autopilot: true });
  assert.match(await page.getByTestId('request-status').innerText(), /Verbose \/ cache off/);
  assert.equal(await page.getByTestId('compression-next').innerText(), 'Packed rows next');
  assert.equal(await page.getByTestId('cache-next').innerText(), 'Reuse rules next');
  assert.equal(numeric(await page.getByTestId('ai-cost').textContent()), 0);
  assert.equal(await page.getByTestId('cache-totals').innerText(), '0 hits / 0 misses');
  assert.equal(await page.getByTestId('cache-result-label').innerText(), 'Checking cache');
  setup.release();
  await waitPieces(page, 1);
  await setup.waitForCalls(2);
  assert.deepEqual(setup.calls[1].options, { compression: true, cache: true, reasoning: false, mcp: false, autopilot: true });
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
  const costBeforeSwitches = await page.getByTestId('ai-cost').textContent();
  await page.getByRole('checkbox', { name: 'Compression', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Cache', exact: true }).uncheck();
  assert.equal(await page.getByTestId('ai-cost').textContent(), costBeforeSwitches);
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
  assert.equal(await page.getByRole('checkbox', { name: 'Compression', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Cache', exact: true }).isDisabled(), true);
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

test('prompt inspection preserves Luna selection, freezes receipts and resumes on close', async context => {
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
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-pieces'), '1');
  await page.getByRole('button', { name: 'Close prompt', exact: true }).click();
  await setup.waitForCalls(3);
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Inspect last prompt', exact: true }).click();
  assert.equal(await page.getByTestId('sent-prompt').textContent(), setup.calls[1].prompt);
  assert.equal(await page.getByTestId('compression-before').locator('pre').textContent(), setup.calls[1].verbose);
  assert.match(await page.getByTestId('compression-verdict').textContent() ?? '', /Compression was ON/);
  await page.getByRole('button', { name: 'Close prompt', exact: true }).click();
  setup.release();
  await waitRequests(page, 3);
  assert.equal(setup.calls.length, 3);
  assert.deepEqual(setup.errors, []);
});

test('cache activity runs live and preserves selected hits and misses as later replies arrive', { timeout: 18000 }, async context => {
  const setup = await fixture(undefined, true, false, { compression: true, cache: true });
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
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
  const setup = await fixture(undefined, true, false, { cache: true });
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
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
  await page.getByRole('alert').filter({ hasText: 'Test model unavailable.' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).uncheck();
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
  const setup = await fixture(undefined, true, false, { compression: true, cache: true });
  context.after(setup.close);
  const { page } = setup;
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
  await page.getByRole('alert').filter({ hasText: 'Test model unavailable.' }).waitFor();
  await page.getByText('AI COST / PENDING USAGE', { exact: true }).waitFor();
  assert.equal(player.record.attempts, 1);
  assert.equal(player.metrics.requests, 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
  await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).uncheck();
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

test('returning sentence sessions retain their blocks, costs and options on restart', async context => {
  const setup = await fixture(undefined, true, false, { compression: true, cache: true });
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
  assert.deepEqual(setup.player().game.tokens, gameTokens('old token pieces'));
  assert.equal(setup.player().record.token_text, 'old token pieces');
  await waitRequests(page, 1);
  const cost = await page.getByTestId('ai-cost').textContent();
  assert.equal(await page.getByTestId('cache-unclassified').textContent(), '1 earlier request unclassified');
  assert.equal(await page.getByTestId('cache-totals').textContent(), '0 hits / 0 misses');
  assert.equal(await page.getByRole('checkbox', { name: 'Cache', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Compression', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-status'), 'paused');
  const run = setup.player().runId;
  setup.player().started -= 3000;
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.game-canvas')?.getAttribute('data-status') === 'playing');
  await page.reload();
  await page.locator('.tetris-app[data-playing="true"]').waitFor();
  assert.notEqual(setup.player().runId, run);
  assert.deepEqual(setup.player().game.tokens, gameTokens('old token pieces'));
  assert.equal(await page.getByTestId('ai-cost').textContent(), cost);
  assert.equal(await page.getByRole('checkbox', { name: 'Cache', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Compression', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), false);
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('hidden tabs and reconnects preserve Luna without dropping charged usage or applying stale moves', { timeout: 20000 }, async context => {
  for (const transition of ['hidden', 'disconnect']) await context.test(transition, async child => {
    const setup = await fixture();
    child.after(setup.close);
    const { page } = setup;
    setup.controls.hold = true;
    await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).check();
    await setup.waitForCalls(1);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    if (transition === 'disconnect') for (const socket of setup.application.io.sockets.sockets.values()) socket.conn.close();
    setup.release();
    await page.locator('.tetris-app[data-playing="true"]').waitFor();
    await waitRequests(page, 1);
    assert.equal(await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).isChecked(), true);
    assert.equal(setup.player().game.pieces, 0);
    assert.equal(setup.player().metrics.requests, 1);
    assert.equal(setup.calls.length, 1);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await setup.waitForCalls(2);
    setup.release();
    await waitPieces(page, 1);
    await page.getByRole('checkbox', { name: 'Ask Luna', exact: true }).uncheck();
    assert.equal(setup.controls.maxInFlight, 1);
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
      const typography = [...document.querySelectorAll<HTMLElement>('.game-switch')].map(element => ({ name: element.querySelector('input')?.getAttribute('aria-label'), fontSize: parseFloat(getComputedStyle(element).fontSize), detailSize: element.querySelector('small') ? parseFloat(getComputedStyle(element.querySelector('small')!).fontSize) : null, clipped: element.scrollWidth > element.clientWidth + 1 }));
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, boxes, colors: colors.size, targets, typography };
    });
    assert.ok(layout.documentWidth <= layout.width, JSON.stringify(layout));
    for (const box of layout.boxes) assert.ok(box.top >= 0 && box.bottom <= layout.height + 1 && box.left >= 0 && box.right <= layout.width && !box.clipped, JSON.stringify({ viewport, box }));
    for (const target of layout.targets) assert.ok(target.width >= 44 && target.height >= 44, JSON.stringify({ viewport, target }));
    for (const text of layout.typography) assert.ok(text.fontSize >= 12 && !text.clipped && (text.detailSize === null || text.detailSize >= (viewport.width <= 480 ? 10 : 9)), JSON.stringify({ viewport, text }));
    assert.ok(layout.colors > 4, 'The canvas must contain visible board and piece pixels');
    await page.screenshot({ path: path.join(screenshots, `tetris-${viewport.width}.png`), animations: 'disabled' });
  }
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});