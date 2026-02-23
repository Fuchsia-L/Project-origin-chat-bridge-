from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal
from app.llm.client import llm_client
from app.models import LayeredMemory, Project, ProjectType

ALLOWED_SCOPES = {"user_global", "character", "project", "cross_session"}

MEMORY_EXTRACTOR_PROMPT = """你是一个记忆提炼系统。你的任务是从一段对话摘要中提取值得长期记住的信息，并将每条信息分类到对应的记忆层级。

## 输入
你会收到：
1. 一段对话的压缩摘要
2. 当前用户的全局档案（用于避免重复提取已知信息）
3. 当前角色的档案（用于避免重复提取已知信息）
4. 当前项目的上下文（用于避免重复提取已知信息）

## 输出要求
以 JSON 数组格式输出，每条记忆包含以下字段：
[
  {
    "content": "提炼出的信息，用简洁的陈述句表达",
    "scope": "user_global | character | project | cross_session",
    "category": "具体分类标签，见下方分类体系",
    "importance": 1-5,
    "supersedes": "如果这条信息更新了某条已有记忆，填写被替代的记忆内容摘要，否则为 null"
  }
]

## 分类体系
scope: user_global
- identity
- preference
- knowledge_level
- life_event

scope: character
- relationship
- emotional_event
- shared_memory
- character_development

scope: project
- progress
- decision
- knowledge_point
- world_building
- task

scope: cross_session
- topic_context
- unresolved
- callback

## 提炼原则
1. 不要提取显而易见的信息。
2. 不要重复已有记忆。
3. 如果新信息与已有记忆矛盾，使用 supersedes 标记替代关系。
4. importance 为 1-5 的整数。
5. 宁缺毋滥。没有可提炼信息时返回 []。
6. 用简洁陈述句，不要元叙述。"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_text(value: dict | str | None) -> str:
    if value is None:
        return "{}"
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2)


def _extract_json_array(raw: str) -> list:
    text = (raw or "").strip()
    if not text:
        return []

    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, flags=re.IGNORECASE)
    if fenced:
        try:
            parsed = json.loads(fenced.group(1).strip())
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass

    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass

    first = text.find("[")
    last = text.rfind("]")
    if first != -1 and last != -1 and last > first:
        parsed = json.loads(text[first : last + 1])
        if isinstance(parsed, list):
            return parsed
    return []


def _normalize_text(value: str | None) -> str:
    return re.sub(r"\s+", "", (value or "").strip().lower())


def _validate_scope_fields(
    scope: str,
    character_id: str | None,
    project_id: str | None,
) -> tuple[str | None, str | None]:
    if scope == "user_global":
        return None, None
    if scope == "character":
        if not character_id:
            raise ValueError("character scope requires character_id")
        return character_id, None
    if scope == "project":
        if not project_id:
            raise ValueError("project scope requires project_id")
        return None, project_id
    if scope == "cross_session":
        return character_id, project_id
    raise ValueError(f"invalid scope: {scope}")


def _scope_stmt(
    *,
    user_id: str,
    scope: str,
    character_id: str | None,
    project_id: str | None,
) -> Select:
    stmt = select(LayeredMemory).where(
        LayeredMemory.user_id == user_id,
        LayeredMemory.scope == scope,
        LayeredMemory.is_active.is_(True),
    )
    if scope == "character":
        stmt = stmt.where(LayeredMemory.character_id == character_id)
    if scope == "project":
        stmt = stmt.where(LayeredMemory.project_id == project_id)
    return stmt


async def resolve_supersedes_memory_id(
    *,
    db: AsyncSession,
    user_id: str,
    scope: str,
    character_id: str | None,
    project_id: str | None,
    supersedes_hint: str | None,
) -> str | None:
    hint = (supersedes_hint or "").strip()
    if not hint:
        return None

    result = await db.execute(
        _scope_stmt(
            user_id=user_id,
            scope=scope,
            character_id=character_id,
            project_id=project_id,
        )
    )
    rows = list(result.scalars().all())
    norm_hint = _normalize_text(hint)
    for row in rows:
        if _normalize_text(row.content) == norm_hint:
            return row.id
    for row in rows:
        if norm_hint and norm_hint in _normalize_text(row.content):
            return row.id
    return None


async def extract_layered_memories(
    *,
    model: str,
    request_id: str,
    conversation_summary: str,
    user_global_profile: dict | str | None,
    character_profile: dict | str | None,
    project_context: dict | str | None,
    prompt_override: str | None = None,
) -> list[dict]:
    prompt_text = (prompt_override or "").strip() or MEMORY_EXTRACTOR_PROMPT
    payload = [
        {"role": "system", "content": prompt_text},
        {
            "role": "user",
            "content": (
                "当前用户全局档案：\n"
                + _to_text(user_global_profile)
                + "\n\n当前角色档案：\n"
                + _to_text(character_profile)
                + "\n\n当前项目上下文：\n"
                + _to_text(project_context)
                + "\n\n待处理的对话摘要：\n"
                + conversation_summary.strip()
            ),
        },
    ]
    data = await llm_client.chat_completions(
        model=model,
        messages=payload,
        temperature=0.1,
        request_id=request_id,
    )
    raw = str(data["choices"][0]["message"]["content"] or "")
    parsed = _extract_json_array(raw)

    cleaned: list[dict] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        scope = str(item.get("scope") or "").strip()
        category = str(item.get("category") or "").strip()
        content = str(item.get("content") or "").strip()
        supersedes = item.get("supersedes")
        try:
            importance = int(item.get("importance", 3))
        except Exception:
            importance = 3
        if scope not in ALLOWED_SCOPES or not category or not content:
            continue
        importance = max(1, min(5, importance))
        cleaned.append(
            {
                "scope": scope,
                "category": category,
                "content": content,
                "importance": importance,
                "supersedes": str(supersedes).strip() if supersedes is not None else None,
            }
        )
    return cleaned


def _allowed_categories(memory_strategy: dict | None, scope: str) -> set[str] | None:
    if not isinstance(memory_strategy, dict):
        return None
    filters = memory_strategy.get("layerFilters")
    if not isinstance(filters, dict):
        return None
    key_map = {
        "user_global": "userGlobal",
        "character": "character",
        "project": "project",
        "cross_session": "crossSession",
    }
    raw = filters.get(key_map.get(scope, scope))
    if not isinstance(raw, list):
        return None
    out = {str(x).strip() for x in raw if str(x).strip()}
    return out or None


async def extract_from_summary_and_persist(
    *,
    user_id: str,
    character_id: str | None,
    project_id: str | None,
    session_id: str | None,
    summary_text: str,
    model: str,
    request_id: str,
) -> list[dict]:
    async with SessionLocal() as db:
        user_global_rows = (
            await db.execute(
                select(LayeredMemory)
                .where(
                    LayeredMemory.user_id == user_id,
                    LayeredMemory.scope == "user_global",
                    LayeredMemory.is_active.is_(True),
                )
                .order_by(LayeredMemory.updated_at.desc())
                .limit(40)
            )
        ).scalars().all()
        character_rows = []
        if character_id:
            character_rows = (
                await db.execute(
                    select(LayeredMemory)
                    .where(
                        LayeredMemory.user_id == user_id,
                        LayeredMemory.scope == "character",
                        LayeredMemory.character_id == character_id,
                        LayeredMemory.is_active.is_(True),
                    )
                    .order_by(LayeredMemory.updated_at.desc())
                    .limit(40)
                )
            ).scalars().all()
        project_context_doc: dict | None = None
        project_type_prompt: str | None = None
        memory_strategy: dict | None = None
        if project_id:
            project_pair = await db.execute(
                select(Project, ProjectType)
                .outerjoin(ProjectType, Project.project_type_id == ProjectType.id)
                .where(Project.user_id == user_id, Project.id == project_id)
            )
            row = project_pair.first()
            if row:
                project_row, project_type = row
                project_context_doc = project_row.context_doc or {}
                if project_type:
                    project_type_prompt = project_type.system_prompt_template or None
                    memory_strategy = project_type.memory_strategy if isinstance(project_type.memory_strategy, dict) else None

        user_profile = [{"category": r.category, "content": r.content} for r in user_global_rows]
        character_profile = [{"category": r.category, "content": r.content} for r in character_rows]
        project_context = {
            "project_id": project_id,
            "context_doc": project_context_doc or {},
            "project_type_prompt": project_type_prompt or "",
        }
        prompt_override = None
        if isinstance(memory_strategy, dict):
            prompt_override = memory_strategy.get("extractionPrompt")
            if prompt_override is not None:
                prompt_override = str(prompt_override)

        extracted = await extract_layered_memories(
            model=model,
            request_id=request_id,
            conversation_summary=summary_text,
            user_global_profile=user_profile,
            character_profile=character_profile,
            project_context=project_context,
            prompt_override=prompt_override,
        )
        persisted: list[dict] = []
        for item in extracted:
            allowed = _allowed_categories(memory_strategy, item["scope"])
            if allowed is not None and item["category"] not in allowed:
                continue
            resolved_character_id = character_id if item["scope"] in {"character", "cross_session"} else None
            resolved_project_id = project_id if item["scope"] in {"project", "cross_session"} else None

            supersedes_id = await resolve_supersedes_memory_id(
                db=db,
                user_id=user_id,
                scope=item["scope"],
                character_id=resolved_character_id,
                project_id=resolved_project_id,
                supersedes_hint=item.get("supersedes"),
            )
            dup_stmt = select(LayeredMemory.id).where(
                LayeredMemory.user_id == user_id,
                LayeredMemory.scope == item["scope"],
                LayeredMemory.category == item["category"],
                LayeredMemory.content == item["content"],
                LayeredMemory.is_active.is_(True),
            )
            if resolved_character_id:
                dup_stmt = dup_stmt.where(LayeredMemory.character_id == resolved_character_id)
            if resolved_project_id:
                dup_stmt = dup_stmt.where(LayeredMemory.project_id == resolved_project_id)
            dup = (await db.execute(dup_stmt.limit(1))).first()
            if dup:
                continue
            row = await create_layered_memory_row(
                db=db,
                user_id=user_id,
                scope=item["scope"],
                category=item["category"],
                content=item["content"],
                importance=item["importance"],
                character_id=resolved_character_id,
                project_id=resolved_project_id,
                source_session_id=session_id,
                supersedes_memory_id=supersedes_id,
                is_active=True,
            )
            persisted.append(
                {
                    "id": row.id,
                    "scope": item["scope"],
                    "category": item["category"],
                    "content": item["content"],
                }
            )
        if persisted:
            await db.commit()
        return persisted


async def create_layered_memory_row(
    *,
    db: AsyncSession,
    user_id: str,
    scope: str,
    category: str,
    content: str,
    importance: int,
    character_id: str | None,
    project_id: str | None,
    source_session_id: str | None,
    supersedes_memory_id: str | None,
    is_active: bool,
) -> LayeredMemory:
    resolved_character_id, resolved_project_id = _validate_scope_fields(scope, character_id, project_id)
    now = _now()

    row = LayeredMemory(
        id=str(uuid.uuid4()),
        user_id=user_id,
        scope=scope,
        category=category,
        content=content.strip(),
        importance=max(1, min(5, int(importance))),
        character_id=resolved_character_id,
        project_id=resolved_project_id,
        source_session_id=source_session_id,
        supersedes_memory_id=supersedes_memory_id,
        is_active=is_active,
        created_at=now,
        updated_at=now,
    )
    db.add(row)

    if supersedes_memory_id:
        old = await db.get(LayeredMemory, supersedes_memory_id)
        if old and old.user_id == user_id:
            old.is_active = False
            old.updated_at = now

    return row
