from __future__ import annotations

import asyncio

import pytest

from dexplorer_cli import mcp_server


def test_import_state_bundle_rejects_non_object_bundle() -> None:
    result = asyncio.run(mcp_server.import_state_bundle([]))  # type: ignore[arg-type]
    assert result["error"] == "Bundle must be a JSON object"


def test_import_state_bundle_rejects_non_array_sections() -> None:
    result = asyncio.run(
        mcp_server.import_state_bundle(  # type: ignore[arg-type]
            {"presets": {}, "tasks": [], "runs": []},
        )
    )
    assert result["error"] == "Bundle presets/tasks/runs must be arrays"


def test_list_task_runs_rejects_invalid_limit() -> None:
    with pytest.raises(ValueError, match="limit must be between 1 and 500"):
        asyncio.run(mcp_server.list_task_runs(limit=0))
