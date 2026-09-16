# Tetris With Luna

Untimed Tetris with a shared room, live leaderboards, and optional GPT-5.6 Luna autoplay. Manual play and token previews make no model calls.

[Play online](https://azappctfcqc35fwl26.calmsea-c2502d80.eastus2.azurecontainerapps.io/)

## Play

- Join with a 2-16 character name. **Sentence** maps real `o200k_base` token IDs to shapes and repeats the labeled sequence; text is limited to 500 characters and 256 tokens. **Classic** uses seven-bag pieces. Both support SRS rotation, hold, ghost, next pieces, levels, and standard scoring.
- **Leaderboard** ranks best points, including manual players. **Points / cent** divides best points by estimated cumulative player spend in US cents; zero spend, missing prices, and incomplete usage are unranked. Each list has up to 50 entries, ten per page. The room permits 50 online players and 500 saved registrations.
- **Share game** provides a credential-free link and locally generated, enlargeable QR code. Audience QR requires a public or network-accessible URL, not localhost. Sharing and viewing rankings do not stop an enabled Luna session.
- **New game** and **Change sentence** preserve best scores, AI usage, allowances, and preferences. They start a new board with Luna off.

| Action | Keyboard |
| --- | --- |
| Move | Left / Right |
| Soft drop | Down |
| Hard drop | Space |
| Rotate clockwise | Up / X |
| Rotate counterclockwise | Z |
| Hold | C / Shift |
| Pause / Resume | P / Escape |

Touch controls are also available.

### Luna Controls

**Ask Luna** plays continuously, pausing the board while each paid request is pending and executing the validated move. All four options default off and are **disabled until Ask Luna is on**. Changes affect the next request; stopping Luna disables the controls without clearing preferences.

| Option | Effect |
| --- | --- |
| Reasoning | Low effort instead of `none`; reported reasoning tokens are already part of output usage. |
| MCP | Real two-placement lookahead, including Hold; adds input tokens and latency. **Results** shows the tool call and forecasts. |
| Compression | Losslessly packs the same board into fewer input tokens. **Inspect last prompt** compares both exact encodings. |
| Cache | Reuses fixed instructions when the provider confirms a hit. Writes can cost extra; hits are not guaranteed. |

Hidden pages, disconnects, and the MCP, compression, sentence, and allowance dialogs suspend Luna and invalidate late moves without clearing its selection. Closing dialogs, returning to the page, or reconnecting to the same run can resume it. **Stop**, game over, new games, and page reloads leave Luna off. Already-started requests can still be charged.

Temporary failures allow three retries with 2/4/8-second backoff or a longer server delay. Repeated failures and hard limits pause with **Retry Luna**; changing options or allowance can retry without bypassing limits. Busy/cooldown responses wait for admission without contacting the model.

**Cache activity** deliberately keeps Luna running and has its own Stop control. It retains the latest 20 received replies in the loaded page, with fixed older selections. Inspection is free; receipts clear on reload, but usage and cache totals persist. Provider counts do not identify individual cached words.

## Costs And Limits

New players joining through the UI receive a **1,000,000-token allowance**, adjustable from **16,000 to 8,000,000** before joining or through **AI TOKENS LEFT**. This is cumulative across games, not replenished on restart. Older saved players retain their existing allowance.

The counter shows the smaller personal/room balance after **reported input + output**, including cached input. **Available now** additionally subtracts pending reservations and conservative holds for missing usage, up to 16,000 tokens per unreported request. Holds are not reported spend. MCP input and reasoning output are counted once, not added again.

The ticker uses provider usage and matching USD Global Standard short-context rates from the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices), refreshed hourly. Totals are valued at the displayed rates, **not historical invoices**; stale/missing prices and incomplete usage are labeled. Pricing currently recognizes the deployment name `gpt-5.6-luna` only.

```text
ordinary input = input - cached reads - cache writes
cost = (ordinary input * input rate
      + cached reads * read rate
      + cache writes * write rate
      + output * output rate) / 1,000,000
```

Compression savings are tokenizer estimates; cache adjustments use confirmed reads/writes. The before-optimizations estimate plus signed adjustments reconciles to reported-usage cost. Cache reduces price, not allowance tokens; enabling a switch alone saves nothing.

**Server safeguards:** one in-flight request per player, four concurrent per room, at least one second between automatic requests, 90 requests / 400,000 reserved tokens per minute, and 2,000 attempts / 8,000,000 tokens per persisted room. Each request reserves at most 16,000 tokens including headroom and completion allowance: 128 with reasoning off, 2,048 with it on. Provider timeouts are 20/60 seconds respectively; MCP adds a separate 15-second deadline. Raising a personal allowance does not raise these limits. Invalid/truncated replies are not played, but reported usage remains charged. These are application guards, not Azure billing caps.

## Run Locally

Requires **Node.js 24+**, npm, Azure CLI, and Entra access to an existing Luna deployment (`Cognitive Services OpenAI User`). The checked-in native frontend packages target **Windows x64**; the production container runs Linux.

Use the selected `azd` environment, or set these variables for your existing resource:

```powershell
$env:AZURE_OPENAI_ENDPOINT = 'https://YOUR_RESOURCE.openai.azure.com'
$env:AZURE_OPENAI_DEPLOYMENT = 'gpt-5.6-luna'
$env:AZURE_TENANT_ID = 'YOUR_TENANT_ID'
$env:AZURE_LOCATION = 'eastus2'
az login --tenant $env:AZURE_TENANT_ID
npm ci
npm --prefix web ci
npm run build
npm start
```

Use your resource's region for `AZURE_LOCATION`; pricing needs it. Open http://127.0.0.1:3100. Local inference uses Azure CLI credentials, not API keys; leave `AZURE_CLIENT_ID` unset locally because it selects managed identity. The health endpoint `/api/health` checks the server, not successful model access.

Configuration precedence is selected `azd` environment, root dotenv file, then process variables. See [server/config.ts](server/config.ts). `npm run dev` watches the backend; rebuild frontend edits with `npm --prefix web run build`. A second server needs a different `PORT` and `DATA_DIRECTORY`. For deliberate network sharing, set `HOST=0.0.0.0` and an audience-reachable `PUBLIC_BASE_URL`.

### Persistence

SQLite stores the room code, hashed session credentials, sentences, best scores, allowances, and usage. Browser session credentials and options use per-tab session storage. Reload/reconnect can recover the board while its server-side game remains cached; boards are lost on process restart and can be evicted after 15 minutes disconnected. Durable scores and usage remain. Sentence text is not sent to Luna or public rankings.

## How It Works

React/Vite renders the game; Express and Socket.IO synchronize inputs against the same [game engine](shared/game.ts) on the server. Scores come from verified replay, not client-supplied totals.

Luna alone selects a current move. [Prompt construction](server/tokens.ts) sends all **220 cells** (10 columns, 22 rows, including two hidden rows), exact active/ghost/candidate cells in `[column,row]` order, Hold, five next pieces, and every engine-generated legal placement with factual outcomes. Compression uses 22 ten-character rows; it never crops the board. The [policy](server/policy.md) and [gateway](server/model.ts) validate the returned placement ID; no substitute move or automatic rescue is used. Reasoning-off replies require a provider-confirmed zero reasoning count. Survival is not guaranteed.

[MCP lookahead](server/mcp-server.ts) uses the official SDK over stdio: initialization, `tools/list`, then `analyze_future_moves`. It replays each current candidate and enumerates next placements, including Hold, using only the known preview. The app triggers it, not the model. Forecasts are losslessly deduplicated when needed, never pruned; the extra input shares the 16,000-token guard with a 2,304-token MCP allowance. A lookup failure stops before paid inference, with no silent fallback. Large requests may require Compression or disabling MCP. The tool receives game state, not names, sentence text, session tokens, or Azure credentials.

The app starts and closes one MCP child process per lookup; no public MCP endpoint is needed. Other MCP clients can launch `npm run --silent mcp:server` from the repository. The older `lookup_board_facts` tool remains available for compatibility.

## Deploy

The existing [azure.yaml](azure.yaml), [Dockerfile](Dockerfile), and [hosting template](infra/hosting.bicep) target Azure Container Apps. Packaging requires Docker, PowerShell 7, authenticated `azd`, and the Windows frontend toolchain. For an app-only update to the existing environment:

```powershell
azd deploy web --environment tokenfall-dev --no-prompt
```

Do not run `azd init` over the configured environment. Provision only for intentional infrastructure changes, after `azd provision --preview`. Packaging builds the frontend on the host; the image runs non-root Node 24 on port 3100 with managed identity for registry pull and inference. Local data and credentials are excluded.

**Single writer only:** keep one replica, one active revision, and no traffic splitting. Deploy between games and verify the previous writer has stopped. Cloud SQLite uses `DELETE` journaling / full synchronization on Azure Files. The existing SMB mount requires `nobrl` and shared-key authentication; secure transfer stays enabled. Hosting/storage charges are separate from the model ticker.

## Reset Room Data

**Default `all` reset deletes saved players, both leaderboards, sentences, sessions, and in-app AI history. Everyone must rejoin.** It replenishes the application allowance, not Azure billing or provider caches. Room code/link, configuration, backups, and evaluation files remain. Every applied reset verifies a recovery backup before a transactional write; keep backups private.

### Maintenance Scripts

For a **stopped local server**, use its actual database path, preview first, then replace `YOUR01` with the displayed room code:

```powershell
npm run reset -- --database data/tokenfall.sqlite
npm run reset -- --database data/tokenfall.sqlite --apply --confirm-room YOUR01 --server-stopped
```

Restart afterward. Never pass `--server-stopped` against a running server.

For Azure, preview first and use the returned room code:

```powershell
npm run reset:azure
npm run reset:azure -- -Apply -ConfirmRoom YOUR01
```

The [Azure wrapper](scripts/reset-room.ps1) requires PowerShell 7, `az`, `azd`, and Container App exec/restart permissions. It defaults to `tokenfall-dev` (`-Environment` selects another), refuses connected players or pending AI, restarts the same revision, and verifies the result without deploying. Respect HTTP 429 cooldowns; writes are not automatically retried.

Use `--mode scores` locally or `-Mode scores` on Azure to zero scores **without removing players or AI usage**; that mode does not empty the leaderboard. See [reset implementation](scripts/reset-room.ts).

### Local Reset Panel

**Authentication is not implemented.** The panel is off by default and must never be exposed through a tunnel or enabled on Azure. On a loopback development server only:

```powershell
$env:LOCAL_ROOM_MAINTENANCE = 'true'
$env:HOST = '127.0.0.1'
$env:DATA_DIRECTORY = 'data/maintenance-preview'
npm start
```

After building/configuring as above, open **Room maintenance** beside the room code. Opening stops Luna and pauses/syncs your game. Pause all other games, wait for pending requests, choose **Leaderboard + history** or **Scores only**, review the preview, and type the room code. Confirmations expire after two minutes and cannot be reused; changed data requires a fresh preview. Reset clears cached games without a server restart. Cancel changes nothing and leaves Luna off. Startup rejects public binding, production mode, or managed identity; endpoints reject non-local, forwarded, and cross-origin requests.

## Verify

```powershell
npm test
npm run build
npm --prefix web run lint
npm run test:ui
```

Tests cover replay/rules, tokenization, pricing/allowances, genuine MCP calls with synthetic inference, persistence, resets, and 50 simultaneous sockets. Browser tests require installed **Microsoft Edge** via `playwright-core`; they cover full games, Luna option gating/recovery, inspectors, QR joins, and responsive light/dark layouts. Fixtures use isolated databases and incur **no Azure inference charges**. Screenshots go to ignored `data/tetris-qa`.

Optional **paid** evaluation through the real gateway:

```powershell
node scripts/evaluate-luna.ts --live --moves 100 --min-lines 20 --max-usd 0.20 --seed pure-luna-survival-20260914
```

The [evaluator](scripts/evaluate-luna.ts) requires `--live`, keeps cache on and reasoning/MCP off, and supports `--no-compression`. It verifies exact replay and stops at its target, loss, invalid response, eight-minute deadline, or estimated spending cap. Prompts, replies, usage, and results are saved under ignored `data/luna-evaluations`; no rescue or reset occurs. [Provider smoke checks](scripts/smoke-model.ps1) also make paid requests and are not part of normal tests. Finite passing runs do not establish indefinite survival.