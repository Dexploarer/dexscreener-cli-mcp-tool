# Desk of Best Traders - Alpha Upgrade Notes

Date consulted: 2026-03-03  
Source command:

```bash
python ../desk-of-best-traders/scripts/desk.py --trade --timeout 180 "You are advising a terminal-only Dexplorer scanner product..."
```

## Key Recommendations
1. Enforce strict anti-noise gates first; alpha is mostly false-positive rejection.
2. Keep runner defaults liquidity-aware (`$50k` class liquidity on fast chains when possible).
3. Prefer simple momentum signatures over many indicators:
   - volume acceleration
   - breakout continuation
   - buyer/seller pressure
4. Use hard guardrails in realtime alerts:
   - cooldowns
   - alerts/hour cap
   - risk gates for thin/liquidity-trap candidates
5. Keep terminal UX compact:
   - readable columns
   - color hierarchy
   - inline pulse cues
   - avoid over-wide tables

## Applied In This Repo
1. Added `alpha-drops` and `alpha-drops-watch` with multi-chain defaults (`base,solana`) and quality gates.
2. Increased default runner liquidity gates and added `--max-vol-liq-ratio` anti-thin filter.
3. Added alert frequency cap in `alpha-drops-watch` via `--alert-max-per-hour`.
4. Improved discovery with search-seed augmentation so non-Solana chains are not under-covered.
5. Compacted runner table layout and added a `Pulse` column for quick tape reading.
6. Updated `top-new` to include `24h txns` filtering (`--min-txns-h24`) and display.

## Practical Defaults (Current)
1. Runner scans:
   - `--min-liquidity-usd 25000+`
   - `--max-vol-liq-ratio 60`
2. Alpha drops:
   - `--min-liquidity-usd 35000`
   - `--min-volume-h24-usd 90000`
   - `--min-txns-h1 80`
3. Realtime:
   - `--interval 6`
   - `--alert-cooldown-seconds 300`
   - `--alert-max-per-hour 8`
