# Tetris With Luna

A normal, untimed Tetris game with a shared room and live leaderboard. Join by name with sentence-based blocks or randomized classic seven-bag pieces. Both modes keep SRS rotation, hold, next pieces, a ghost, line clears, levels, and standard scoring. There are no timed rounds, lessons, or projector screens.

## Play

- Enter a name and sentence in **Join game**. The free preview uses actual `o200k_base` tokens; each token ID maps to one of the seven shapes, and the sequence repeats. Token fragments stay attached to falling, held, queued, and settled pieces. Choose **Classic** for ordinary seven-bag pieces. Text is limited to 500 characters and 256 tokens.
- **Leaderboard** defaults to best Tetris points, including manual players. **Points / cent** uses best points divided by estimated total session spend in US cents. Zero spend, missing prices, and incomplete usage are unranked in that view. Both lists are selected independently by the server, with up to 50 entries, ten per page, and a shortcut to your own position.
- **Share game** exposes the room link without a session credential. Anyone opening it can join under their own name while a seat is available. Rankings remain visible beside the game on wide screens and below it on phones; the trophy button pauses play and opens the rankings.
- **Change sentence** starts a new run without resetting best score, reported AI spend, or cache/compression preferences. Reloading or reconnecting retains the current sentence and game; Luna never restarts automatically. The sentence itself is private and is not included in public rankings or model prompts.
- Play manually with the keyboard or touch controls. Manual play makes no model calls.
- Turn on **Ask Luna** to let GPT-5.6 Luna play continuously. It selects and applies legal moves until game over, Stop, a service error, or a service spending safeguard. It does not buy a single hint or require a separate Play move action.
- **Reasoning**, directly below Ask Luna, opts into low reasoning effort. It defaults off and applies to the next request; changing it never starts Luna or changes an in-flight request. The counters show the provider-reported session total and last reply's reasoning tokens, with Pending or Not reported instead of guessed counts. Totals and the preference survive reloads and new games; last-reply details are available only since page load. Reasoning can increase latency and output cost, and its tokens are already included in the main cost and token totals.
- Toggle **Compression** and **Cache** while Luna plays. Each switch immediately shows the next request's encoding/reuse mode; the in-flight line keeps the current request's original settings. Changing settings does not reprice past spend or make a model call.
- The cost ticker shows session AI cost, tokens, requests, and separate signed adjustments: compression savings are negative, cache reads reduce cost, and cache-write premiums can add cost. The before-optimizations estimate plus both adjustments reconciles to the reported-usage cost. Restarting preserves accumulated spend and cache counters.
- **Inspect last prompt** opens **Compression before / after**: both exact encodings of the same board, their token counts, and the reduction. The popup marks which version was sent; an uncompressed request's packed alternative is not treated as billed savings. It pauses play and stops Luna; both snapshots stay fixed if an already-started reply arrives. Inspection is free and never resumes AI automatically.
- The history icon opens **Cache activity**, a running list of the latest 20 replies received since this page loaded. It keeps updating while Luna plays, with a Stop control inside the popup. Each reply can be selected to see exactly which instruction text was reused, written, or not reused. Earlier selected details do not jump to the newest reply.

| Action | Keyboard |
| --- | --- |
| Move | Left / Right |
| Soft drop | Down |
| Hard drop | Space |
| Rotate clockwise | Up / X |
| Rotate counterclockwise | Z |
| Hold | C / Shift |
| Pause / Resume | P / Escape |

Luna waits for each response with the board paused, then applies the verified move. Turning it off, hiding the page, or disconnecting prevents late responses from moving pieces. Already-started requests can still be charged. Reloading never silently restarts AI. Model choices and latency are not guaranteed.

### Pure Luna Decisions

Luna is the sole strategy selector. The full 10-by-22 board is sent first, with hidden rows 0-1 and visible rows 2-21. Every request includes all 220 settled cells, including empty spaces and buried holes. With compression on, these same cells are encoded as 22 strings of exactly 10 characters; no rows are cropped or summarized. With compression off, every cell has an explicit row, column, and value.

Positions use `[column,row]` order. `active.cells` contains the four actual falling-cell positions, `active.hardDropCells` its ghost landing, and each candidate's `cells` its four final positions before line clearing. Origin and rotation remain available, but Luna no longer needs to infer occupied squares from them. The request also includes the next five pieces, held piece, Hold availability, pieces placed, cleared lines, score, and all generated legal placements. Hold-and-place choices are included whenever available. The browser executes the exact path for Luna's returned placement ID; there is no ranked solver, replacement move, strategic pruning, automatic rescue, or reset.

The engine supplies factual single-placement outcomes: cleared lines, holes, ten column heights, total/max height, bumpiness, and whether that placement would immediately end the game. It also supplies the current board profile so Luna can compare changes. These are rule calculations, not a multi-move search or a recommended move. Luna itself considers the preview and Hold alternatives. Invalid model choices stop AI and retain their reported cost.

The full-board policy in [server/policy.md](server/policy.md) uses cache version 4. Its instructions emphasize reading the lowest occupied rows and accessible gaps, comparing exact candidate cells, taking safe row clears, and avoiding tall stacks beside unused columns. The response schema stays identical between requests so variable legal-ID lists do not unnecessarily alter the cached prefix. IDs are checked against the actual candidate list after the response. Both board encodings contain the same candidates and position data; verbose cell JSON is compactly serialized to keep the complete choice list within the existing request guard. Reasoning defaults to `none`; the opt-in switch sends `low` without changing the policy, candidates, or move validation.

## Cost And Savings

The server obtains actual usage from Azure and refreshes matching USD Global Standard short-context rates from the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices) hourly. No fallback prices or cache hits are invented. The ticker labels stale rates and incomplete usage; it is a retail estimate, not an invoice.

```text
ordinary input = input - cached reads - cache writes
cost = (ordinary input * input rate
      + cached reads * read rate
      + cache writes * write rate
      + output * output rate) / 1,000,000
```

Compression losslessly packs the same board and legal moves into fewer tokens. Its savings use the actual prompt builder's local tokenizer estimates. Cache savings use provider-confirmed reads at the discounted rate, minus the premium for writes. A write alone can cost extra and is labeled accordingly. Enabling a switch is not itself a saving. Output, including reasoning, is new on every request and is billed once at the output rate. When reasoning is off, accepted moves still require a provider-confirmed zero reasoning count. With reasoning on, nonzero or unreported reasoning is allowed, but truncated replies and invalid moves are still rejected and their usage retained. Missing reasoning counts do not make otherwise reported output free.

Cache totals count completed cache-enabled requests: any confirmed reused input is a hit; no reused input is a miss, including cache writes. Cache-off requests and failures without usage are not misses. Counters survive reconnects, new games, and server restarts. Requests recorded before hit/miss tracking are labeled unclassified, without guessing their outcomes from aggregate token counts. The latest board summary and prompt snapshot describe the request actually sent, not whichever switches are selected afterward.

The inline **Latest cache result** names the reusable content: **Fixed Tetris instructions**. It shows the last reply's hit, miss, write, or cache-off outcome, the actual input tokens reused/written, and its signed cache-cost adjustment. **Board + next move** is labeled as fresh work. The previous receipt stays labeled **Last reply** while another request is in flight; toggling Cache does not turn it into a hit.

**Inspect cached instructions** opens **Cache activity**. Rows show each received reply's hit, miss/write, miss, or cache-off result, read/write token counts, and signed cost effect. Selecting a row shows its exact fixed instruction text and distinguishes that prefix from fresh board input and generated output. The provider reports token counts, not per-word offsets; the display does not invent word-level cache highlights or claim to enumerate the provider's cache storage.

The running log remains available across new games and reconnects in the same loaded page, but is bounded to 20 replies and clears on page reload. Persistent cost and hit/miss totals do not clear. Replies absent from the current page are not reconstructed, and failed calls without provider usage are shown as unknown rather than cache misses. Opening Cache activity pauses manual play, but deliberately leaves an already-running Luna session running; the popup has its own Stop button. Closing it does not start or resume AI.

The compression popup compares the exact verbose and packed strings that the gateway already computed for one board. Only the selected encoding was sent to the model, so returning the alternative as response metadata adds no inference request or input-token charge. Both contain the same 220 cells, active/ghost positions, and legal choices. On phones, the before/after panes stack and scroll within the popup rather than adding another game screen.

**Safeguards:** one request per player at a time; four concurrent room requests; a one-second minimum between automatic requests; 90 requests and 400,000 reserved tokens per minute; 2,000 attempts and 8,000,000 provider tokens per persisted room. Requests reserve full cache-miss usage plus headroom and the selected completion cap: 128 tokens with reasoning off or 2,048 tokens including reasoning and the visible answer with reasoning on. The 16,000-token reservation limit remains unchanged. Reasoning requests have a 60-second provider timeout versus 20 seconds without reasoning; the browser waits five seconds longer. A completion that exhausts its cap can be billable without yielding a move. Provider failures are not automatically retried. Classic games have no per-player request or token cutoff. Sentence games retain the existing 40-attempt and 160,000-fresh-token player limits; prior session usage counts, and changing sentences does not replenish them. These are service/spending guards, not gameplay timers or Azure billing caps. Failed requests can be billable even when usage is missing.

## Run Locally

Requires Node.js 24+, npm, and the existing Azure Luna deployment with Entra access. The checked-in native frontend build dependencies target Windows x64.

```powershell
npm ci
npm --prefix web ci
npm run build
npm start
```

Open http://127.0.0.1:3100. The server reads the selected azd environment and uses the signed-in Azure CLI credential locally. No API keys are required. If that port is occupied, choose another port with `PORT`; use a separate `DATA_DIRECTORY` when running a second server.

After frontend edits, run `npm --prefix web run build`. Server edits need a restart, or `npm run dev` for server watching. Compression/cache preferences and session recovery are scoped to the same browser tab. New visitors see the join form and leaderboard without occupying a player seat until they join. Returning visitors reconnect to their saved player without clearing sentence blocks.

## Deploy

The existing [azure.yaml](azure.yaml), [Dockerfile](Dockerfile), and [infra/hosting.bicep](infra/hosting.bicep) deploy the web service to Azure Container Apps. For an app-only update to an existing environment:

```powershell
azd deploy web --environment tokenfall-dev --no-prompt
```

Only provision when infrastructure changes are intended, and preview them first with `azd provision --preview`. Deploy between active games. Do not run `azd init` over the configured environment.

The image runs as non-root Node 24 and listens on port 3100. Managed identity provides registry pull and model inference access. Local databases, credentials, and environment files are excluded from the image. Hosting/storage charges are separate from the model-cost ticker.

Cloud state uses SQLite with `DELETE` journaling and full synchronization on the existing Azure Files mount. Keep one replica, one active revision, and no traffic splitting: this is a single-writer service. The mount's `nobrl` option and shared-key authentication are required by the existing Container Apps SMB setup; secure transfer remains enabled. Active boards do not survive a process restart, but recorded usage, best scores, sentences, and player credentials do. The restored browser no longer forces sentence-based sessions into classic games.

## Verify

```powershell
npm test
npm run build
npm --prefix web run lint
npm run test:ui
```

The backend suite covers normal rules, exact replay, no absolute game-clock cutoff, continuous AI admission, usage pricing, lossless compression, private usage delivery, persistence, and 50 socket clients. It also retains legacy-data compatibility checks.

Browser tests use `playwright-core` with installed Microsoft Edge and isolated rooms with explicitly synthetic model responses. They cover named joins, real sentence tokenization and labels, preview failures and retry, independent two-browser joins, live score/presence updates, ranking order and pagination, full-room and expired-session recovery, sentence privacy, and configuration errors. Existing checks cover a whole AI-controlled game, instant toggle feedback without phantom savings, signed cost reconciliation, write/read/miss counters, absent rates, exact before/after prompt equality, live cache-history updates and older selections, bounded history across new games, late-response cancellation, sessions/restarts, and more than 30 seconds of uninterrupted manual play. Responsive checks span 305-1920px usable widths, both themes, keyboard focus, canvas pixels, and the sentence editor. Nonzero-cost feedback and both inspection popups are also checked at 320px and 390px. Screenshots are stored in ignored `data/tetris-qa`. These tests incur no Azure inference charges. The optional [scripts/smoke-model.ps1](scripts/smoke-model.ps1) performs bounded **paid** provider checks.

For an opt-in **paid** sustained-play evaluation through the production gateway and verified input replay:

```powershell
node scripts/evaluate-luna.ts --live --moves 100 --min-lines 20 --max-usd 0.20 --seed pure-luna-survival-20260914
```

[scripts/evaluate-luna.ts](scripts/evaluate-luna.ts) saves exact prompts, model replies, executed choices, usage, and the final board under ignored `data/luna-evaluations`. It stops on a real loss, invalid response, eight-minute deadline, or estimated spending cap. It never rescues the board or starts a second game. The `--live` flag is required to authorize paid requests; normal tests do not invoke it.

Use `--no-compression` to evaluate the explicit 220-cell JSON form. The evaluator checks each selected placement's predicted holes, column heights, terminal state, and board metrics against actual execution, and checks the server/client states match. It records peak stack height as well as survival. A passing finite run is not proof of indefinite survival.

Version-4 validation on 2026-09-14 used three predetermined fresh seeds. `full-board-20260914-a` reached 90 pieces and 32 lines before Azure returned HTTP 500; it is recorded as interrupted, with one request missing usage, not as a pass. `full-board-20260914-b` used uncompressed cell JSON and completed 100 pieces with 38 lines, zero final holes, and a peak height of seven. `full-board-20260914-c` used lossless compression and completed 100 pieces with 33 lines, nine final holes, and a peak height of eleven. All 290 executed placements matched their predicted outcomes and verified server replay. No resets or substitute selections were used. The last run still accumulated holes: these results validate the complete prompt and execution, not an unbeatable player.

The full-position update passed all 63 backend tests, build/typecheck, three focused browser regressions, and the non-root Linux image check. After deployment, a single capped live request in Playwright MCP confirmed all 220 unique cell positions and four-cell coordinates for the active piece, ghost, and every candidate. The inspector's text exactly matched the sent JSON. Existing recorded usage was preserved; the smoke request cost $0.0021012 at the displayed retail rates.

Earlier verification on 2026-09-14 with the version-3 policy: pure Luna placed 100 pieces, cleared 39 lines, scored 15,784 points, and selected Hold 42 times without losing. The final board had zero holes and a maximum height of two cells. All 100 requests reported zero reasoning, with 96 cache hits and $0.0847088 estimated retail cost. There were no solver-selected moves or automatic resets. This was one seed, not adequate evidence of general reliability; a later user game still accumulated a dangerous stack.

The update passed 62 backend tests, 14 browser checks, build, lint, and a non-root Linux image smoke test. After deployment, a five-request Playwright MCP run verified the real browser executed Luna's selected placements exactly, including a Hold that cleared a row. It reached 290 points with zero reasoning, two cache hits, and $0.0056416 estimated spend. Board state and usage survived reload, and AI remained off. The deployed application retained its existing scores and usage.