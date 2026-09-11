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
import { PLAYER_TOKEN_BUDGET, PREFIX_TOKENS, RequestError } from '../server/model.ts';
import type { ModelGateway } from '../server/model.ts';
import { buildPrompts, gameTokens, tokenChips } from '../server/tokens.ts';
import { placementsFor, tokenLabel } from '../shared/game.ts';
import { costForUsage } from '../shared/protocol.ts';
import type { AiOptions, Usage } from '../shared/protocol.ts';

let browser: Browser;
const screenshots = path.resolve('data/token-game-qa');
before(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  mkdirSync(screenshots, { recursive: true });
});
after(async () => { await browser?.close(); });

async function fixture(viewport = { width: 1440, height: 1000 }) {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'tokenfall-ui-'));
  const controls = { hold: false, invalid: false, fail: false, firstPlacement: false, inFlight: 0, maxInFlight: 0 };
  const requestEvents = new EventEmitter();
  const releases: (() => void)[] = [];
  const calls: { options: AiOptions; started: number; usage: Usage }[] = [];
  let cacheWarm = false;
  const gateway: ModelGateway = { complete: async (game, options) => {
    controls.inFlight += 1;
    controls.maxInFlight = Math.max(controls.maxInFlight, controls.inFlight);
    const invalid = controls.invalid;
    const fail = controls.fail;
    const placements = placementsFor(game);
    const selected = controls.firstPlacement ? placements[0] : [...placements].sort((first, second) => first.holes - second.holes || second.clearedLines - first.clearedLines || first.aggregateHeight - second.aggregateHeight)[0];
    const prompts = buildPrompts(game, placements);
    const input = PREFIX_TOKENS + (options.compression ? prompts.packedTokens : prompts.rawTokens);
    const cached = options.cache && cacheWarm ? PREFIX_TOKENS : 0;
    const usage = { input, output: 20, cached, cacheWrites: options.cache && !cacheWarm ? PREFIX_TOKENS : 0, total: input + 20, reasoning: 0 };
    if (options.cache) cacheWarm = true;
    calls.push({ options: { ...options }, started: Date.now(), usage });
    const pieceId = game.pieceId;
    try {
      const pending = controls.hold ? new Promise<void>(resolve => releases.push(resolve)) : null;
      requestEvents.emit('request');
      if (pending) await pending;
      if (fail) throw new RequestError('Browser fixture unavailable.', 'unavailable');
      return {
        id: randomUUID(), pieceId, status: invalid ? 'invalid' : 'ready',
        placement: invalid ? null : { column: selected.column, row: selected.row, rotation: selected.rotation },
        tip: 'Browser fixture, not a live model.', usage, latencyMs: 45,
        rawTokens: prompts.rawTokens, packedTokens: prompts.packedTokens,
        savedTokens: options.compression ? prompts.rawTokens - prompts.packedTokens : 0,
        compression: options.compression, cacheEnabled: options.cache,
        prompt: options.compression ? prompts.packed : prompts.verbose, outputText: '{}',
        inputChips: [], outputChips: tokenChips('{}'),
      };
    } finally { controls.inFlight -= 1; }
  } };
  const application = createApplication({ port: 0, endpoint: 'https://fixture.invalid', deployment: 'gpt-5.6-luna', tenantId: 'fixture', dataDirectory }, gateway);
  const admittedAt: number[] = [];
  const acquire = application.room.gate.acquire.bind(application.room.gate);
  application.room.gate.acquire = (...args) => {
    const release = acquire(...args);
    admittedAt.push(args[4] ?? Date.now());
    return release;
  };
  application.room.pricing = { status: 'live', snapshot: {
    model: 'gpt-5.6-luna', region: 'eastus2', sku: 'GlobalStandard', currency: 'USD',
    usdPerMillion: { input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20 },
    checkedAt: new Date().toISOString(), sourceUrl: 'https://prices.azure.com/api/retail/prices',
    meters: Object.fromEntries(['input', 'cachedInput', 'cacheWrite', 'output'].map(key => [key, { id: key, name: `Test ${key}`, effectiveFrom: '2026-08-01T00:00:00Z' }])) as Record<'input' | 'cachedInput' | 'cacheWrite' | 'output', { id: string; name: string; effectiveFrom: string }>,
  } };
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address() as { port: number };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    const state = globalThis as typeof globalThis & { tokenPaints: string[] };
    state.tokenPaints = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, left, top, maxWidth) {
      if (!state.tokenPaints.includes(text)) state.tokenPaints.push(text);
      if (maxWidth === undefined) original.call(this, text, left, top);
      else original.call(this, text, left, top, maxWidth);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  return {
    page, controls, calls, application, errors, admittedAt,
    player: () => [...application.room.players.values()][0],
    waitForCalls: async (count: number) => { while (calls.length < count) await once(requestEvents, 'request', { signal: AbortSignal.timeout(8000) }); },
    release: () => { const release = releases.shift(); assert.ok(release, 'Expected a pending model fixture'); release(); },
    close: async () => { controls.hold = false; releases.splice(0).forEach(release => release()); await context.close(); await application.close(); rmSync(dataDirectory, { recursive: true, force: true }); },
  };
}

async function start(page: Page, text = 'hello world!') {
  await page.getByLabel('Text to turn into blocks', { exact: true }).fill(text);
  await page.getByLabel('Player name', { exact: true }).fill('Browser Player');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await page.locator('.game-canvas').waitFor();
  await page.locator('.scoreboard button[aria-label="Pause game"]').click();
}

async function waitPieces(page: Page, minimum: number) {
  await page.waitForFunction(expected => Number.parseInt(document.querySelector('[data-testid="piece-count"]')?.textContent ?? '0', 10) >= expected, minimum);
}

test('review 1: pre-game real tokens become labeled active, next, held and locked pieces', { timeout: 30000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  const text = 'antidisestablishmentarianism hello world!';
  const tokens = gameTokens(text);
  await page.getByLabel('Text to turn into blocks', { exact: true }).fill(text);
  await page.waitForFunction(count => document.querySelector('.setup-count strong')?.textContent === `${count} tokens = ${count} pieces`, tokens.length);
  assert.equal(await page.locator('.token-piece-stream li').count(), tokens.length);
  assert.deepEqual(await page.locator('.token-piece-stream li').evaluateAll(items => items.map(item => ({ id: Number(item.getAttribute('data-token-id')), text: item.getAttribute('data-token-text') }))), tokens);
  assert.equal(setup.calls.length, 0);
  await page.screenshot({ path: path.join(screenshots, 'setup-desktop.png'), fullPage: true, animations: 'disabled' });
  await start(page, text);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-active-token'), tokenLabel(tokens[0].text));
  assert.equal(await page.locator('.next-piece .preview-token').first().innerText(), tokenLabel(tokens[1].text));
  await page.locator('.scoreboard button[aria-label="Resume game"]').click();
  for (let step = 0; step < 6; step += 1) await page.keyboard.press('ArrowDown');
  await page.locator('.board-interior').screenshot({ path: path.join(screenshots, 'labeled-falling-piece.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Hold current piece', exact: true }).click();
  await page.locator('.control-hardDrop').click();
  await page.locator('.scoreboard button[aria-label="Pause game"]').click();
  await waitPieces(page, 1);
  assert.equal(await page.locator('.hold-slot .preview-token').innerText(), tokenLabel(tokens[0].text));
  const paints = await page.evaluate(() => (globalThis as typeof globalThis & { tokenPaints: string[] }).tokenPaints);
  assert.ok(paints.includes(tokenLabel(tokens[0].text)), 'Active token text must actually be painted on the canvas');
  assert.ok(paints.includes(tokenLabel(tokens[1].text)), 'Held/swapped token must be painted on the canvas');
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('review 2: editing tokens is pre-run only and reconnect preserves text and allowance', { timeout: 30000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  await start(page);
  const player = setup.player();
  player.metrics.input = 1234;
  setup.application.room.save(player);
  await page.reload();
  await page.locator('.game-canvas').waitFor();
  assert.equal(setup.application.room.players.size, 1);
  assert.equal(player.record.token_text, 'hello world!');
  if (await page.locator('.scoreboard button[aria-label="Pause game"]').count()) await page.locator('.scoreboard button[aria-label="Pause game"]').click();
  player.started -= 3000;
  await page.getByRole('button', { name: 'Edit text for next run', exact: true }).click();
  await page.getByLabel('Text to turn into blocks', { exact: true }).fill('Discarded draft');
  await page.getByRole('button', { name: 'Keep current run', exact: true }).click();
  assert.equal(player.record.token_text, 'hello world!');
  await page.getByRole('button', { name: 'Edit text for next run', exact: true }).click();
  assert.equal(await page.getByLabel('Text to turn into blocks', { exact: true }).inputValue(), 'hello world!');
  await page.getByLabel('Text to turn into blocks', { exact: true }).fill('New tokens, new shapes.');
  await page.getByRole('button', { name: 'Start new token run', exact: true }).click();
  await page.locator('.game-canvas').waitFor();
  assert.equal(player.record.token_text, 'New tokens, new shapes.');
  assert.equal(player.metrics.input, 1234);
  assert.equal(await page.locator('.game-canvas').getAttribute('data-active-token'), tokenLabel(gameTokens(player.record.token_text)[0].text));
  await page.locator('.scoreboard button[aria-label="Pause game"]').click();
  assert.deepEqual(setup.errors, []);
});

test('review 3: live mode switches affect only the next request and stopping prevents a late automatic move', { timeout: 30000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  await start(page);
  const lab = page.locator('.token-lab');
  await lab.getByRole('checkbox', { name: 'Compress prompts' }).check();
  await lab.getByRole('checkbox', { name: 'Luna autopilot' }).check();
  await page.waitForFunction(() => document.querySelector('.token-lab [data-testid="inflight-options"]')?.textContent?.startsWith('In flight: packed, cache off.'));
  await setup.waitForCalls(1);
  assert.equal(setup.calls.length, 1);
  await lab.getByRole('checkbox', { name: 'Compress prompts' }).uncheck();
  await lab.getByRole('checkbox', { name: 'Cache prefix', exact: true }).check();
  assert.deepEqual(setup.calls[0].options, { compression: true, cache: false, autopilot: true });
  setup.release();
  await waitPieces(page, 1);
  await page.waitForFunction(() => document.querySelector('.token-lab [data-testid="inflight-options"]')?.textContent?.startsWith('In flight: verbose, cache on.'));
  await setup.waitForCalls(2);
  assert.equal(setup.calls.length, 2);
  assert.deepEqual(setup.calls[1].options, { compression: false, cache: true, autopilot: true });
  assert.ok(setup.admittedAt[1] - setup.admittedAt[0] >= 1000);
  await page.getByRole('button', { name: 'Stop AI', exact: true }).click();
  setup.release();
  await page.waitForFunction(() => document.querySelectorAll('.request-history tbody tr').length === 2);
  assert.equal(await page.getByTestId('piece-count').innerText(), '1 placed');
  assert.equal(await lab.getByRole('checkbox', { name: 'Luna autopilot' }).isChecked(), false);
  assert.equal(setup.controls.maxInFlight, 1);
  assert.equal(setup.player().metrics.requests, 2);
  await lab.getByRole('button', { name: 'Play move', exact: true }).click();
  await waitPieces(page, 2);
  assert.equal(setup.calls.length, 2);
  assert.deepEqual(setup.errors, []);
});

test('review 4: repeated autopilot moves retain real pricing, stop at budget/error, and never fake usage', { timeout: 40000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  await start(page);
  const lab = page.locator('.token-lab');
  await lab.getByRole('checkbox', { name: 'Compress prompts' }).check();
  await lab.getByRole('checkbox', { name: 'Cache prefix', exact: true }).check();
  await lab.getByRole('checkbox', { name: 'Luna autopilot' }).check();
  await waitPieces(page, 3);
  await page.getByRole('button', { name: 'Stop AI', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.loading-spinner'));
  await page.waitForFunction(() => Number.parseInt(document.querySelector('.your-entry .entry-name > span')?.textContent ?? '0', 10) === Number.parseInt(document.querySelector('[data-testid="base-score"]')?.textContent ?? '-1', 10));
  const player = setup.player();
  const rates = setup.application.room.pricing.snapshot!.usdPerMillion;
  const expected = setup.calls.reduce((sum, call) => sum + costForUsage(call.usage, rates).total, 0);
  assert.ok(Math.abs(setup.application.room.view().leaderboard[0].costUsd! - expected) < 1e-10);
  assert.ok(player.metrics.cached > 0);
  assert.ok(player.metrics.compressionSaved > 0);
  assert.equal(setup.controls.maxInFlight, 1);
  await page.screenshot({ path: path.join(screenshots, 'autopilot-desktop.png'), fullPage: true, animations: 'disabled' });
  const beforeBudget = setup.calls.length;
  player.metrics.input = PLAYER_TOKEN_BUDGET + player.metrics.cached - 500;
  setup.application.room.save(player);
  await lab.getByRole('checkbox', { name: 'Luna autopilot' }).check();
  await page.waitForFunction(() => document.querySelector('.token-lab [data-testid="pilot-status"]')?.textContent?.includes('Not enough token credits'));
  assert.equal(await lab.getByRole('checkbox', { name: 'Luna autopilot' }).isChecked(), false);
  assert.equal(setup.calls.length, beforeBudget);
  player.metrics.input = player.metrics.cached + player.metrics.cacheWrites;
  setup.application.room.save(player);
  setup.controls.invalid = true;
  const beforeInvalid = player.game.pieces;
  await lab.getByRole('checkbox', { name: 'Luna autopilot' }).check();
  await page.waitForFunction(() => document.querySelector('.token-lab [data-testid="pilot-status"]')?.textContent?.includes('could not be applied'));
  assert.equal(player.game.pieces, beforeInvalid);
  assert.equal(await lab.getByRole('checkbox', { name: 'Luna autopilot' }).isChecked(), false);
  setup.controls.invalid = false;
  setup.controls.fail = true;
  await lab.getByRole('checkbox', { name: 'Luna autopilot' }).check();
  await page.waitForFunction(() => document.querySelector('.token-lab [data-testid="pilot-status"]')?.textContent?.includes('Browser fixture unavailable'));
  assert.equal(setup.application.room.view().leaderboard[0].challengeScore, null);
  assert.equal(setup.application.room.view().leaderboard[0].unmeteredRequests, 1);
  assert.deepEqual(setup.errors, []);
});

test('review 5: mobile setup, labeled canvas, rules and controls remain readable and keyboard accessible', { timeout: 35000 }, async context => {
  const setup = await fixture({ width: 390, height: 844 });
  context.after(setup.close);
  const { page } = setup;
  await page.getByLabel('Text to turn into blocks', { exact: true }).fill('');
  await page.waitForFunction(() => document.querySelector('.setup-count strong')?.textContent === '0 tokens = 0 pieces');
  assert.equal(await page.getByRole('button', { name: 'Start game', exact: true }).isEnabled(), false);
  await start(page, 'Hello\nworld!');
  for (const width of [320, 375, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.game-canvas')!;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set<string>();
      for (let offset = 0; offset < pixels.length; offset += 16) colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
      const clipped = [...document.querySelectorAll<HTMLElement>('.preview-token, .token-run-heading strong, .pilot-status, .request-option-note')].filter(element => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1).map(element => element.textContent);
      return { viewport: innerWidth, width: document.documentElement.scrollWidth, colors: colors.size, clipped };
    });
    assert.ok(layout.width <= layout.viewport, JSON.stringify(layout));
    assert.ok(layout.colors > 4);
    assert.deepEqual(layout.clipped, []);
    if (width === 320) await page.screenshot({ path: path.join(screenshots, 'token-mobile.png'), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Token lab', exact: true }).click();
  await page.getByRole('tab', { name: 'Token stream', exact: true }).click();
  assert.equal(await page.locator('.token-lab .token-piece-stream li').count(), gameTokens('Hello\nworld!').length);
  await page.getByRole('button', { name: 'Toggle color theme' }).click();
  await page.screenshot({ path: path.join(screenshots, 'stream-mobile-dark.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.locator('#game-rules').waitFor();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.locator('.scoreboard button[aria-label="Resume game"]').click();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await page.locator('.control-hardDrop').click();
  await waitPieces(page, 1);
  await page.locator('.scoreboard button[aria-label="Pause game"]').click();
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('autopilot stops on hidden-page transitions and ignores the pending move', { timeout: 20000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  await start(page);
  const lab = page.locator('.token-lab');
  await lab.getByRole('checkbox', { name: 'Compress prompts' }).check();
  await lab.getByRole('checkbox', { name: 'Luna autopilot' }).check();
  await page.waitForFunction(() => document.querySelector('.token-lab [data-testid="inflight-options"]')?.textContent?.startsWith('In flight:'));
  await setup.waitForCalls(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  setup.release();
  await page.waitForFunction(() => document.querySelectorAll('.request-history tbody tr').length === 1);
  assert.equal(await lab.getByRole('checkbox', { name: 'Luna autopilot' }).isChecked(), false);
  assert.equal(setup.player().game.pieces, 0);
  assert.equal(setup.player().metrics.requests, 1);
  assert.deepEqual(setup.errors, []);
});

test('returning classic players must configure real token pieces before the next run', { timeout: 20000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  const joined = setup.application.room.join('Legacy Player', setup.application.room.code, undefined, 'legacy-socket');
  const player = setup.application.room.playerFor('legacy-socket');
  player.record.best_score = 150;
  player.metrics.input = 1234;
  player.started -= 3000;
  setup.application.room.disconnect('legacy-socket');
  await page.evaluate(session => sessionStorage.setItem('tokenfall-session', JSON.stringify(session)), { token: joined.token, name: 'Legacy Player', room: setup.application.room.code });
  await page.reload();
  await page.getByRole('button', { name: 'Start new token run', exact: true }).waitFor();
  assert.equal(await page.locator('.game-canvas').count(), 0);
  await page.getByLabel('Text to turn into blocks', { exact: true }).fill('Legacy tokens now fall.');
  await page.getByRole('button', { name: 'Start new token run', exact: true }).click();
  await page.locator('.game-canvas').waitFor();
  assert.equal(player.record.best_score, 150);
  assert.equal(player.metrics.input, 1234);
  assert.deepEqual(player.game.tokens, gameTokens('Legacy tokens now fall.'));
  assert.deepEqual(setup.errors, []);
});

test('disconnect stops autopilot, preserves charged usage, and reconnect never restarts AI by itself', { timeout: 25000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  setup.controls.hold = true;
  await start(page);
  const lab = page.locator('.token-lab');
  await lab.getByRole('checkbox', { name: 'Compress prompts' }).check();
  await lab.getByRole('checkbox', { name: 'Luna autopilot' }).check();
  await page.waitForFunction(() => document.querySelector('.token-lab [data-testid="inflight-options"]')?.textContent?.startsWith('In flight:'));
  await setup.waitForCalls(1);
  const player = setup.player();
  const playerId = player.record.id;
  for (const socket of setup.application.io.sockets.sockets.values()) socket.conn.close();
  setup.release();
  await page.waitForFunction(() => document.querySelector('.token-lab [data-testid="session-cost"]')?.textContent !== '$0.000000' && document.querySelector('.game-canvas') && document.querySelector('.connection-label')?.textContent === 'Connected');
  assert.equal(await lab.getByRole('checkbox', { name: 'Luna autopilot' }).isChecked(), false);
  assert.equal(player.record.id, playerId);
  assert.equal(player.metrics.requests, 1);
  assert.equal(player.game.pieces, 0);
  assert.equal(setup.calls.length, 1);
  assert.equal(setup.application.room.players.size, 1);
  assert.deepEqual(setup.errors, []);
});

test('game over stops autopilot without automatically restarting or making another request', { timeout: 20000 }, async context => {
  const setup = await fixture();
  context.after(setup.close);
  const { page } = setup;
  await start(page, '!');
  const player = setup.player();
  player.game.act('resume');
  for (let index = 0; index < 19; index += 1) player.game.act('hardDrop');
  assert.equal(player.game.status, 'playing');
  assert.equal(player.game.pieces, 19);
  player.game.act('pause');
  setup.controls.hold = true;
  setup.controls.firstPlacement = true;
  await page.reload();
  await page.locator('.game-canvas').waitFor();
  const lab = page.locator('.token-lab');
  await lab.getByRole('checkbox', { name: 'Compress prompts' }).check();
  await lab.getByRole('checkbox', { name: 'Luna autopilot' }).check();
  await page.waitForFunction(() => document.querySelector('.token-lab [data-testid="inflight-options"]')?.textContent?.startsWith('In flight:'));
  await setup.waitForCalls(1);
  setup.release();
  await page.waitForFunction(() => document.querySelector('.token-lab [data-testid="pilot-status"]')?.textContent === 'Run complete');
  await page.getByRole('button', { name: 'Play again', exact: true }).waitFor();
  assert.equal(await lab.getByRole('checkbox', { name: 'Luna autopilot' }).isChecked(), false);
  assert.equal(setup.calls.length, 1);
  assert.equal(player.metrics.requests, 1);
  assert.deepEqual(setup.errors, []);
});