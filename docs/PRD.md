# Product Requirements Document (PRD)

## Product
`dexplorer-cli-mcp-tool`

## Date
March 3, 2026

## Problem Statement
Traders use Dexscreener to find early momentum and chain-specific breakout tokens, but doing this through browser tabs is slow, noisy, and hard to automate.

## Goals
1. Let users discover hot tokens by chain directly in terminal.
2. Provide an operator-grade visual interface for fast scan/read/act workflows.
3. Expose the same intelligence through MCP for agent automation.
4. Stay compliant with Dexscreener public API rate limits.
5. Add a reusable task system for repeatable scan setups.

## Non-Goals
1. Trade execution and wallet signing.
2. Guaranteed alpha/risk prediction.
3. True holder-level distribution analytics from Dexscreener (not available in public API).

## Target Users
1. Meme/altcoin momentum traders.
2. Cross-chain explorers scanning Solana/Base/BSC/EVM ecosystems.
3. Quant/automation users integrating scanners into MCP clients.

## Core User Jobs
1. "Show me what is getting hot now on chains I care about."
2. "Tell me if activity is real (liquidity, txns, volume) or just noise."
3. "Save my filters and rerun them quickly."
4. "Track repeatable scan jobs with status and notes."
5. "Use same data from an MCP client."

## Functional Requirements
1. Hot Scan:
   - Pull seeds from boosts/profiles endpoints.
   - Expand via token-pairs endpoints.
   - Rank by weighted hotness score.
2. Visual Board:
   - Color-coded leaderboard.
   - Chain heat summaries.
   - Optional watch mode with refresh cadence.
3. Search/Inspect:
   - Search across pairs.
   - Inspect token or pair details with flow metrics.
4. Presets:
   - Save/load named filter profiles.
5. Task System:
   - Create named scan tasks.
   - Store chains, thresholds, schedule hints, notes, and status.
   - Run scan by task name.
6. MCP:
   - Existing tools remain.
   - Add tools for presets/tasks execution.

## Non-Functional Requirements
1. Respect Dexscreener rate classes (60 rpm / 300 rpm).
2. Caching and retry/backoff for reliability.
3. Works locally without paid API keys.
4. Clean terminal rendering in standard Windows/Linux terminals.

## Data Constraints
1. Public Dexscreener API does not expose holder distribution tables.
2. Distribution view must be explicitly heuristic/proxy-based.

## Success Metrics
1. Setup to first successful scan in under 3 minutes.
2. Watch mode stable for 30+ minutes without rate-limit failures.
3. Users can create and run named tasks without editing code.
4. MCP client can call hot scan and task-based scan.

## Risks
1. API schema drift.
2. High-velocity market bursts increasing call pressure.
3. Misinterpretation of proxy concentration metrics.

## Mitigations
1. Defensive parsing and retries.
2. Bounded fanout + caching + endpoint-specific limiters.
3. Explicit warnings where data is inferred.
