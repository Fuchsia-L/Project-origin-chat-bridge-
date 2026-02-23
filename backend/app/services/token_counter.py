from __future__ import annotations

import re


def estimate_tokens(text: str) -> int:
    """Rough token estimate for budget control."""
    if not text:
        return 0

    try:
        import tiktoken  # type: ignore

        enc = tiktoken.get_encoding("cl100k_base")
        return max(1, len(enc.encode(text)))
    except Exception:
        pass

    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", text))
    latin_words = len(re.findall(r"[A-Za-z0-9_]+", text))
    other_chars = max(0, len(text) - cjk_chars)

    # Heuristic:
    # - Chinese: ~1.5 chars/token => chars / 1.5
    # - English: ~0.75 words/token => words / 0.75
    # - Other chars: very rough 4 chars/token
    estimated = int((cjk_chars / 1.5) + (latin_words / 0.75) + (other_chars / 4))
    return max(1, estimated)
