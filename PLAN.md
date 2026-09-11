# Tokenfall: Local-First Audience Tetris

## Confirmed Scope

- Up to 50 concurrent audience players, with mobile touch and desktop keyboard input.
- Deploy only the LLM to Azure first, using azd. Run the application locally.
- Use an explicitly selected Azure subscription, an environment-scoped resource group, and East US 2 by default.
- Exact model: gpt-5.6-luna, version 2026-07-09, GlobalStandard.
- Every inference request must explicitly set reasoning_effort to none.
- Open a public HTTPS tunnel for audience QR access after local validation.

## Implementation Stages

1. Provision the model with azd and keyless, least-privilege inference access. Validate the template, then smoke-test the deployed model and inspect real usage.
2. Build standard single-player Tetris around an existing rules engine: 10 by 20 visible board, seven-bag randomizer, SRS rotation, hold, next queue, ghost, soft/hard drop, lock delay, line clears, level progression, and standard scoring.
3. Add real model-assisted moves from legal current-board placements. Keep game animation independent of request latency; reject stale suggestions. No fake AI moves or fabricated usage.
4. Add a token lab to the live game. Compare verbose and losslessly packed board context, show locally encoded token estimates separately from Azure-reported usage, and display input, output, cache-read, cache-write, and reasoning tokens.
5. Use explicit cache breakpoints on a reusable, meaningful Tetris policy of at least 1,024 tokens. A caching toggle changes actual request policy. Cache hits are observed, never promised. Cache writes can cost extra; caching does not shrink the context window.
6. Publish a live server-verified leaderboard and projector room view with a QR code. Keep official Tetris score separate from token efficiency; do not give fictional score bonuses for cache hits.
7. Validate game rules, token accounting, compression round trips, invalid and stale model outputs, reconnect behavior, and multi-client leaderboard updates. Inspect desktop and mobile screenshots and perform touch gameplay before opening the tunnel.

## Architecture And Guardrails

- TypeScript game logic shared between the browser and server; React/Vite client, Node server, and WebSocket room updates.
- Game input replay is validated server-side; clients cannot submit leaderboard scores.
- Persist leaderboard records locally; active games remain in memory. This first version is a single-server workshop deployment, not a distributed production service.
- Azure credentials remain on the server. Audience nicknames and personal data are not sent to the model.
- Bound request size, output tokens, concurrent inference, request rate, player count, and token budgets. Model outages must leave manual Tetris playable.
- No public host-administration endpoints are exposed. The projector is read-only; host operations are local. The QR URL must never be localhost.
- The public tunnel exposes the game only while its process and the local server are running. Keep the laptop awake for the session.

## Verification Gates

- azd provision succeeds for the exact requested model.
- Live inference succeeds with reported reasoning tokens equal to zero.
- Repeated eligible requests demonstrate actual Azure cache reads, with cold writes also recorded.
- Compression preserves every board cell and reduces encoded payload tokens.
- Rules tests, server protocol tests, type checks, production build, mobile interaction, and live leaderboard checks pass.
- Local and public URLs render the actual game; QR joins the correct room from a mobile-sized browser.

## Completion Record

- Exact Luna deployment provisioned successfully through azd in the approved subscription.
- Live Azure requests verified zero reasoning, explicit cache writes, cache reads, and cache-disabled behavior.
- Standard rules, token handling, replay verification, persistence, and 50 simultaneous socket clients validated.
- Desktop and mobile gameplay verified in Playwright, including real model choices applied on paused boards.
- Public HTTPS tunnel opened with approval; QR and mobile join path verified against the running local server.
- Mobile controls verified at 44 px minimum; responsive layouts checked from 320 px through 1920 px.
- Operational limitations and repeatable startup, verification, and teardown commands recorded in README.md.