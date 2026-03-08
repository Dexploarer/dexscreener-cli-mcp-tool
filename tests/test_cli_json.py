from __future__ import annotations

import json

from typer.testing import CliRunner

from dexplorer_cli.cli import app
from dexplorer_cli.models import PairSnapshot


def _make_pair(**overrides: object) -> PairSnapshot:
    defaults = dict(
        chain_id="solana",
        dex_id="raydium",
        pair_address="PAIR1",
        pair_url="https://dexscreener.com/solana/PAIR1",
        base_address="TOKEN1",
        base_symbol="TEST",
        base_name="Test Token",
        quote_symbol="SOL",
        price_usd=0.01,
        volume_h24=500_000.0,
        volume_h6=100_000.0,
        volume_h1=20_000.0,
        volume_m5=1_000.0,
        buys_h1=150,
        sells_h1=100,
        buys_h24=2000,
        sells_h24=1500,
        price_change_h1=5.0,
        price_change_h24=12.0,
        liquidity_usd=200_000.0,
        market_cap=1_000_000.0,
        fdv=2_000_000.0,
        holders_count=500,
        holders_source="geckoterminal",
        pair_created_at_ms=None,
        raw={},
    )
    defaults.update(overrides)
    return PairSnapshot(**defaults)  # type: ignore[arg-type]


class _FakeClient:
    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def get_orders(self, _chain: str, _address: str) -> dict[str, object]:
        return {
            "boosts": [{"amount": 10}],
            "orders": [{"type": "tokenProfile"}],
        }


class _FakeScanner:
    def __init__(self, _client: object) -> None:
        return None

    async def search(self, query: str, limit: int = 20) -> list[PairSnapshot]:
        return [_make_pair(base_symbol=query.upper(), pair_address=f"PAIR{limit}")]

    async def inspect_token(self, chain_id: str, token_address: str) -> list[PairSnapshot]:
        return [_make_pair(chain_id=chain_id, base_address=token_address, pair_address="PAIRX")]

    async def inspect_pair(self, chain_id: str, pair_address: str) -> PairSnapshot:
        return _make_pair(chain_id=chain_id, pair_address=pair_address)


async def _noop_hydrate(*_args: object, **_kwargs: object) -> None:
    return None


def test_search_json_output(monkeypatch) -> None:
    monkeypatch.setattr("dexplorer_cli.cli.DexplorerClient", _FakeClient)
    monkeypatch.setattr("dexplorer_cli.cli.HotScanner", _FakeScanner)
    monkeypatch.setattr("dexplorer_cli.cli.hydrate_pair_holders", _noop_hydrate)

    runner = CliRunner()
    result = runner.invoke(app, ["search", "pepe", "--limit", "1", "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload[0]["tokenSymbol"] == "PEPE"
    assert payload[0]["pairAddress"] == "PAIR1"


def test_inspect_json_output(monkeypatch) -> None:
    monkeypatch.setattr("dexplorer_cli.cli.DexplorerClient", _FakeClient)
    monkeypatch.setattr("dexplorer_cli.cli.HotScanner", _FakeScanner)
    monkeypatch.setattr("dexplorer_cli.cli.hydrate_pair_holders", _noop_hydrate)

    runner = CliRunner()
    result = runner.invoke(app, ["inspect", "TOKENX", "--chain", "solana", "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["primaryPair"]["tokenAddress"] == "TOKENX"
    assert payload["boostTotal"] == 10.0
    assert payload["hasProfile"] is True
