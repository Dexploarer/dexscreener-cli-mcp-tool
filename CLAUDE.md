# CLAUDE.md - Dexplorer CLI + MCP + Skills

## What This Is

An **unofficial** CLI scanner, MCP server, and AI skill for Dexscreener token signals. Not affiliated with or endorsed by Dexscreener. All APIs used are free and public - no keys required to get started. Scores tokens 0-100 based on volume, liquidity, momentum, and flow pressure across Solana, Base, Ethereum, BSC, and Arbitrum.

## Quick Commands

```bash
npm run build                       # Build TypeScript
node dist/cli.js hot --chains solana --limit 10  # Scan hot tokens
node dist/cli.js watch --interval 7              # Live dashboard
node dist/cli.js search pepe                     # Search tokens
node dist/cli.js doctor                          # Diagnose setup issues
node dist/mcp-server.js                          # Start MCP server
```

## Project Structure

```
src/
  cli.ts          - CLI commands (Commander). Entry point: ds
  mcp-server.ts   - MCP server (@modelcontextprotocol/sdk). Entry point: dexplorer-mcp
  scanner.ts      - Token discovery, scoring pipeline
  scoring.ts      - 8-component scoring engine (0-100)
  models.ts       - PairSnapshot, HotTokenCandidate, CandidateAnalytics
  holders.ts      - Multi-provider holder counts (GeckoTerminal -> Moralis -> Blockscout -> Honeypot)
  client.ts       - Dexscreener API client with rate limiting
  config.ts       - Constants, ScanFilters interface
  state.ts        - Presets/tasks persistence (~/.dexplorer-cli/)
  alerts.ts       - Discord/Telegram/webhook alert delivery with SSRF protection
  task-runner.ts  - Task execution and scheduling
  index.ts        - Public API re-exports
```

## Key Architecture

- **Filter cascade**: `resolvedFilters()` in cli.ts resolves: hardcoded defaults -> "default" preset -> explicit preset -> CLI flags
- **Scoring**: 8 weighted components in scoring.ts produce a 0-100 score per token
- **Scan profiles**: strict/balanced/discovery baselines in cli.ts with chain multipliers
- **MCP server**: Mirrors CLI functionality via @modelcontextprotocol/sdk tools in mcp-server.ts
- **State**: JSON files in ~/.dexplorer-cli/ (presets.json, tasks.json, runs.json)

## Testing

```bash
node dist/cli.js hot --chains solana --limit 5 --json  # Quick JSON scan test
node dist/cli.js doctor                                 # Health check
```

## Dependencies

Node.js 18+, @modelcontextprotocol/sdk, commander, chalk, zod, dotenv. Optional: MORALIS_API_KEY env var for holder data.
