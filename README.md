# Tokenfall

A mobile-first Tetris arcade for a live audience workshop about LLM tokens, prompt caching, and lossless prompt compression. Players turn their own text into a deterministic sequence of labeled falling pieces before starting. GPT-5.6 Luna can suggest individual moves or take control with fast autopilot using real Azure inference. The server verifies game inputs and broadcasts the leaderboard every 500 ms.

## Azure Model

- Default region: **East US 2**. Provision into your own Azure subscription.
- Resource group and account names are generated from the selected azd environment.
- Deployment: **gpt-5.6-luna**, model version **2026-07-09**, GlobalStandard, 500 capacity units.
- Provisioned with `azd provision`; `azd up` also packages and deploys the web application to Azure Container Apps. Local play remains supported.
- Every inference request sets `reasoning_effort: "none"`. A move is rejected unless the response reports exactly zero reasoning tokens.
- Entra authentication through your Azure CLI session locally, or a user-assigned managed identity in Container Apps. Azure API-key authentication stays disabled on the model resource.

Azure CLI and azd must be signed in to the intended subscription and tenant. Deployment settings remain in the gitignored `.azure` directory; they are not included in this repository.

## Run Locally

Requires Node.js 24 or newer, npm, Azure CLI, azd, and access to the deployed model. The checked-in native build dependencies and tunnel launcher target **Windows x64**; Node 25.9.0 was used for validation. Provision the model as described below before starting the server.

```powershell
npm ci
npm --prefix web ci
npm run build
npm start
```

Open **http://127.0.0.1:3100** to play. Open **http://127.0.0.1:3100/?view=room** on the projector. The app reads the selected azd environment automatically, so no keys need to be copied into configuration.

The server defaults to loopback locally. The container sets `HOST=0.0.0.0` for ingress. For a different local port, set `$env:PORT = '3101'` before starting, then pass the matching port to the tunnel launcher. If a port is occupied, choose a free one rather than terminating an unrelated process.

After client edits, run `npm --prefix web run build`. After server edits, restart `npm start`; `npm run dev` enables server file watching. Both processes use the already deployed model.

## Deploy With azd

The existing [azure.yaml](azure.yaml) service and [infra/hosting.bicep](infra/hosting.bicep) deploy the same application to Container Apps. Use the intended existing azd environment, signed-in Azure CLI/azd sessions, PowerShell, Node.js, and a running Linux Docker daemon on Windows x64:

```powershell
azd provision --preview --no-prompt
azd up --no-prompt
azd env get-value SERVICE_WEB_ENDPOINT_URL
```

The service's prepackage hook installs dependencies and builds the web app on the host, preserving the checked-in Windows native build dependencies. The [Dockerfile](Dockerfile) installs production Node dependencies into a non-root Node 24 Linux runtime. Its default `NPM_REGISTRY` build argument uses the working Microsoft package-feed proxy; it can be overridden for another trusted registry. TLS verification stays enabled.

The public HTTPS endpoint serves both the game and Socket.IO. Append `?view=room` for the projector; its QR code uses the deployed app URL. No laptop server or tunnel is required for cloud players. For application-only updates, use `azd deploy web`; preview and provision again when changing infrastructure. Deploy between workshop sessions because a new process starts fresh active boards.

Hosting includes a Basic private Container Registry, a Consumption Container App with **one always-on 0.5-vCPU / 1-GiB replica**, Log Analytics with 30-day retention and a 1-GiB daily ingestion cap, and a dedicated 5-GiB-quota Standard LRS Azure Files share. Hosting and storage incur charges separately from the model-cost figures displayed in the game.

The app identity has only `AcrPull` on its registry and `Cognitive Services OpenAI User` on its model account. Registry admin and anonymous access are disabled. The runtime image excludes local databases, environment files, Azure configuration, and login credentials via [.dockerignore](.dockerignore).

**Persistent state:** Cloud scores, hashed session credentials, room code, and usage are stored under `/data` on Azure Files. Cloud state is separate from local state and survives replica restarts; active boards do not. SQLite uses `DELETE` rollback journaling with full synchronization and an SMB `nobrl` compatibility mount. Keep **one replica and one active application revision**; do not use traffic splitting or scale out. This remains a workshop deployment, not a multi-writer database architecture. Migrate to a managed database and shared room coordination before horizontal scaling.

**Storage authentication exception:** Container Apps' SMB mounts require an account key. Shared-key access is enabled only on the dedicated file-share storage account; ARM supplies the key directly to the environment mount without exposing it to application variables or outputs. Public blob access remains disabled, TLS 1.2 or later and secure transfer are required, and the mount uses SMB 3.1.1. This exception does not enable API keys on Luna or registry admin access.

The latest supported Storage and Log Analytics API versions may produce Bicep `BCP081` warnings when the local compiler lacks their type definitions. Azure deployment preview and provisioning validate those resources server-side.

## Audience QR Access

To allow up to 50 players to reach the local game through a public HTTPS tunnel, run the following while the local server is running:

```powershell
Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '.\data\cloudflared.exe'
Get-AuthenticodeSignature '.\data\cloudflared.exe'
& .\scripts\start-tunnel.ps1 -Port 3100
```

Verify that the executable has a valid Cloudflare, Inc. signature before running it. The launcher writes its public HTTPS address to the ignored local state file; the QR and join link update automatically. The QR includes the current room code and never uses localhost. Audience phones can use another Wi-Fi network or mobile data.

For the local-tunnel option, keep **both the local server and the tunnel running**, and keep the laptop awake. Stop each with Ctrl+C. An anonymous Cloudflare quick tunnel has no uptime guarantee and changes address when restarted. The Container Apps deployment above provides a stable endpoint independent of the laptop.

No public host-administration endpoints exist. The projector is read-only. Infrastructure and room maintenance remain local host operations.

## Text To Token Pieces

The first screen is **Make your token blocks**, not a running game. Enter up to 500 characters that encode to at most 256 tokens, inspect every token and its shape, choose a player name, and press **Start game**. An empty or unfinished token preview cannot start a run.

- Token boundaries and numeric IDs come from the actual `o200k_base` tokenizer. A token can be a word, word fragment, punctuation, whitespace, or part of a multi-byte character. It is not necessarily a word or a character.
- Each token becomes one four-cell tetromino. `token ID % 7` selects I, O, T, S, Z, J, or L in that order. This mapping visualizes tokens; shape is not an inherent property of a tokenizer.
- The exact input-token order repeats after its last token. This replaces seven-bag randomization for token runs. Repeating one token therefore repeats its shape; different texts produce different challenges.
- Token text is drawn directly on falling and locked pieces. Hold carries the label with the shape; surviving labels move with their cells after line clears. Next previews show the upcoming tokens. Pausing keeps labels visible, and short drop animations respect reduced-motion settings.
- Whitespace is made visible with a space marker, escaped newlines/tabs, and counts for long space-only tokens. `[byte]` identifies token bytes that are not a complete Unicode character on their own; their real numeric IDs remain unchanged.
- **Token stream** in the lab shows the sequence actually in play. **Edit text for next run** opens setup again; Cancel leaves the current run intact. Starting the new token run does not reset best score, model spend, or allowance.

The server tokenizes the original text itself; clients cannot submit invented token IDs or relabel a running sequence. Token text is saved with the player, survives reconnection and server restart, and is not exposed in the public room/leaderboard or sent in Luna's prompts. Luna sees board shapes and candidate moves, not custom labels. Existing players from before token setup keep their scores and usage and are routed through setup before the next run.

The setup's token count is a visualization of **that text**. It is distinct from the model-request token count: inference includes the reusable policy, serialized board, candidate moves, and returned suggestion. Text setup is free and does not call a model.

## AI Autopilot

Turn on **Luna autopilot** to let the model choose and play every move under your player name. It tries to improve the same points-per-cent leaderboard score as manual play; it cannot guarantee a win. A live banner and **Stop AI** remain visible while it runs.

- One request at a time, with a one-second minimum admission interval instead of the manual hint's eight-second cooldown. Model latency is additional. The board pauses while a response is pending, preventing the piece from falling away before its move arrives.
- Valid model placements are applied using the engine's legal input path; the server verifies the resulting moves and scores. No heuristic fallback is presented as a model decision.
- **Compress** and **Cache prefix** stay editable during an in-flight request. Each request snapshots its settings, and changed settings take effect on the next request. **Request comparison** shows the latest five requests' mode, input, cached input, retail cost, and latency.
- **Stop AI** immediately prevents further automatic moves, including a late response to an in-flight request. That request can still be billed and appears in the receipt. Its suggestion may be applied manually if still valid.
- Autopilot stops on invalid/model errors, budget exhaustion, game over, hidden-page transitions, and disconnection. Temporary room-busy/cooldown responses retry after their server-provided delay. Reconnection and starting another run never silently re-enable autopilot.
- The 16,000 fresh-token allowance, 40-attempt player limit, room token cap, throughput limits and four-request room concurrency all remain enforced. Uncompressed autopilot can exhaust its allowance rapidly. Start compressed and compare settings deliberately.

## Token Challenge

**Goal: earn the most Tetris points per cent of AI cost.** The leaderboard score is:

```text
points per cent = best single-run Tetris score / (estimated session AI cost in USD * 100)
```

For example, 1,000 Tetris points at $0.002 costs 0.2 cents and scores 5,000 points per cent. The same Tetris points at $0.001 score 10,000 points per cent. There are no flat bonuses or score multipliers for switching features on.

- Compression preserves the full board and move data while sending fewer input tokens, lowering real input cost.
- Provider-confirmed cache reads are priced at the discounted cache-read rate. Cache writes are priced at the cache-write rate instead of ordinary input and can cost more. A miss or enabled switch is not a discount.
- At least one metered AI request is needed for a cost-efficiency ranking. Zero-spend runs are unranked, not infinite. Missing rates or any attempted request without reported usage also make the cost score unavailable; known spend remains visible as incomplete.
- The numerator is the player's best run; the denominator includes **all session requests**, including earlier runs, stale moves, and rejected responses with usage. Restarting does not erase spend or refill the allowance.
- The separate **16,000 fresh-token allowance** counts reported input plus output minus verified cache reads. It is an inference guard, not a dollar balance. Both switches start off and are visible beside the board on desktop and mobile.

With the same starting board and a 20-token test response, the allowance permits **1 raw request, 4 compressed requests, or 7 compressed requests with cache hits after the first write**. Actual counts depend on the board, response size, provider overhead, and cache availability. Requests reserve the full cache-miss size plus headroom; an expected hit never authorizes overspending. Manual Tetris remains free.

## Live Model Rates

The server fetches USD rates from the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices) on startup and hourly. The exact current mapping is GPT-5.6 Luna, **Global Standard, short context**, in the configured `AZURE_LOCATION`. It rejects mismatched units, currencies, deployment tiers, regions, ambiguous meters, and future-dated prices. Unsupported model names have no invented fallback rates.

The on-page price table shows all four rates, source, and last-checked time. If a refresh fails, the last successful rates are labeled **LAST VERIFIED**. Without a verified snapshot, cost scores remain pending. All session usage is revalued at the displayed rates, so a rate refresh can change cost scores; this is not an immutable historical invoice ledger.

```text
ordinary input = reported input - cache reads - cache writes
cost USD = (ordinary input * input rate
		  + cache reads * cache-read rate
		  + cache writes * cache-write rate
		  + output * output rate) / 1,000,000
```

Each token is charged once. The receipt itemizes the counts, rates and costs without rounding before scoring. Dollar totals are **retail estimates using actual provider usage**, not settled Azure bills: negotiated discounts, taxes, and usage absent from failed responses are not known. The public [Azure OpenAI pricing page](https://azure.microsoft.com/en-us/pricing/details/azure-openai/) documents the pricing categories.

## Teaching Flow

1. Put the projector view on screen. Audience members scan the QR and enter text in **Make your token blocks** before starting.
2. Compare `hello world` with `antidisestablishmentarianism`, punctuation, or a newline. Inspect the real token IDs and word fragments, then start and watch those same fragments fall as labeled pieces.
3. Play, hold, rotate, and clear lines. **Token stream** shows the fixed sequence. Pause to inspect labels, or edit text before a new run to produce different pieces.
4. Inspect live rates, enable **Compress** and **Cache prefix**, then enable **Luna autopilot**. The model chooses and applies moves; a cache write can cost extra while the prefix warms.
5. Change cache/compression settings while autopilot runs. The in-flight label shows the original settings; the next request uses the new choices. Compare the recorded input, cache-read counts, dollar receipt, and latency. Hits are real but not guaranteed, and setup token count is not the inference payload count.
6. Stop AI and resume manual play, or use individual **Ask Luna** / **Play move** hints. Spending more must earn enough additional Tetris points to improve points per cent. Opening the lab leaves autopilot running so its request history can be compared; hiding the browser stops it.

**Important distinctions:** A tetromino has four blocks, not four LLM tokens. Cache reads reuse prefix computation, not an entire answer. Cached tokens still count toward input, context, and priced usage. Compression saves submitted text tokens; caching saves repeated computation. Tetris points, token allowance, and estimated dollar cost are distinct. More requests must earn enough additional points to justify their cost.

## Controls And Rules

| Action | Keyboard |
| --- | --- |
| Move | Left / Right arrows |
| Soft drop | Down arrow |
| Hard drop | Space |
| Rotate clockwise | Up arrow / X |
| Rotate counterclockwise | Z |
| Hold | C / Shift |
| Pause / Resume | P / Escape |

All actions have touch controls. Movement and soft drop support press-and-hold. Game buttons have at least 44 px targets on phones. Sound is opt-in; light/dark themes and reduced-motion preferences are supported.

The shared rules layer uses `miaoda-game-fallblock-core` for SRS orientations and kicks, collisions, ghosting, hold swaps, lock delay, preview queues, and rigid row clearing. Legacy replays retain seven-bag behavior; token runs use the deterministic token-ID sequence. The controller adds guideline-style scoring, combos, back-to-back clears, T-spin detection, perfect clears, level progression, a 500 ms lock delay, and a 15-reset lock limit. The board has 10 x 20 visible cells plus two hidden spawn rows.

The leaderboard ranks each player's **best Tetris score per cent of total session AI spend**, with base points and dollar spend shown separately. The board displays the current run's efficiency; a new run can score lower than the stored best. Players can choose different token sequences, so this is a teaching competition, not a standardized tournament. The server recomputes scores from the bound token sequence, timestamped inputs, recorded usage, and verified rates; it never accepts client-supplied score, token-ID, or price fields. This is friendly-workshop verification, not a cheat-proof competitive tournament or an identity-authenticated ranking service.

## Limits And Persistence

- 50 connected players; 500 total registered players per persisted room.
- 16,000 fresh-token allowance per player, counted as reported input plus output minus verified cache reads. The separate 2,000,000-provider-token room limit still includes all cached input. Preflight reservations include the full uncached request size and headroom. Neither is a dollar budget.
- At most four simultaneous model requests, 90 requests/minute, and 400,000 estimated reserved tokens/minute. Busy requests are rejected with a retry hint; manual gameplay continues.
- Eight-second manual inference cooldown or one-second autopilot minimum, 40 attempted model calls per player, and 1,000 per room. Restarting or changing token text does not reset allowances.
- Model output is capped at 128 tokens. Requests time out after 20 seconds and are not automatically retried, avoiding accidental duplicate spend.
- Budgets are application guards, not Azure billing caps. Failed or timed-out requests can still incur provider charges when no usage response is available. No dollar savings are estimated without verified pricing.
- Nicknames, configured token text, hashed session credentials, best scores, and usage totals persist in SQLite under the local ignored data directory or the cloud Azure Files mount. Do not publish those files.
- Page reloads and connection interruptions restore the same tab's active game while the server is running. A full server restart preserves best scores and allowances but starts a fresh active board.
- Active games, session recovery, and the leaderboard are single-process. There is no Redis, managed database, cross-process failover, or horizontal scaling in this workshop version.
- Only fixed game data is sent to Azure. Audience names and arbitrary tokenizer text are not sent to Luna. Prompts use `store: false`; the explicit prompt cache remains provider-managed.

## Provision Resources

The deployment is defined in [azure.yaml](azure.yaml) and [infra/main.bicep](infra/main.bicep). For an existing selected environment:

```powershell
azd auth login --check-status
azd provision --preview --no-prompt
azd provision --no-prompt
```

For a fresh checkout, sign in to Azure CLI and azd using the same account and tenant, select your intended Azure CLI subscription, then create an azd environment. Select that same subscription when prompted. Set the inference principal before provisioning:

```powershell
azd env new tokenfall-dev --location eastus2
$principal = az ad signed-in-user show --query id --output tsv
azd env set AZURE_PRINCIPAL_ID $principal
azd provision --preview
azd up
```

Model version, SKU support, regional quota, and access can change. Recheck them before deploying this template into another subscription. GlobalStandard is pay-per-token; allocated capacity is not a prepaid token balance.

## Verification

```powershell
npm test
npm run build
npm --prefix web run lint
npm run test:ui
& .\scripts\smoke-model.ps1
```

The model smoke test makes paid Azure requests. It checks structured legal choices, zero reasoning, actual cache reuse, and a cache-disabled request. Warm-up is bounded to six eligible requests plus one disabled request. A lack of cache reuse is reported as a failed observation, not silently replaced with simulated telemetry.

The automated suite covers game rules, exact replay, codec round trips, the 1/4/7 allowance comparison, live-price meter selection and pagination, stale/missing pricing, exact cost breakdowns, cache-write premiums, points-per-cent ranking, missing usage, stale inference, quotas, persistence, reconnects, rejected score injection, and 50 real simultaneous WebSocket clients. Initial Playwright validation covered 320, 375, 390, 768, 1440, 1600, and 1920 px layouts; desktop keys; mobile touch; public HTTPS joins; real model-assisted moves; token splitting; and a live projector QR. A live gateway check observed 9,472 raw versus 3,128 packed input tokens (67% less), a real 1,549-token cache hit, and zero reasoning tokens.

`npm run test:ui` uses `playwright-core` with installed Microsoft Edge. It builds the web app, starts temporary isolated rooms with explicitly synthetic model responses, runs nine browser scenarios, and leaves review screenshots under ignored `data/token-game-qa`. It makes no Azure model calls. `npm test` runs 49 engine/server/token tests including schema migration, actual token round trips, label tracking, forged setup rejection, fast-mode limits, and prompt isolation.

The token-game change received five review passes: (1) tokenizer fidelity and on-shape labels, (2) deterministic replay and persistence/migration, (3) autopilot concurrency/cancellation/live settings, (4) prompt isolation and real-rate accounting/limits, and (5) desktop/mobile visual, keyboard, and end-to-end behavior. Additional browser regressions cover hidden tabs, reconnect cancellation, old-player setup, and natural game over.

Live autopilot validation on 2026-09-11 used five bounded real calls in an isolated local room: four moves applied, 250 Tetris points, two 1,549-token cache reads, verified cache-off behavior, zero reasoning, and $0.00255626 estimated retail spend. After the initial 7.3-second cold request, responses took 1.5-2.0 seconds. The fifth response was charged but correctly not auto-applied after Stop. Model latency varies; these are observations, not a speed guarantee.

The token-game update was also published with `azd deploy web`. The deployed policy follows the actual token-driven preview rather than assuming seven-bag distribution. Three real cloud requests drove the game to 214 points at $0.00209385 estimated retail cost. Those three requests wrote the cache but did not read it; no cache savings were fabricated. Public mobile setup, on-piece labels, hold, token-stream/reload fidelity, live prices, and preserved existing cloud scores were verified without additional inference calls.

Container deployment validation on 2026-09-11 passed all 40 local tests, a non-root Linux image smoke test, deployed HTTPS and live pricing, WebSocket player/spectator broadcasts, rejected score injection, mobile controls, the token splitter, and the projector QR. Two real deployed requests through managed identity returned valid moves with zero reasoning; the second read 1,549 cached tokens. A controlled replica restart preserved the room code, best score, and request usage.

To remove the Azure resources when no longer needed, review the selected azd environment and run `azd down` yourself. It deletes the model, hosting, and persisted cloud game data in the resource group; stopping the local app alone does not stop the Azure deployment or its charges.