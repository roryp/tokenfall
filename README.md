# Tokenfall

A mobile-first Tetris arcade for a live audience workshop about LLM tokens, prompt caching, and lossless prompt compression. The deterministic Tetris engine runs immediately in the browser; GPT-5.6 Luna selects optional legal moves using real Azure inference. The server verifies game inputs and broadcasts the leaderboard every 500 ms.

## Azure Model

- Default region: **East US 2**. Provision into your own Azure subscription.
- Resource group and account names are generated from the selected azd environment.
- Deployment: **gpt-5.6-luna**, model version **2026-07-09**, GlobalStandard, 500 capacity units.
- Provisioned with `azd provision`; only the model is deployed to Azure. The web application runs locally.
- Every inference request sets `reasoning_effort: "none"`. A move is rejected unless the response reports exactly zero reasoning tokens.
- Entra authentication through your Azure CLI session. Azure API-key authentication is disabled on the resource.

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

The server deliberately binds only to loopback. For a different port, set `$env:PORT = '3101'` before starting, then pass the matching port to the tunnel launcher. If a port is occupied, choose a free one rather than terminating an unrelated process.

After client edits, run `npm --prefix web run build`. After server edits, restart `npm start`; `npm run dev` enables server file watching. Both processes use the already deployed model.

## Audience QR Access

To allow up to 50 players to reach the local game through a public HTTPS tunnel, run the following while the local server is running:

```powershell
Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '.\data\cloudflared.exe'
Get-AuthenticodeSignature '.\data\cloudflared.exe'
& .\scripts\start-tunnel.ps1 -Port 3100
```

Verify that the executable has a valid Cloudflare, Inc. signature before running it. The launcher writes its public HTTPS address to the ignored local state file; the QR and join link update automatically. The QR includes the current room code and never uses localhost. Audience phones can use another Wi-Fi network or mobile data.

Keep **both the local server and the tunnel running**, and keep the laptop awake. Stop each with Ctrl+C. An anonymous Cloudflare quick tunnel has no uptime guarantee and changes address when restarted. For an important production event, use a named tunnel or deploy the application to a stable hosting service; the current application is intentionally local-first.

No public host-administration endpoints exist. The projector is read-only. Infrastructure and room maintenance remain local host operations.

## Teaching Flow

1. Put the projector view on screen. Audience members scan the QR, choose a nickname, and play.
2. In **Token splitter**, compare `hello world` with a long word or punctuation. Token IDs and boundaries come from the actual `o200k_base` tokenizer. This is a local encoding estimate, not an authoritative Luna billing count, and makes no model call.
3. Ask Luna for a move with **Compress** off. Inspect the verbose board JSON and the Azure-reported input/output usage.
4. Enable **Compress** and repeat on the same paused board. The packed representation retains every cell, hidden row, piece, preview item, and candidate measurement. It removes verbose cell objects and formatting, not gameplay information. The receipt records the mode used for that request.
5. Enable **Cache prefix** and repeat eligible requests. A meaningful, stable policy precedes the changing board data; an explicit breakpoint marks the reusable prefix. Compare actual `cached_tokens` and `cache_write_tokens`. A second request is not guaranteed to hit immediately; the UI never invents a hit.
6. Apply Luna's legal placement and return to Tetris. The move uses the engine's legal input path. On phones, visiting the lab pauses the game; a model-assisted move made from the paused lab returns to the paused state.

**Important distinctions:** A tetromino has four blocks, not four LLM tokens. Cache reads reuse prefix computation, not an entire answer. Cached tokens still count toward input and context limits. GPT-5.6 cache writes can cost extra. Compression saves submitted text tokens; caching saves repeated computation. Neither adds fictional Tetris points.

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

The shared rules layer uses `miaoda-game-fallblock-core` for SRS orientations and kicks, collisions, ghosting, hold swaps, lock delay, seven-bag queues, and rigid row clearing. The controller adds guideline-style scoring, combos, back-to-back clears, T-spin detection, perfect clears, level progression, a 500 ms lock delay, and a 15-reset lock limit. The board has 10 x 20 visible cells plus two hidden spawn rows.

The leaderboard shows each player's **best run**. A new run can have a lower current score than the stored best. All players use the same seeded piece sequence. The server recomputes scores from timestamped inputs; it never accepts client-supplied score fields. This is verification for a friendly workshop, not a cheat-proof competitive tournament or an identity-authenticated ranking service.

## Limits And Persistence

- 50 connected players; 500 total registered players per persisted room.
- 80,000 reported input-plus-output tokens per player and 2,000,000 per room. Cache reads remain included. Preflight reservations include estimated request size and headroom.
- At most four simultaneous model requests, 90 requests/minute, and 400,000 estimated reserved tokens/minute. Busy requests are rejected with a retry hint; manual gameplay continues.
- Eight-second per-player inference cooldown, 40 attempted model calls per player, and 1,000 per room. Restarting a game does not reset allowances.
- Model output is capped at 128 tokens. Requests time out after 20 seconds and are not automatically retried, avoiding accidental duplicate spend.
- Budgets are application guards, not Azure billing caps. Failed or timed-out requests can still incur provider charges when no usage response is available. No dollar savings are estimated without verified pricing.
- Nicknames, hashed session credentials, best scores, and usage totals persist in the local SQLite database under the ignored data directory. Do not publish that directory.
- Page reloads and connection interruptions restore the same tab's active game while the server is running. A full server restart preserves best scores and allowances but starts a fresh active board.
- Active games, session recovery, and the leaderboard are single-process. There is no Redis, cloud database, cross-process failover, or horizontal scaling in this local workshop version.
- Only fixed game data is sent to Azure. Audience names and arbitrary tokenizer text are not sent to Luna. Prompts use `store: false`; the explicit prompt cache remains provider-managed.

## Provision The Model

The deployment is defined in [azure.yaml](azure.yaml) and [infra/main.bicep](infra/main.bicep). For an existing selected environment:

```powershell
azd auth login --check-status
azd provision --no-prompt
```

For a fresh checkout, sign in to Azure CLI and azd using the same account and tenant, select your intended Azure CLI subscription, then create an azd environment. Select that same subscription when prompted. Set the inference principal before provisioning:

```powershell
azd env new tokenfall-dev --location eastus2
$principal = az ad signed-in-user show --query id --output tsv
azd env set AZURE_PRINCIPAL_ID $principal
azd provision
```

Model version, SKU support, regional quota, and access can change. Recheck them before deploying this template into another subscription. GlobalStandard is pay-per-token; allocated capacity is not a prepaid token balance.

## Verification

```powershell
npm test
npm run build
npm --prefix web run lint
& .\scripts\smoke-model.ps1
```

The model smoke test makes paid Azure requests. It checks structured legal choices, zero reasoning, actual cache reuse, and a cache-disabled request. Warm-up is bounded to six eligible requests plus one disabled request. A lack of cache reuse is reported as a failed observation, not silently replaced with simulated telemetry.

The automated suite contains 29 tests covering game rules, exact replay, codec round trips, token accounting, stale inference, quotas, persistence, reconnects, rejected score injection, and 50 real simultaneous WebSocket clients. Initial Playwright validation covered 320, 375, 390, 768, 1440, 1600, and 1920 px layouts; desktop keys; mobile touch; the public HTTPS join flow; real model-assisted moves; token splitting; and a live projector QR. A live public-mobile test observed 1,549 cache-read tokens and zero reasoning tokens.

To remove the Azure resources when no longer needed, review the selected azd environment and run `azd down` yourself. It deletes the model's resource group; stopping the local app alone does not delete the Azure deployment.