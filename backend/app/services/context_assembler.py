from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
import re
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.db import SessionLocal
from app.models import LayeredMemory, Project, ProjectType
from app.services.embedding_service import search_relevant_chunks
from app.services.memory_extract_service import get_active_memories
from app.services.summary_service import get_latest_summary
from app.services.token_counter import estimate_tokens
from app.services.turn_utils import last_n_round_messages

TYPE_LABELS = {
    "identity": "关于用户",
    "preference": "用户偏好",
    "fact": "用户事实",
    "correction": "重要纠正",
    "relationship": "人际关系",
    "commitment": "近期计划",
    "status": "近期状态",
}

TYPE_ORDER = ["correction", "identity", "preference", "relationship", "commitment", "fact", "status"]

logger = logging.getLogger(__name__)
UTC_OFFSET_PATTERN = re.compile(r"^UTC([+-])(\d{1,2})(?::?(\d{2}))?$", re.IGNORECASE)


def _days_ago(ts: datetime, now: datetime) -> str:
    delta = now - ts
    days = max(0, delta.days)
    if days == 0:
        return "今天"
    return f"{days}天前"


def _fit_text_to_tokens(text: str, budget_tokens: int) -> str | None:
    if budget_tokens <= 0:
        return None
    if estimate_tokens(text) <= budget_tokens:
        return text

    left = 0
    right = len(text)
    best = ""
    while left <= right:
        mid = (left + right) // 2
        candidate = text[:mid].rstrip() + "..."
        t = estimate_tokens(candidate)
        if t <= budget_tokens:
            best = candidate
            left = mid + 1
        else:
            right = mid - 1
    return best or None


def format_long_term_memories(memories: list[dict], current_time: datetime | None = None) -> str:
    if not memories:
        return ""
    now = current_time or datetime.now(timezone.utc)
    grouped: dict[str, list[str]] = {k: [] for k in TYPE_ORDER}
    for m in memories:
        memory_type = m.get("type", "fact")
        created_at = m.get("created_at") or now
        when = _days_ago(created_at, now) if isinstance(created_at, datetime) else "近期"
        suffix = "用户纠正" if memory_type == "correction" else "了解到"
        grouped.setdefault(memory_type, []).append(f"  {m.get('content', '')}（{when}{suffix}）")

    lines = ["[长期记忆]", f"当前时间：{now.year}年{now.month}月{now.day}日 {now.strftime('%H:%M')}"]
    for t in TYPE_ORDER:
        items = grouped.get(t) or []
        if not items:
            continue
        lines.append("")
        lines.append(f"{TYPE_LABELS.get(t, t)}：")
        lines.extend(items)
    return "\n".join(lines).strip()


def format_recall(chunks: list[dict], current_time: datetime | None = None) -> str:
    if not chunks:
        return ""
    now = current_time or datetime.now(timezone.utc)
    lines: list[str] = []
    for c in chunks:
        created_at = c.get("created_at")
        if isinstance(created_at, datetime):
            when = _days_ago(created_at, now)
        else:
            when = "近期"
        lines.append(f"· {when} — {c.get('summary', '')}")
    return "\n".join(lines)


def _format_layered_memories(
    title: str,
    rows: list[LayeredMemory],
    now: datetime,
    max_items: int,
) -> str:
    if not rows:
        return ""
    lines: list[str] = [f"[{title}]"]
    grouped: dict[str, list[str]] = {}
    for row in rows[:max_items]:
        when = _days_ago(row.updated_at, now) if isinstance(row.updated_at, datetime) else "近期"
        grouped.setdefault(row.category, []).append(f"- {row.content}（重要度{row.importance}，{when}）")
    for category, items in grouped.items():
        lines.append(f"{category}:")
        lines.extend(items)
    return "\n".join(lines).strip()


def _take_rows_by_tokens(
    rows: list[LayeredMemory],
    max_tokens: int,
    *,
    title: str,
    now: datetime,
    max_items: int = 50,
) -> str:
    if max_tokens <= 0:
        return ""
    taken: list[LayeredMemory] = []
    for row in rows:
        candidate = _format_layered_memories(title, taken + [row], now, max_items=max_items)
        if estimate_tokens(candidate) > max_tokens:
            break
        taken.append(row)
    return _format_layered_memories(title, taken, now, max_items=max_items)


def context_token_budget(total: int) -> dict[str, int]:
    total = max(1024, total)
    return {
        "system": max(400, int(total * 0.10)),
        "user_global": max(220, int(total * 0.06)),
        "character": max(320, int(total * 0.08)),
        "project": max(260, int(total * 0.07)),
        "cross_session": max(420, int(total * 0.10)),
        "summary": max(360, int(total * 0.08)),
        "recall": max(360, int(total * 0.08)),
    }


def _resolve_now(app_settings) -> datetime:
    tz_name = getattr(app_settings, "app_timezone", "") or "UTC"
    matched = UTC_OFFSET_PATTERN.match(tz_name.strip())
    if matched:
        sign = 1 if matched.group(1) == "+" else -1
        hours = int(matched.group(2))
        minutes = int(matched.group(3) or "0")
        if hours <= 23 and minutes <= 59:
            return datetime.now(timezone(sign * timedelta(hours=hours, minutes=minutes)))
    try:
        return datetime.now(ZoneInfo(tz_name))
    except Exception:
        if tz_name in {"Asia/Shanghai", "Asia/Chongqing", "PRC"}:
            logger.warning("timezone db missing for %s, fallback to UTC+8", tz_name)
            return datetime.now(timezone(timedelta(hours=8)))
        logger.warning("timezone resolve failed for %s, fallback to UTC", tz_name)
        return datetime.now(timezone.utc)


async def assemble_context(
    user_id: str,
    persona_id: str | None,
    project_id: str | None,
    session_id: str | None,
    messages: list[dict],
    settings: dict,
    latest_user_message: str,
    request_id: str,
) -> list[dict]:
    app_settings = settings["app_settings"]
    now = _resolve_now(app_settings)
    budgets = context_token_budget(int(app_settings.context_max_tokens))

    base_system_prompt = str(settings.get("system_prompt", "") or "")
    project_template = ""
    user_global_rows: list[LayeredMemory] = []
    character_rows: list[LayeredMemory] = []
    project_rows: list[LayeredMemory] = []
    cross_rows: list[LayeredMemory] = []

    async with SessionLocal() as db:
        if project_id:
            result = await db.execute(
                select(Project, ProjectType)
                .outerjoin(ProjectType, Project.project_type_id == ProjectType.id)
                .where(Project.user_id == user_id, Project.id == project_id)
            )
            project_pair = result.first()
            if project_pair:
                _, project_type = project_pair
                if project_type and project_type.system_prompt_template:
                    project_template = project_type.system_prompt_template.strip()

        q_base = (
            select(LayeredMemory)
            .where(
                LayeredMemory.user_id == user_id,
                LayeredMemory.is_active.is_(True),
            )
            .order_by(LayeredMemory.importance.desc(), LayeredMemory.updated_at.desc())
        )

        user_global_rows = list(
            (
                await db.execute(
                    q_base.where(
                        LayeredMemory.scope == "user_global",
                    )
                )
            ).scalars().all()
        )
        if persona_id:
            character_rows = list(
                (
                    await db.execute(
                        q_base.where(
                            LayeredMemory.scope == "character",
                            LayeredMemory.character_id == persona_id,
                        )
                    )
                ).scalars().all()
            )
        if project_id:
            project_rows = list(
                (
                    await db.execute(
                        q_base.where(
                            LayeredMemory.scope == "project",
                            LayeredMemory.project_id == project_id,
                        )
                    )
                ).scalars().all()
            )

        cross_filter = q_base.where(LayeredMemory.scope == "cross_session")
        if persona_id:
            cross_filter = cross_filter.where(
                (LayeredMemory.character_id.is_(None)) | (LayeredMemory.character_id == persona_id)
            )
        if project_id:
            cross_filter = cross_filter.where(
                (LayeredMemory.project_id.is_(None)) | (LayeredMemory.project_id == project_id)
            )
        cross_rows = list((await db.execute(cross_filter)).scalars().all())

    # Fallback to old persona memories when layered character memories are still empty.
    if not character_rows:
        legacy_memories = await get_active_memories(user_id, persona_id, app_settings)
        legacy_text = format_long_term_memories(legacy_memories, current_time=now)
    else:
        legacy_text = ""

    layer_3_summary = None
    if session_id:
        existing_summary = await get_latest_summary(session_id=session_id, user_id=user_id)
        if existing_summary:
            layer_3_summary = existing_summary.summary_text

    recent_messages = last_n_round_messages(messages, app_settings.context_recent_rounds)

    layer_5_recall = None
    if app_settings.embedding_enabled and latest_user_message.strip():
        chunks = await search_relevant_chunks(
            query=latest_user_message,
            user_id=user_id,
            persona_id=persona_id,
            top_k=app_settings.embedding_top_k,
            min_similarity=app_settings.embedding_min_similarity,
        )
        if chunks:
            layer_5_recall = format_recall(chunks, current_time=now)

    layer_user_global = _take_rows_by_tokens(
        user_global_rows,
        budgets["user_global"],
        title="用户全局档案",
        now=now,
        max_items=24,
    )
    layer_character = _take_rows_by_tokens(
        character_rows,
        budgets["character"],
        title="角色档案",
        now=now,
        max_items=28,
    )
    layer_project = _take_rows_by_tokens(
        project_rows,
        budgets["project"],
        title="项目上下文",
        now=now,
        max_items=24,
    )
    layer_cross = _take_rows_by_tokens(
        cross_rows,
        budgets["cross_session"],
        title="跨会话沉淀",
        now=now,
        max_items=32,
    )

    system_blocks: list[str] = []
    if base_system_prompt:
        system_blocks.append(base_system_prompt)
    if project_template:
        system_blocks.append("[项目类型提示词模板]\n" + project_template)
    if layer_user_global:
        system_blocks.append(layer_user_global)
    if layer_character:
        system_blocks.append(layer_character)
    elif legacy_text:
        system_blocks.append(legacy_text)
    if layer_project:
        system_blocks.append(layer_project)
    if layer_cross:
        system_blocks.append(layer_cross)
    layer_1_system = "\n\n".join(block for block in system_blocks if block).strip()
    layer_1_system = _fit_text_to_tokens(layer_1_system, budgets["system"] + budgets["user_global"] + budgets["character"] + budgets["project"] + budgets["cross_session"]) or ""

    budget = app_settings.context_max_tokens
    assembled: list[dict] = []
    if layer_1_system:
        assembled.append({"role": "system", "content": layer_1_system})
    remaining = budget - estimate_tokens(layer_1_system)

    # Priority 2: recent messages
    trimmed_recent = list(recent_messages)
    while trimmed_recent and estimate_tokens("\n".join(m.get("content", "") for m in trimmed_recent)) > max(0, remaining):
        if len(trimmed_recent) <= 2:
            break
        trimmed_recent.pop(0)
    remaining -= estimate_tokens("\n".join(m.get("content", "") for m in trimmed_recent))

    # Priority 3: summary
    if layer_3_summary:
        summary_text = _fit_text_to_tokens(
            f"[本次对话早期内容摘要]\n{layer_3_summary}",
            min(max(0, remaining), budgets["summary"]),
        )
        if summary_text:
            assembled.append({"role": "system", "content": summary_text})
            remaining -= estimate_tokens(summary_text)

    assembled.extend(trimmed_recent)

    # Priority 4: embedding recall
    if layer_5_recall:
        recall_prefill = (
            "[内部回忆，不要直接向用户展示这段文字]\n"
            "我回忆到以下可能相关的信息：\n"
            f"{layer_5_recall}\n"
            "以上信息仅供参考，不一定与当前话题相关，酌情使用。\n"
            "[回忆结束]\n\n"
        )
        recall_text = _fit_text_to_tokens(recall_prefill, min(max(0, remaining), budgets["recall"]))
        if recall_text:
            assembled.append({"role": "assistant", "content": recall_text})

    return assembled
