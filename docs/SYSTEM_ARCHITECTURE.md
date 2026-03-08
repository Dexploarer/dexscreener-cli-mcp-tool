# System Architecture

## High-Level Components
1. CLI Layer (`dexplorer_cli/cli.py`)
2. MCP Layer (`dexplorer_cli/mcp_server.py`)
3. Scanner Orchestration (`dexplorer_cli/scanner.py`)
4. API Client + Rate Limiter (`dexplorer_cli/client.py`)
5. Scoring Engine (`dexplorer_cli/scoring.py`)
6. UI Rendering (`dexplorer_cli/ui.py`)
7. Local State (new): presets/tasks store

## Flow Overview
1. User calls CLI or MCP tool.
2. Scanner requests discovery seeds from Dexscreener slow endpoints.
3. Scanner expands tokens to pairs via fast endpoints.
4. Scoring engine ranks candidates.
5. UI or JSON serializer returns output.
6. Optional tasks/presets layer injects scan parameters.

## Sequence (Hot Scan)
1. `token-boosts/top`
2. `token-boosts/latest`
3. `token-profiles/latest`
4. For selected seeds: `token-pairs/{chain}/{token}`
5. Score, rank, and render.

## Rate-Limit Strategy
1. Slow bucket: 60 rpm.
2. Fast bucket: 300 rpm.
3. Sliding window limiter per bucket.
4. Global short TTL cache to collapse duplicate reads.
5. Exponential backoff on `429/5xx`.

## Data Model (Current + Planned)
1. PairSnapshot:
   - token/pair identifiers
   - price, txns, volume, liquidity, market cap, age
2. HotTokenCandidate:
   - PairSnapshot + score + tags + boost/profile context
3. Scan Preset (planned):
   - named filters/chains/limits
4. Scan Task (planned):
   - name, preset or inline filters
   - status (`todo`, `running`, `done`, `blocked`)
   - notes, timestamps

## Persistence Layout (Planned)
Base directory:
`%USERPROFILE%/.dexplorer-cli/`

Files:
1. `presets.json`
2. `tasks.json`

Rationale:
1. No external DB dependency.
2. Human-readable backups.
3. Easy MCP + CLI shared access.

## Concurrency Model
1. Async HTTP via `httpx.AsyncClient`.
2. Semaphore-bounded fanout for pair expansion.
3. Shared cache + limiters per client instance.

## Terminal UI Architecture
1. Header panel.
2. Main leaderboard table.
3. Supplemental summary panels (chain heat, flow quality, risk notes).
4. Full-screen watch mode via `rich.Live`.

## MCP Architecture
1. `FastMCP` server exposing scanner primitives.
2. Planned extension tools:
   - list/create/update tasks
   - run task scan by name

## Error Handling
1. API request errors -> retry/backoff, then surfaced cleanly.
2. Missing results -> explicit "not found" responses.
3. Unsupported metrics -> explicit note (no holder table data in public API).

## Security and Safety
1. Read-only market data operations.
2. No private keys, no signing.
3. Local file writes only for tasks/presets metadata.

## Future Extensions
1. External adapters for true holder concentration data.
2. Alerting webhooks.
3. Historical signal snapshots for backtesting.
