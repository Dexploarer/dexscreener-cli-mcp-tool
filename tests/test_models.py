from __future__ import annotations

from dexplorer_cli.models import PairSnapshot


def test_pair_snapshot_from_api_handles_non_dict_nested_payloads() -> None:
    pair = PairSnapshot.from_api(
        {
            "chainId": "solana",
            "dexId": "raydium",
            "pairAddress": "PAIR1",
            "url": "https://dexscreener.com/solana/PAIR1",
            "baseToken": "bad",
            "quoteToken": None,
            "txns": "bad",
            "volume": [],
            "priceChange": "oops",
            "liquidity": 7,
            "marketCap": "1000",
            "fdv": "2000",
        }
    )

    assert pair.base_address == ""
    assert pair.base_symbol == ""
    assert pair.quote_symbol == ""
    assert pair.txns_h1 == 0
    assert pair.volume_h24 == 0.0
    assert pair.price_change_h1 == 0.0
    assert pair.liquidity_usd == 0.0
