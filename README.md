# Tetris With Luna

Tetris with sentence-generated pieces, optional GPT-5.6 Luna play, and shared leaderboards. One TypeScript app runs on Azure Container Apps and asks Microsoft Foundry for Luna's moves.

[Play](https://aka.ms/tokenfall) | [Workshop slides](Slides.pdf)

## Contents

- [Play](#play)
- [Sentence mode](#sentence-mode)
- [Controls](#controls)
- [Luna](#luna)
  - [Cost and speed](#cost-and-speed)
  - [Limits and capacity](#limits-and-capacity)
- [Architecture](#architecture)
  - [What runs where](#what-runs-where)
  - [Infra flow: azd up](#infra-flow-azd-up)
  - [Azure flow: one Luna move](#azure-flow-one-luna-move)
- [Run locally](#run-locally)
- [Deploy](#deploy)
- [Tracing](#tracing)
- [Reset room data](#reset-room-data)
- [Checks](#checks)

## Play

1. Open [the game](https://aka.ms/tokenfall) and enter a name (2-16 letters, numbers, spaces, underscores, or hyphens).
2. Choose **Sentence** for a repeating token-derived queue or **Classic** for shuffled seven-piece bags.
3. Click **Join game**. Fill horizontal rows to clear them; the run ends when a piece cannot spawn or locks entirely above the board.

[![Game screen with labeled score and points, board, controls, AI costs, room, and rankings.](docs/images/screen-guide.png)](docs/images/screen-guide.png)

After each piece locks, the score shows the points it added and how: line clears (× level from level 2), back-to-back, combos, perfect clears, and 2 points per hard-drop row or 1 per soft-drop row.

<img src="docs/images/score-points.png" alt="Score panel: total score 1,200, then +134 for the last move, from a Single (100) and a hard drop of 17 rows × 2." width="560">

**New game** resets the board, score, lines, and level, but keeps your best score and AI usage. Luna starts off.

Names are room identities, not authenticated accounts. Reusing a name continues its scores and usage and replaces the previous tab's session. Use a distinctive name and one tab per player.

Leaderboards rank best score or best score divided by cumulative AI spend in US cents. Zero spend or incomplete cost data is unranked on **Points / cent**. Manual and AI runs share the rankings.

## Sentence mode

Text is split into `o200k_base` tokens. Each token ID maps to a shape using `token ID % 7`; the sequence repeats. Limits: 500 characters and 256 tokens. The same text always produces the same queue, not necessarily a balanced mix.

| Token ID % 7 | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shape | I | O | T | S | Z | J | L |

<img src="docs/images/sentence-mode.png" alt="Sentence mode: Seven shapes make words into falling blocks. Eight tokens map to Z, J, O, I, L, S, T, L, covering all seven shapes." width="390">

The example produces `Z J O I L S T L`. Sentence text is not sent to Luna or shown in public rankings.

## Controls

| Action | Key |
| --- | --- |
| Move | Left / Right |
| Soft drop | Down |
| Hard drop and lock | Space |
| Rotate clockwise | Up / X |
| Rotate counterclockwise | Z |
| Hold / swap | C / Shift |
| Pause / resume manual play | P / Escape |

Touch controls sit below the board. Hold is available once per piece. The ghost marks the hard-drop position. Click the board if keys stop responding after editing a field.

## Luna

**Ask Luna starts continuous paid Azure AI requests.** Manual play and sentence previews make no model calls. The board pauses during each request, then executes the validated move. To resume manual play, turn off **Ask Luna** or click **Stop Luna**, then **Play**; an in-flight request may still be charged, but its late move is discarded.

[![AI cost ticker and Luna controls.](docs/images/ai-costs-luna-controls.png)](docs/images/ai-costs-luna-controls.png)

| Option | Effect |
| --- | --- |
| Reasoning | Uses low reasoning effort; may increase latency and output tokens. |
| MCP | Adds two-placement lookahead, including Hold, at additional input-token and latency cost. |
| Compression | Packs the same board into fewer input tokens without removing cells. |
| Cache | Reuses instructions when the provider confirms a hit. Writes may cost extra; hits are not guaranteed. |

Options default off, are disabled while Luna is off, and affect the next request. Saved choices return when Luna is enabled again. **Information & tools** contains the prompt, cache, MCP, and cost inspectors.

### Cost and speed

[![Annotated cost vs speed per Luna move on the 2 CPU game server: one move costs about $0.002. Compression costs about a quarter less than Plain and Cache about an eighth less, at about the same speed; Reasoning and MCP cost about 14% more and are 2.3 and 1.5 times slower.](docs/images/luna-cost-vs-speed-explained.png)](docs/images/luna-cost-vs-speed-explained.png)

Measured from 50 [Foundry traces](#tracing) on the 2 CPU game server in October 2026, with each option answering the same 10 board positions at Azure retail prices. 7 of 10 Cache moves were cache hits; hits are not guaranteed. Times vary with model load.

[![Where MCP's $2.21 per 1,000 moves goes: game state $1.44, instructions $0.46, MCP lookahead $0.27, and Luna's reply $0.04. The MCP tool adds 0.5 seconds per move, down from 2.1 seconds on 0.5 CPU.](docs/images/luna-mcp-cost-breakdown.png)](docs/images/luna-mcp-cost-breakdown.png)

MCP adds 1,375 lookahead tokens per move (+14% cost) and 0.5 s of tool time, down from 2.1 s when the container had 0.5 CPU. Costs and savings are estimates, not invoices; Cache can lower price, not allowance consumption.

### Limits and capacity

- **Player:** new players receive **1,000,000 AI tokens** across all their games. Reported input and output, including cached input, consume the allowance; restarting does not refill it.
- **Room:** shared AI limits and up to 50 online players. **AI tokens left** is the smaller personal/room balance; **Available now** also subtracts pending holds.
- **Throughput:** the server admits up to 80% of the tokens per minute Azure reports in its rate-limit headers, at most 8 Luna calls per second, and at most 4 MCP lookups at a time.
- **Fallback:** manual play remains available when AI limits are reached.

[![How many Luna players at once: a Luna player next to Azure uses about 311K tokens per minute, one in Johannesburg about 246K, and players add up. 6,950K tokens per minute of Azure capacity fits about 22 nearby players, about 16 after the game's 28% safety margin, while the game server's 8 Luna calls per second fit about 14.](docs/images/luna-capacity-scaling.png)](docs/images/luna-capacity-scaling.png)

Measured in October 2026 with bot players making Plain moves for one minute per step: 1, 2 and 4 bots inside the app's container, next to Azure, and 1, 2, 4 and 8 bots in Johannesburg, about 230 ms away. Each move waits for two network round trips, so nearby players move faster and use more tokens per minute. To size capacity for an audience near East US 2, allow about 430K tokens per minute per simultaneous Luna player: about 310K used plus the 28% safety margin (20% spare and the extra each move reserves). The 8 calls per second cap fits about 14 nearby players or about 19 in Johannesburg. With 8 players the server used under 10% of its 2 CPUs, while Luna's replies slowed by about 16%.

## Architecture

Tokenfall is deliberately a small TypeScript application that shows the full path from browser game logic to an Azure-hosted AI model. The diagrams are 16:9 slides; each PNG has an editable `.excalidraw` source next to it in [docs/images](docs/images).

[![Tokenfall architecture: the browser (React and TypeScript) talks to the game server (Node.js and TypeScript) in Azure Container Apps over Socket.IO. The app also contains a local MCP server and SQLite on Azure Files. With a managed identity and no keys, it sends Luna moves to Microsoft Foundry and OpenTelemetry traces to Application Insights, which Foundry shows as traces. azd up deploys everything with Bicep and Docker.](docs/images/architecture.png)](docs/images/architecture.png)

### What runs where

| Part | Built with | Role |
| --- | --- | --- |
| Browser | React 19, Vite, TypeScript | Draws the board, runs the [shared game engine](shared/game.ts) at 60 FPS, and talks to the server over Socket.IO. |
| Game server | Node.js 24, Express 5, Socket.IO 4 | One Container Apps replica with 2 CPUs and 4 GiB. Runs the `.ts` files directly, with no server build. Serves the web app, replays every input to verify scores, and admits Luna requests ([room](server/room.ts), [model gateway](server/model.ts)). |
| Local MCP server | MCP TypeScript SDK, stdio | A child process in the same container, not a separate service. Its read-only `analyze_future_moves` tool simulates the next two placements and never plays a move ([client](server/mcp.ts), [server](server/mcp-server.ts)). |
| SQLite | `node:sqlite` on Azure Files | Stores players, scores, sentences, allowances, and usage in `/data/tokenfall.sqlite`. SQLite has one writer, so the app runs one replica: a test with three replicas crashed all of them and corrupted the database indexes. |
| Managed identity | Microsoft Entra ID | How the app signs in to Azure: `AcrPull` for the image, `Cognitive Services OpenAI User` for Luna, and `Monitoring Metrics Publisher` for traces. Foundry and Application Insights have key auth turned off. |
| Microsoft Foundry | `gpt-5.6-luna`, GlobalStandard | Picks one of the legal placements the server sends, as strict JSON. |
| Application Insights | Azure Monitor, OpenTelemetry | Keeps one trace per Luna move for 30 days in Log Analytics, for the Foundry trace view. |
| azd | Azure Developer CLI, Bicep, Docker | Builds the image, creates the Azure resources in [infra/](infra/main.bicep), and deploys. |

Also used: Zod validates messages and MCP replies, js-tiktoken (`o200k_base`) counts tokens, and the Azure Retail Prices API supplies live prices. Prompts are built in [tokens.ts](server/tokens.ts) from the [policy](server/policy.md).

### Infra flow: `azd up`

[![Infra flow for azd up: package builds the TypeScript app and Docker image; provision runs Bicep to create gpt-5.6-luna in Microsoft Foundry and the container app with its managed identity; deploy pushes the image and deploys a new revision, which pulls the image with the managed identity.](docs/images/infra-flow.png)](docs/images/infra-flow.png)

| Steps | Phase | What happens |
| --- | --- | --- |
| 1 | Package | The [prepackage hook](azure.yaml) runs `npm ci`, `tsc`, and the Vite build; azd then builds the [Docker image](Dockerfile): Node.js 24, non-root, with `server/`, `shared/`, and `web/dist`. |
| 2-4 | Provision | [main.bicep](infra/main.bicep) runs [monitoring.bicep](infra/monitoring.bicep) (Log Analytics, Entra-only Application Insights), [model.bicep](infra/model.bicep) (keyless Foundry resource, `gpt-5.6-luna`, `tokenfall` project), and [hosting.bicep](infra/hosting.bicep) (managed identity and roles, registry, Azure Files, Container App). |
| 5-7 | Deploy | azd pushes the image and deploys a new revision, which pulls the image with the managed identity, mounts `/data`, runs `node server/index.ts`, and serves once `/api/health` passes. |

Provisioning writes the endpoints and the Application Insights connection string to `.azure/<env>/.env`, which the local server also reads. Link the `tokenfall-luna` agent in Foundry once to see traces under **Agents** ([Tracing](#tracing)).

### Azure flow: one Luna move

[![Azure flow for one Luna move: the browser asks Luna; the game server optionally runs the local MCP lookahead, gets a token from its managed identity, sends the board and rules to gpt-5.6-luna in Microsoft Foundry, validates the move and saves usage to SQLite, returns the move to the browser, and sends a trace to Application Insights.](docs/images/azure-flow.png)](docs/images/azure-flow.png)

| Steps | What happens |
| --- | --- |
| 1 | The browser sends an `assist` event with the four options. Before any paid work, the server checks cooldowns, token budgets, and room capacity, then opens the `invoke_agent Luna` span. |
| 2-3 | With MCP on, the server starts the local MCP server and calls `analyze_future_moves`. The reply must pass its Zod schema and match the board's hash, or the request stops before Luna is called. |
| 4 | `ManagedIdentityCredential` gets an Entra ID token, cached between moves. |
| 5-6 | The server sends the rules, board, and legal placements to `gpt-5.6-luna`, which must reply with strict JSON: a `placementId` and a tip. Its rate-limit headers resize the room's limits. |
| 7 | The server accepts only a `placementId` it offered, then saves token usage to SQLite. |
| 8 | The browser re-checks the placement with the shared engine, plays it, and sends the inputs back like any move. |
| 9 | The spans go to Application Insights with the managed identity and reach Foundry within minutes ([Tracing](#tracing)). |

**Luna never controls the browser, and MCP never plays a move:** Luna only picks from legal placements produced by deterministic game code. Joining and manual play make no model calls; the server replays input batches before saving a best score. Locally, your `az login` session replaces the managed identity and `./data` replaces Azure Files.

## Run locally

Requires Node.js 24+, npm, Azure CLI, and Entra access to a Luna deployment (`Cognitive Services OpenAI User`). The checked-in native frontend packages target Windows x64.

Use the selected `azd` environment or configure an existing resource:

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

Open http://127.0.0.1:3100. Local inference uses your Azure CLI sign-in; leave `AZURE_CLIENT_ID` unset because it selects managed identity. Set `AZURE_LOCATION` to your resource's region for pricing.

- **Configuration:** process variables override the root dotenv file, which overrides the selected `azd` environment ([configuration](server/config.ts)).
- **Development:** `npm run dev` watches the backend; rebuild frontend changes with `npm --prefix web run build`.
- **Tracing:** when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set (provisioning stores it in the `azd` environment), local Luna moves are [traced](#tracing) with your Azure CLI identity. Set it to an empty value in the root dotenv file to keep local runs out of the shared traces.
- **Data:** SQLite persists scores, sentences, allowances, and usage under `DATA_DIRECTORY`; boards are lost on restart. A second server needs a different `PORT` and `DATA_DIRECTORY`. Keep databases and backups private.
- **Sharing:** set `HOST=0.0.0.0` and an audience-reachable `PUBLIC_BASE_URL`. A saved `DATA_DIRECTORY/public-url.json` overrides that URL; update it, or stop the old tunnel helper and remove it. Check **Share game** before distributing the link.

## Deploy

[azure.yaml](azure.yaml), [Dockerfile](Dockerfile), and [hosting template](infra/hosting.bicep) configure Azure Container Apps. Packaging requires Docker, PowerShell 7, authenticated `azd`, and the Windows frontend toolchain. For a new environment, `azd up` packages, provisions, and deploys in one step ([infra flow](#infra-flow-azd-up)).

**Updates need downtime because SQLite requires one writer:** [Single revision mode overlaps old and new containers](https://learn.microsoft.com/en-us/azure/container-apps/revisions#zero-downtime-deployment).

1. Disconnect players and wait for pending Luna requests to finish.
2. Disable sticky sessions with `az containerapp ingress sticky-sessions set --affinity none` (supply the app name and resource group), switch to **Multiple** revision mode, and deactivate every active revision. Wait for **zero running replicas on every revision**; zero traffic is not enough.
3. Deploy only after the old replicas have stopped:

   ```powershell
   azd deploy web --environment tokenfall-dev --no-prompt
   ```

4. Verify one healthy new replica and zero older replicas. Route all traffic to the new revision, restore **Single** revision mode, and re-enable sticky sessions with `--affinity sticky`.

For rollback, stop the new revision and wait for zero replicas before activating the previous one. Keep one running replica, one active revision, and no traffic splitting outside maintenance.

- Do not run `azd init` over the configured environment.
- Preview infrastructure changes with `azd provision --preview`; app-only deployment does not update container settings.
- The hosting template sets `TRUST_PROXY_HOPS=1` for ingress-forwarded client addresses; leave it unset locally.
- Preserve Azure Files `nobrl` mounting and SQLite `DELETE` journaling with full synchronization.

## Tracing

[![Luna traces in Microsoft Foundry: the linked tokenfall-luna agent with one trace per move and its tokens, and one trace's agent, tool, and model spans with the token waterfall and provider-reported usage.](docs/images/foundry-luna-traces.png)](docs/images/foundry-luna-traces.png)

How a Luna move reaches Foundry:

1. The [tracing module](server/tracing.ts) wraps each admitted Luna request in an `invoke_agent Luna` span. The MCP lookahead and the model call are child spans, so one move is one trace.
2. Spans follow the [OpenTelemetry GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Every span carries `gen_ai.agent.id` `tokenfall-luna` and the game run as `gen_ai.conversation.id`. The `chat` span records the usage the model returned.
3. Azure Monitor exports the spans with the app's managed identity to Application Insights, which is connected to the `tokenfall` Foundry project.
4. Foundry matches the spans to the linked `tokenfall-luna` agent and lists them under **Build › Agents › tokenfall-luna › Traces**.

| Span | Records |
| --- | --- |
| `invoke_agent Luna` | Options, reserved tokens, move status, and provider-reported usage |
| `execute_tool analyze_future_moves` | MCP lookahead time and result tokens, when MCP is on |
| `chat gpt-5.6-luna` | Response ID, finish reason, and input, output, cache-read, cache-write, and reasoning tokens |

Select a trace to see its spans. Set **Display mode** to **Tokens** for the token waterfall, and select the `chat` span for the input, output, cache, and reasoning tokens. Moves in one game share the conversation ID. Traces arrive within 2-5 minutes and follow the Log Analytics workspace's 30-day retention.

**Link Luna once per project** in [Microsoft Foundry](https://ai.azure.com): **Build › Agents › New agent › Link external agent**, with the agent name and OTel agent ID `tokenfall-luna`. [External agents](https://learn.microsoft.com/azure/foundry/agents/how-to/register-external-agent) are in preview. Without the link, traces still reach Application Insights but do not appear under **Agents**.

The [model template](infra/model.bicep) upgrades the Azure OpenAI resource in place to a Microsoft Foundry resource with the same name, endpoint, and deployment, adds the `tokenfall` project, and connects it to the Entra-only Application Insights resource from the [monitoring template](infra/monitoring.bicep). The app, the project, and the deploying user receive `Monitoring Metrics Publisher`; the user also receives `Log Analytics Reader` and `Foundry User`.

To total usage in Application Insights:

```kusto
dependencies
| where customDimensions["gen_ai.operation.name"] == "chat"
| summarize calls = count(), input = sum(toint(customDimensions["gen_ai.usage.input_tokens"])), output = sum(toint(customDimensions["gen_ai.usage.output_tokens"])) by bin(timestamp, 1h)
```

Traces record token counts, not prompts or replies. Requests rejected before reaching Luna, such as cooldowns or exhausted budgets, are not traced. HTTP auto-instrumentation is off so health probes and Socket.IO polling do not bury the GenAI spans; occasional managed identity token requests still appear as separate traces.

## Reset room data

**Full resets delete saved players, scores, sentences, sessions, and in-app AI history. Everyone must rejoin.** Resets verify a recovery backup first and do not reset Azure billing or provider caches.

For a **stopped local server**, use its actual database path, preview, then replace `YOUR01` with the displayed room code:

```powershell
npm run reset -- --database data\tokenfall.sqlite
npm run reset -- --database data\tokenfall.sqlite --apply --confirm-room YOUR01 --server-stopped
```

Restart afterward. Never pass `--server-stopped` against a running server.

For Azure, preview first and use the returned room code:

```powershell
npm run reset:azure
npm run reset:azure -- -Apply -ConfirmRoom YOUR01
```

The [Azure wrapper](scripts/reset-room.ps1) requires PowerShell 7, `az`, `azd`, and Container App exec/restart permissions. It defaults to `tokenfall-dev`, refuses connected players or pending AI, and restarts the same revision without deploying.

Use `--mode scores` locally or `-Mode scores` on Azure to clear scores while keeping players and AI usage. The unauthenticated browser Admin panel is local-only and off by default; never expose it through a tunnel or enable it on Azure.

## Checks

```powershell
npm test
npm run build
npm --prefix web run lint
npm run test:ui
```

UI tests require Microsoft Edge. Normal tests use isolated databases and make no paid inference calls. The [live evaluator](scripts/evaluate-luna.ts) and [provider smoke checks](scripts/smoke-model.ps1) make paid requests and are not part of normal tests.
