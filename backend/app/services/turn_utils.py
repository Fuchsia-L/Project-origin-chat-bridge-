from __future__ import annotations


def count_user_rounds(messages: list[dict]) -> int:
    return sum(1 for m in messages if m.get("role") == "user")


def user_turn_spans(messages: list[dict]) -> list[tuple[int, int]]:
    user_indices = [i for i, m in enumerate(messages) if m.get("role") == "user"]
    if not user_indices:
        return []
    spans: list[tuple[int, int]] = []
    for idx, start in enumerate(user_indices):
        end = (user_indices[idx + 1] - 1) if idx + 1 < len(user_indices) else (len(messages) - 1)
        spans.append((start, end))
    return spans


def last_n_round_messages(messages: list[dict], rounds: int) -> list[dict]:
    if rounds <= 0:
        return []
    spans = user_turn_spans(messages)
    if not spans:
        return messages
    if len(spans) <= rounds:
        return messages
    start_idx = spans[-rounds][0]
    return messages[start_idx:]


def last_n_round_start_index(messages: list[dict], rounds: int) -> int:
    if rounds <= 0:
        return 0
    spans = user_turn_spans(messages)
    if not spans:
        return max(0, len(messages) - rounds)
    if len(spans) <= rounds:
        return 0
    return spans[-rounds][0]
