from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import Literal, TypedDict

if os.name == "nt":
    import msvcrt


ActionType = Literal["chain", "sort", "copy", "select"]


class ControlAction(TypedDict):
    type: ActionType
    value: str


def _sanitize_clipboard(payload: str) -> str:
    """Strip control characters and limit length for clipboard safety."""
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", payload)
    return cleaned[:500]


def copy_to_clipboard(payload: str) -> bool:
    safe_payload = _sanitize_clipboard(payload)
    try:
        if os.name == "nt":
            clip_path = shutil.which("clip") or r"C:\Windows\System32\clip.exe"
            subprocess.run([clip_path], input=safe_payload, text=True, check=True)
            return True
        if os.name == "posix":
            candidates = [
                (["pbcopy"], "pbcopy"),
                (["wl-copy"], "wl-copy"),
                (["xclip", "-selection", "clipboard"], "xclip"),
            ]
            for cmd, name in candidates:
                resolved = shutil.which(name)
                if not resolved:
                    continue
                cmd[0] = resolved
                try:
                    subprocess.run(cmd, input=safe_payload, text=True, check=True)
                    return True
                except Exception:
                    continue
    except Exception:
        return False
    return False


class WatchKeyboardController:
    def __init__(
        self,
        *,
        chains: tuple[str, ...],
        sort_modes: tuple[str, ...],
        initial_chain: str,
        initial_sort_mode: str,
    ) -> None:
        self._chains = chains
        self._sort_modes = sort_modes
        self._selected_index = 0

        try:
            self._chain_idx = self._chains.index(initial_chain)
        except ValueError:
            self._chain_idx = 0

        try:
            self._sort_idx = self._sort_modes.index(initial_sort_mode)
        except ValueError:
            self._sort_idx = 0

    @property
    def chain(self) -> str:
        return self._chains[self._chain_idx]

    @property
    def sort_mode(self) -> str:
        return self._sort_modes[self._sort_idx]

    @property
    def selected_index(self) -> int:
        return self._selected_index

    def clamp_selection(self, *, row_count: int) -> None:
        if row_count <= 0:
            self._selected_index = 0
            return
        if self._selected_index >= row_count:
            self._selected_index = row_count - 1

    def _read_key(self) -> str | None:
        if os.name != "nt":
            return None
        if not msvcrt.kbhit():
            return None
        try:
            raw = msvcrt.getwch()
        except Exception:
            return None
        if not raw:
            return None
        # swallow escaped arrow lead keys
        if raw in ("\x00", "\xe0"):
            try:
                msvcrt.getwch()
            except Exception:
                pass
            return None
        return raw.lower()

    def poll(self, *, row_count: int) -> ControlAction | None:
        key = self._read_key()
        if key is None:
            return None

        if key.isdigit():
            idx = int(key) - 1
            if 0 <= idx < len(self._chains):
                self._chain_idx = idx
                self._selected_index = 0
                return {"type": "chain", "value": self.chain}
            return None

        if key == "s":
            self._sort_idx = (self._sort_idx + 1) % len(self._sort_modes)
            self._selected_index = 0
            return {"type": "sort", "value": self.sort_mode}

        if key == "j":
            if row_count > 0:
                self._selected_index = min(self._selected_index + 1, row_count - 1)
                return {"type": "select", "value": str(self._selected_index)}
            return None

        if key == "k":
            if row_count > 0:
                self._selected_index = max(self._selected_index - 1, 0)
                return {"type": "select", "value": str(self._selected_index)}
            return None

        if key == "c":
            return {"type": "copy", "value": "selected"}

        return None
