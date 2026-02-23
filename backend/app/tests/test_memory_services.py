from datetime import datetime, timedelta, timezone
import asyncio

from app.core.config import settings
from app.services.context_assembler import format_long_term_memories, format_recall
from app.services.embedding_service import compute_embedding
from app.services.memory_extract_service import _is_high_signal
from app.services.token_counter import estimate_tokens


def test_estimate_tokens_monotonic():
    short = "你好 world"
    long = short * 20
    assert estimate_tokens(short) > 0
    assert estimate_tokens(long) > estimate_tokens(short)


def test_signal_filter():
    assert _is_high_signal([{"role": "user", "content": "我叫小明，住在深圳"}]) is True
    assert _is_high_signal([{"role": "user", "content": "嗯"}]) is False


def test_compute_embedding_disabled_returns_none():
    prev_enabled = settings.embedding_enabled
    prev_url = settings.embedding_api_url
    settings.embedding_enabled = False
    settings.embedding_api_url = ""
    try:
        vec = asyncio.run(compute_embedding("hello"))
        assert vec is None
    finally:
        settings.embedding_enabled = prev_enabled
        settings.embedding_api_url = prev_url


def test_formatters():
    now = datetime.now(timezone.utc)
    memories = [
        {
            "type": "identity",
            "content": "用户住在杭州",
            "created_at": now - timedelta(days=2),
        },
        {
            "type": "correction",
            "content": "用户已从深圳搬到杭州",
            "created_at": now - timedelta(days=1),
        },
    ]
    text = format_long_term_memories(memories, now)
    assert "[长期记忆]" in text
    assert "重要纠正" in text

    recall = format_recall(
        [
            {"summary": "用户讨论 React + Vite", "created_at": now - timedelta(days=5)},
        ],
        now,
    )
    assert "用户讨论 React + Vite" in recall
