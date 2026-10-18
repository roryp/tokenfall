# Tetris With Luna

Tetris with sentence-generated pieces, optional GPT-5.6 Luna play, and shared leaderboards. One TypeScript app runs on Azure Container Apps and asks Microsoft Foundry for Luna's moves.

[Play](https://aka.ms/tokenfall) | [Workshop slides](Slides.pdf)

## Play

1. Open [the game](https://aka.ms/tokenfall) and enter a name (2–16 letters, numbers, spaces, underscores, or hyphens).
2. Choose **Sentence** for pieces made from your sentence's tokens, or **Classic** for shuffled seven-piece bags, then click **Join game**.
3. Clear full rows. The run ends when a piece can't spawn or locks entirely above the board.

[![Game screen with labeled score and points, board, controls, AI costs, room, and rankings.](docs/images/screen-guide.png)](docs/images/screen-guide.png)

- **Score:** line clears, back-to-back, combos, and perfect clears are multiplied by the level (a Tetris is 800 at level 1 and 2,400 at level 3). Hard drops add 2 points per row and soft drops 1. The score panel shows what each piece added.
- **Level:** 1 + lines ÷ 10, rounded down. Pieces fall faster each level, from 1 row per second at level 1 until level 20.
- **New game** resets the board but keeps your best score and AI usage, and turns Luna off.
- **Names** are room identities, not accounts: joining with an existing name continues its scores and AI usage, in one tab at a time. **Switch player** pauses and saves your game so someone else can join from the same tab.
- **Rankings** sort by best score or by **Points / cent**, the best score per US cent of AI spend (zero or incomplete spend is unranked there). Manual and Luna runs share them.

## Sentence mode

Your text (up to 500 characters and 256 `o200k_base` tokens) becomes a repeating piece queue: each token ID picks a shape by `ID % 7`, so the same text always gives the same queue. Sentences aren't sent to Luna or shown in rankings.

| Token ID % 7 | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shape | I | O | T | S | Z | J | L |

<img src="docs/images/sentence-mode.png" alt="Sentence mode: Seven shapes make words into falling blocks. Eight tokens map to Z, J, O, I, L, S, T, L, covering all seven shapes." width="390">

## Controls

| Action | Keys |
| --- | --- |
| Move | Left / Right |
| Soft drop / hard drop | Down / Space |
| Rotate clockwise / counterclockwise | Up or X / Z |
| Hold, once per piece | C / Shift |
| Pause / resume | P / Escape |

Touch controls sit below the board. If keys stop responding after you type in a field, click the board.

## Luna

**Ask Luna makes continuous paid Azure AI requests.** Manual play and sentence previews make no model calls. The board pauses during each request, then plays the validated move. To play manually again, turn off **Ask Luna** or click **Stop Luna**, then **Play**; a request in flight may still be charged, but its late move is discarded.

[![AI cost ticker and Luna controls.](docs/images/ai-costs-luna-controls.png)](docs/images/ai-costs-luna-controls.png)

| Option | Effect |
| --- | --- |
| Reasoning | Low reasoning effort: slower, with more output tokens. |
| MCP | Two-placement lookahead, including Hold: about 14% more cost and 0.5 s of tool time per move. |
| Compression | Packs the same board into fewer input tokens. |
| Cache | Reuses the instructions when the provider confirms a hit. Writes can cost extra, and hits aren't guaranteed. |

Options start off and apply from the next request. **Information & tools** has the prompt, cache, MCP, and cost inspectors.

### Pricing

Costs are estimates at Azure's published list prices in USD, not an invoice: discounts and credits aren't applied. The server loads the rates from the [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices) for the `AZURE_LOCATION` region at startup and every hour ([pricing](server/pricing.ts)). The cost ticker shows **Live rates**, **Last verified rates** when a refresh fails and the previous rates are kept, or **Rates unavailable** with `--` for dollar amounts when no rates have loaded (for example, without `AZURE_LOCATION`).

`gpt-5.6-luna` Global Standard rates, checked October 18, 2026. They took effect on August 1, 2026 in East US 2 and are the same in every region that lists them:

| Tokens | Meter (`skuName`) | USD per 1M tokens |
| --- | --- | --- |
| Input | `5.6 luna ShortCo Inp Std Gl` | $0.20 |
| Cached input (cache hit) | `5.6 luna ShortCo Cd Inp Std Gl` | $0.02 |
| Cache write | `5.6 luna ShortCo Cd Wr Std Gl` | $0.25 |
| Output, including reasoning | `5.6 luna ShortCo Opt Std Gl` | $1.20 |

**Meter names:** `5.6 luna` is the model, `ShortCo` a short-context request, `Inp`, `Cd Inp`, `Cd Wr`, and `Opt` the token type, `Std` standard processing, and `Gl` a Global deployment. Luna's requests are around 10,000 input tokens, far below the long-context threshold. The API's other Luna meters don't apply to this deployment: `LongCo` long-context requests (2× input, 1.5× output), `PP` [priority processing](https://learn.microsoft.com/azure/foundry/openai/concepts/priority-processing) (2×), and `DZ` Data Zone deployments (+10%).

**Choosing the rates:** for each token type, the server keeps only API items that match every field below and uses the newest `retailPrice`, the list price before discounts (`unitPrice` is the same). A missing meter, or conflicting prices with the same start date, fails the refresh.

| Field | Must be |
| --- | --- |
| `productName`, `skuName` | `Azure OpenAI GPT5`, a meter above |
| `armRegionName` | `AZURE_LOCATION`, for example `eastus2` |
| `currencyCode`, `type`, `unitOfMeasure` | `USD`, `Consumption` (pay as you go), `1M` (per million tokens) |
| `isPrimaryMeterRegion`, `tierMinimumUnits` | `true`, `0` (the base price tier) |
| `effectiveStartDate` | In the past |

**Pricing a request** ([costForUsage](shared/protocol.ts)): Foundry reports input, cached, cache-write, and output tokens for each request. Cached and written tokens are part of the input, and reasoning tokens part of the output, so each token is priced once:

```text
cost = ((input − cached − written) × input rate + cached × cached-input rate
        + written × cache-write rate + output × output rate) ÷ 1,000,000
```

A plain move, with every option off, doesn't use the cache, so only input and output count:

[![Cost of one plain Luna move: (10,000 input tokens × $0.20 + 35 output tokens × $1.20) ÷ 1,000,000 ≈ $0.002, with prices per 1M tokens. Input is $0.002000 of that and output $0.000042, so input is about 98% of the cost.](docs/images/luna-move-cost-equation.png)](docs/images/luna-move-cost-equation.png)

Because input is about 98% of the cost, Compression and Cache matter most: each 1,000 input tokens removed saves $0.0002, each 1,000 read from the cache saves $0.00018, and each 1,000 written to it costs $0.00005 extra.

SQLite stores token counts, not dollars, so totals, savings, and **Points / cent** always follow the current rates ([room](server/room.ts)). To check the rates for your region:

```powershell
$filter = "armRegionName eq 'eastus2' and productName eq 'Azure OpenAI GPT5' and contains(skuName, '5.6 luna ShortCo') and contains(skuName, 'Std Gl')"
(Invoke-RestMethod "https://prices.azure.com/api/retail/prices?currencyCode='USD'&`$filter=$filter").Items | Select-Object skuName, retailPrice, unitOfMeasure, effectiveStartDate
```

### Cost and speed

[![Annotated cost vs speed per Luna move on the 2 CPU game server: one move costs about $0.002. Compression costs about a quarter less than Plain and Cache about an eighth less, at about the same speed; Reasoning and MCP cost about 14% more and are 2.3 and 1.5 times slower.](docs/images/luna-cost-vs-speed-explained.png)](docs/images/luna-cost-vs-speed-explained.png)

Measured in October 2026 from 50 [traces](#tracing), with each option playing the same 10 board positions at [Azure retail prices](#pricing). Costs are estimates, and times vary with model load. Cache lowers the price, not allowance use.

### Limits and capacity

- **Player:** 1,000,000 AI tokens across all games. Input (including cached) and output count, and a new game doesn't refill them.
- **Room:** 50,000,000 AI tokens, 2,000 Luna requests, and up to 250 online players (`ROOM_CAPACITY`, at most 500). Newcomers wait for a free spot in a full room, but the host's [admin link](#admin-access) always gets in.
- **Throughput:** at most 80% of the deployment's tokens per minute, 8 Luna calls per second, and 4 MCP lookups at a time. Manual play continues when AI limits run out.
- **Shared Wi-Fi:** per-address limits grow with the room (3 joins and 6 sentence previews per minute per seat), so an audience can share one address.

[![How many Luna players at once: a Luna player next to Azure uses about 311K tokens per minute, one in Johannesburg about 246K, and players add up. 6,950K tokens per minute of Azure capacity fits about 22 nearby players, about 16 after the game's 28% safety margin, while the game server's 8 Luna calls per second fit about 14.](docs/images/luna-capacity-scaling.png)](docs/images/luna-capacity-scaling.png)

Measured on Azure in October 2026:

- **Luna:** a player near East US 2 uses about 310K tokens per minute, so allow about 430K per simultaneous Luna player with the safety margin. The 8 calls per second cap serves about 14 such players at full speed.
- **Room size:** one 2 CPU replica held 500 players and 100 spectators, with 50 of the players on Luna autopilot at once, and had no restarts or disconnects. Input acknowledgements took 2 ms at the median and about 35 ms at the 95th percentile, up to about 0.6 s during the Luna burst.
- **Request budget:** with many players on autopilot, the room uses about 6 Luna requests per second, so the 2,000 requests last about 5 minutes.
- **Storage:** each SQLite commit on Azure Files takes about 60 ms, so player saves are committed together every half second ([room](server/room.ts)).

Rehearse before an event with the [stress test](scripts/stress-room.ts), run near Azure (for example as a Container Apps job), then [reset the room](#reset-room-data):

```powershell
node scripts/stress-room.ts --url https://your-app --players 500 --spectators 100 --steady-seconds 300 --luna-bots 50 --workers 4
```

## Architecture

A deliberately small TypeScript app that shows the full path from browser game logic to an Azure-hosted model. Each diagram has an editable `.excalidraw` source in [docs/images](docs/images).

[![Tokenfall architecture: the browser (React and TypeScript) talks to the game server (Node.js and TypeScript) in Azure Container Apps over Socket.IO. The app also contains a local MCP server and SQLite on Azure Files. With a managed identity and no keys, it sends Luna moves to Microsoft Foundry and OpenTelemetry traces to Application Insights, which Foundry shows as traces. azd up deploys everything with Bicep and Docker.](docs/images/architecture.png)](docs/images/architecture.png)

### What runs where

| Part | Built with | Role |
| --- | --- | --- |
| Browser | React 19, Vite, TypeScript | Draws the board and runs the [shared game engine](shared/game.ts) at 60 FPS. |
| Game server | Node.js 24, Express 5, Socket.IO 4 | One Container Apps replica (2 CPUs, 4 GiB) running the `.ts` files directly. Serves the web app, replays every input to verify scores, and admits Luna requests ([room](server/room.ts), [model gateway](server/model.ts)). |
| Local MCP server | MCP TypeScript SDK, stdio | A child process, not a separate service. Its read-only `analyze_future_moves` tool simulates the next two placements ([client](server/mcp.ts), [server](server/mcp-server.ts)). |
| SQLite | `node:sqlite` on Azure Files | Players, scores, sentences, allowances, and usage. SQLite has one writer, so the app runs one replica; three replicas corrupted the database in a test. |
| Managed identity | Microsoft Entra ID | Keyless access: `AcrPull` for the image, `Cognitive Services OpenAI User` for Luna, `Monitoring Metrics Publisher` for traces. |
| Microsoft Foundry | `gpt-5.6-luna`, GlobalStandard | Picks one of the legal placements the server sends, as strict JSON. |
| Application Insights | Azure Monitor, OpenTelemetry | One trace per Luna move, kept 30 days. |
| azd | Azure Developer CLI, Bicep, Docker | Builds the image, creates the resources in [infra/](infra/main.bicep), and deploys. |

Zod validates messages and MCP replies, js-tiktoken counts tokens, and the Azure Retail Prices API supplies [live prices](#pricing). Prompts are built in [tokens.ts](server/tokens.ts) from the [policy](server/policy.md).

### Infra flow: `azd up`

[![Infra flow for azd up: package builds the TypeScript app and Docker image; provision runs Bicep to create gpt-5.6-luna in Microsoft Foundry and the container app with its managed identity; deploy pushes the image and deploys a new revision, which pulls the image with the managed identity.](docs/images/infra-flow.png)](docs/images/infra-flow.png)

| Steps | Phase | What happens |
| --- | --- | --- |
| 1 | Package | The [prepackage hook](azure.yaml) runs `npm ci`, `tsc`, and the Vite build, then azd builds the [Docker image](Dockerfile). |
| 2-4 | Provision | [main.bicep](infra/main.bicep) creates [monitoring](infra/monitoring.bicep), the keyless Foundry resource with `gpt-5.6-luna` and the `tokenfall` project ([model](infra/model.bicep)), and the Container App with its managed identity, registry, and Azure Files ([hosting](infra/hosting.bicep)). |
| 5-7 | Deploy | azd pushes the image. The new revision pulls it with the managed identity, mounts `/data`, and serves once `/api/health` passes. |

Provisioning writes the endpoints and Application Insights connection string to `.azure/<env>/.env`, which the local server also reads.

### Azure flow: one Luna move

[![Azure flow for one Luna move: the browser asks Luna; the game server optionally runs the local MCP lookahead, gets a token from its managed identity, sends the board and rules to gpt-5.6-luna in Microsoft Foundry, validates the move and saves usage to SQLite, returns the move to the browser, and sends a trace to Application Insights.](docs/images/azure-flow.png)](docs/images/azure-flow.png)

| Steps | What happens |
| --- | --- |
| 1 | The browser sends `assist`. Before any paid work, the server checks cooldowns, budgets, and room capacity. |
| 2-3 | With MCP on, the local MCP server runs `analyze_future_moves`. A reply that fails its schema or board hash stops the request before Luna is called. |
| 4 | The managed identity gets an Entra ID token, cached between moves. |
| 5-6 | `gpt-5.6-luna` gets the rules, board, and legal placements, and must reply with a `placementId` and a tip. Its rate-limit headers resize the room's limits. |
| 7 | The server accepts only a placement it offered, then saves token usage. |
| 8 | The browser re-checks the placement with the shared engine and plays it like any move. |
| 9 | The trace goes to Application Insights and reaches Foundry within minutes. |

**Luna only picks from legal placements made by deterministic game code, and MCP never plays a move.** Locally, your `az login` replaces the managed identity and `./data` replaces Azure Files.

## Run locally

Requires Node.js 24+, Azure CLI, and `Cognitive Services OpenAI User` on a Luna deployment. The checked-in native frontend packages target Windows x64. Process variables override a root `.env` file, which overrides the selected `azd` environment ([configuration](server/config.ts)). Without azd:

```powershell
$env:AZURE_OPENAI_ENDPOINT = 'https://YOUR_RESOURCE.openai.azure.com'
$env:AZURE_OPENAI_DEPLOYMENT = 'gpt-5.6-luna'
$env:AZURE_TENANT_ID = 'YOUR_TENANT_ID'
$env:AZURE_LOCATION = 'eastus2' # your resource's region, for pricing
az login --tenant $env:AZURE_TENANT_ID
npm ci
npm --prefix web ci
npm run build
npm start
```

Open http://127.0.0.1:3100. Inference uses your Azure CLI sign-in, so leave `AZURE_CLIENT_ID` unset; it selects managed identity.

- **Development:** `npm run dev` watches the server; rebuild the web app with `npm --prefix web run build`.
- **Data:** SQLite lives in `DATA_DIRECTORY` (default `data`); boards are lost on restart. A second server needs its own `PORT` and `DATA_DIRECTORY`. Keep databases and backups private.
- **Tracing:** local Luna moves are [traced](#tracing) when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set, as it is in the azd environment. Set it empty in `.env` to keep local runs out of the shared traces.
- **Sharing:** set `HOST=0.0.0.0` and an audience-reachable `PUBLIC_BASE_URL`. A `DATA_DIRECTORY/public-url.json` saved by the [tunnel helper](scripts/start-tunnel.ps1) overrides it; remove the file when the tunnel stops. Check **Share game** before sharing the link.
- **Room size and admin:** `ROOM_CAPACITY` (default 250, at most 500) and `ADMIN_KEY` ([admin access](#admin-access)). On Azure, set them with `azd env set` and provision.

## Deploy

For a new environment, `azd up` packages, provisions, and deploys ([infra flow](#infra-flow-azd-up)). Packaging needs Docker, PowerShell 7, a signed-in `azd`, and the Windows frontend toolchain.

**Updates need downtime.** SQLite allows one writer, and [Single revision mode overlaps old and new containers](https://learn.microsoft.com/en-us/azure/container-apps/revisions#zero-downtime-deployment):

1. Wait until no players are online and no Luna requests are pending.
2. Set sticky sessions to `none` (`az containerapp ingress sticky-sessions set --affinity none`), switch to **Multiple** revision mode, and deactivate every active revision. Wait for **zero running replicas on every revision**; zero traffic is not enough.
3. Deploy: `azd deploy web --environment tokenfall-dev --no-prompt`.
4. Check for one healthy new replica and no others, route all traffic to it, then restore **Single** revision mode and `--affinity sticky`.

To roll back, stop the new revision and wait for zero replicas before activating the old one.

- **Infrastructure or settings:** `azd provision` also starts a new revision. Run `azd provision --environment tokenfall-dev --no-prompt` as step 3 and check for one healthy replica, then repeat steps 2–4 to deploy. Preview with `azd provision --preview`; `azd deploy` alone doesn't change container settings.
- Don't run `azd init` over the configured environment. Keep the Azure Files `nobrl` mount and SQLite `DELETE` journaling with full sync. `TRUST_PROXY_HOPS=1` is set for the ingress; leave it unset locally.

## Admin access

The host's admin link joins even a full room and skips the registration and per-address join limits; AI limits still apply.

1. Store a random key of at least 32 characters, then provision ([Deploy](#deploy)). Without a key, admin access is off.

   ```powershell
   azd env set ADMIN_KEY (node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
   ```

2. Before the event, open the admin link once in the browser you'll present from:

   ```powershell
   "$(azd env get-value SERVICE_WEB_ENDPOINT_URL)/#admin=$(azd env get-value ADMIN_KEY)"
   ```

The key stays in the URL fragment, which browsers don't send to servers. The page saves it in that browser and removes it from the address bar, and share links never include it. **Admin access is on for this browser** shows before you join, and an **Admin** badge after. Anyone with the key can join a full room, so keep it private. Open `/#admin=` to forget it; to rotate it, set a new value and provision.

## Tracing

[![Luna traces in Microsoft Foundry: the linked tokenfall-luna agent with one trace per move and its tokens, and one trace's agent, tool, and model spans with the token waterfall and provider-reported usage.](docs/images/foundry-luna-traces.png)](docs/images/foundry-luna-traces.png)

Each Luna move is one trace ([tracing](server/tracing.ts)) that follows the [OpenTelemetry GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Spans carry the agent ID `tokenfall-luna` and the game run as the conversation ID, and record token counts, not prompts or replies.

| Span | Records |
| --- | --- |
| `invoke_agent Luna` | Options, reserved tokens, move status, and usage |
| `execute_tool analyze_future_moves` | MCP lookahead time and result tokens |
| `chat gpt-5.6-luna` | Response ID, finish reason, and input, output, cache, and reasoning tokens |

The app exports spans with its managed identity to Application Insights, which is connected to the `tokenfall` Foundry project. They arrive within 2–5 minutes and are kept 30 days. Requests rejected before reaching Luna aren't traced, and HTTP auto-instrumentation is off so health probes don't bury the GenAI spans. Provisioning gives the deploying user `Log Analytics Reader` and `Foundry User` to view them.

**Link Luna once per project** in [Microsoft Foundry](https://ai.azure.com): **Build › Agents › New agent › Link external agent**, with the name and OTel agent ID `tokenfall-luna` ([preview](https://learn.microsoft.com/azure/foundry/agents/how-to/register-external-agent)). Traces then appear under **Build › Agents › tokenfall-luna › Traces**; set **Display mode** to **Tokens** for the token waterfall.

Hourly usage in Application Insights:

```kusto
dependencies
| where customDimensions["gen_ai.operation.name"] == "chat"
| summarize calls = count(), input = sum(toint(customDimensions["gen_ai.usage.input_tokens"])), output = sum(toint(customDimensions["gen_ai.usage.output_tokens"])) by bin(timestamp, 1h)
```

## Reset room data

**A full reset deletes all players, scores, sentences, sessions, and in-app AI history; everyone must rejoin.** It keeps the room code, verifies a backup first, and doesn't reset Azure billing or provider caches. Preview first, then apply with the room code the preview shows:

```powershell
# Azure: refuses while players are online or Luna requests are pending, then restarts the app
npm run reset:azure
npm run reset:azure -- -Apply -ConfirmRoom YOUR01

# Stopped local server: restart it afterwards
npm run reset -- --database data\tokenfall.sqlite
npm run reset -- --database data\tokenfall.sqlite --apply --confirm-room YOUR01 --server-stopped
```

The [Azure script](scripts/reset-room.ps1) needs PowerShell 7, `az`, `azd`, and Container App exec and restart rights, and defaults to `tokenfall-dev`. Add `-Mode scores` on Azure or `--mode scores` locally to clear only scores, keeping players and AI usage. Never pass `--server-stopped` for a running server.

The browser Admin panel (`LOCAL_ROOM_MAINTENANCE=true`) is unauthenticated and runs only on a loopback development server; never expose it through a tunnel.

## Checks

```powershell
npm test
npm run build
npm --prefix web run lint
npm run test:ui
```

UI tests require Microsoft Edge. Tests use isolated databases and make no paid calls; the [live evaluator](scripts/evaluate-luna.ts) and [provider smoke checks](scripts/smoke-model.ps1) do.
