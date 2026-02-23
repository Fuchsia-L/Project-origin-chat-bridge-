from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from app.core.config import settings
from app.core.errors import AppError
from app.llm.client import llm_client
from app.schemas.chat import ChatMessage, Usage
from app.services.context_assembler import assemble_context, context_token_budget
from app.services.embedding_service import chunk_and_store_session
from app.services.layered_memory_service import extract_from_summary_and_persist
from app.services.memory_extract_service import maybe_extract_memories, _is_high_signal
from app.db import SessionLocal
from sqlalchemy import or_, select
from app.models import LayeredMemory, MemorySummary, PersonaMemory, Project, ProjectType
from app.models import ChatSession
from app.services.summary_service import maybe_compress_session
from app.services.token_counter import estimate_tokens
from app.services.turn_utils import count_user_rounds, last_n_round_messages, user_turn_spans

logger = logging.getLogger(__name__)


async def _resolve_session_bindings(
    *,
    user_id: str | None,
    session_id: str | None,
    persona_id: str | None,
    project_id: str | None,
) -> tuple[str | None, str | None]:
    if not user_id or not session_id:
        return persona_id, project_id
    if persona_id is not None and project_id is not None:
        return persona_id, project_id
    try:
        async with SessionLocal() as db:
            row = (
                await db.execute(
                    select(ChatSession).where(ChatSession.user_id == user_id, ChatSession.id == session_id)
                )
            ).scalar_one_or_none()
        if not row:
            return persona_id, project_id
        return persona_id if persona_id is not None else row.persona_id, project_id if project_id is not None else row.project_id
    except Exception:
        logger.exception("resolve session bindings failed session_id=%s", session_id)
        return persona_id, project_id


def _extract_usage(data: dict[str, Any]) -> Usage | None:
    u = data.get("usage")
    if not isinstance(u, dict):
        return None

    # 兼容不同网关字段：prompt_tokens / completion_tokens / total_tokens
    prompt = int(u.get("prompt_tokens") or u.get("input_tokens") or 0)
    completion = int(u.get("completion_tokens") or u.get("output_tokens") or 0)
    total = int(u.get("total_tokens") or (prompt + completion) or 0)
    return Usage(input_tokens=prompt, output_tokens=completion, total_tokens=total)


async def _build_memory_status(
    *,
    user_id: str | None,
    session_id: str | None,
    persona_id: str | None,
    project_id: str | None,
    messages: list[dict[str, str]],
) -> dict[str, Any]:
    rounds = count_user_rounds(messages)
    status: dict[str, Any] = {
        "rounds": rounds,
        "summary": {"enabled": False, "reason": "not_logged_in"},
        "memory_extract": {"enabled": False, "reason": "not_logged_in"},
        "embedding": {"enabled": False, "reason": "not_logged_in"},
        "layered_context": {"enabled": False, "reason": "not_logged_in"},
    }

    if not user_id:
        return status
    if not session_id:
        status["summary"] = {"enabled": False, "reason": "missing_session_id"}
        status["memory_extract"] = {"enabled": False, "reason": "missing_session_id"}
        status["embedding"] = {"enabled": False, "reason": "missing_session_id"}
        status["layered_context"] = {"enabled": False, "reason": "missing_session_id"}
        return status

    try:
        async with SessionLocal() as db:
            resolved_persona_id = persona_id
            resolved_project_id = project_id
            session_result = await db.execute(
                select(ChatSession).where(ChatSession.user_id == user_id, ChatSession.id == session_id)
            )
            session_row = session_result.scalar_one_or_none()
            if session_row:
                if resolved_persona_id is None:
                    resolved_persona_id = session_row.persona_id
                if resolved_project_id is None:
                    resolved_project_id = session_row.project_id

            latest_summary_result = await db.execute(
                select(MemorySummary)
                .where(
                    MemorySummary.user_id == user_id,
                    MemorySummary.session_id == session_id,
                )
                .order_by(MemorySummary.created_at.desc())
                .limit(1)
            )
            latest_summary = latest_summary_result.scalar_one_or_none()

            tail_round_index = max(1, int(settings.context_summary_tail_round_index))
            min_summary_tokens = max(1, int(settings.context_summary_min_tokens))
            spans = user_turn_spans(messages)
            end_idx_by_round = spans[-tail_round_index][1] if len(spans) >= tail_round_index else -1
            start_idx = latest_summary.message_range_end if latest_summary else 0
            end_idx = end_idx_by_round
            compressible = messages[start_idx : end_idx + 1] if end_idx >= start_idx else []
            compressible_rounds = count_user_rounds(compressible)
            compressible_tokens = estimate_tokens(
                "\n".join(
                    f"{m.get('role', 'unknown')}: {m.get('content', '')}" for m in compressible
                )
            )

            if rounds < settings.context_summary_trigger:
                status["summary"] = {"enabled": False, "reason": "below_trigger"}
            elif len(spans) < tail_round_index:
                status["summary"] = {"enabled": False, "reason": "not_enough_rounds_to_cut_tail"}
            elif end_idx < start_idx:
                status["summary"] = {"enabled": False, "reason": "no_new_range"}
            elif compressible_rounds <= 3:
                status["summary"] = {"enabled": False, "reason": "range_rounds_lte_3"}
            elif compressible_tokens <= min_summary_tokens:
                status["summary"] = {"enabled": False, "reason": "range_tokens_lte_threshold"}
            else:
                status["summary"] = {"enabled": True, "reason": "ready"}

            if not settings.memory_extract_enabled:
                status["memory_extract"] = {"enabled": False, "reason": "disabled"}
            elif not resolved_persona_id:
                status["memory_extract"] = {"enabled": False, "reason": "missing_persona_id"}
            else:
                existing_mem = await db.execute(
                    select(PersonaMemory.id)
                    .where(
                        PersonaMemory.user_id == user_id,
                        PersonaMemory.persona_id == resolved_persona_id,
                        PersonaMemory.source_session_id == session_id,
                    )
                    .limit(1)
                )
                has_any = existing_mem.first() is not None
                interval = max(1, settings.memory_extract_interval)
                if rounds % interval == 0:
                    probe_messages = last_n_round_messages(messages, interval)
                    if _is_high_signal(probe_messages):
                        status["memory_extract"] = {"enabled": True, "reason": "interval_boundary"}
                    else:
                        status["memory_extract"] = {"enabled": False, "reason": "low_signal_filtered"}
                elif (not has_any) and rounds >= interval:
                    probe_messages = last_n_round_messages(messages, interval)
                    if _is_high_signal(probe_messages):
                        status["memory_extract"] = {"enabled": True, "reason": "first_extract_compensate"}
                    else:
                        status["memory_extract"] = {"enabled": False, "reason": "low_signal_filtered"}
                else:
                    status["memory_extract"] = {"enabled": False, "reason": "not_interval_boundary"}

            budgets = context_token_budget(int(settings.context_max_tokens))

            async def _scope_rows(scope: str, limit: int = 40) -> list[LayeredMemory]:
                stmt = (
                    select(LayeredMemory)
                    .where(
                        LayeredMemory.user_id == user_id,
                        LayeredMemory.scope == scope,
                        LayeredMemory.is_active.is_(True),
                    )
                    .order_by(LayeredMemory.importance.desc(), LayeredMemory.updated_at.desc())
                    .limit(limit)
                )
                if scope == "character":
                    if not resolved_persona_id:
                        return []
                    stmt = stmt.where(LayeredMemory.character_id == resolved_persona_id)
                elif scope == "project":
                    if not resolved_project_id:
                        return []
                    stmt = stmt.where(LayeredMemory.project_id == resolved_project_id)
                elif scope == "cross_session":
                    if resolved_persona_id:
                        stmt = stmt.where(
                            or_(
                                LayeredMemory.character_id.is_(None),
                                LayeredMemory.character_id == resolved_persona_id,
                            )
                        )
                    if resolved_project_id:
                        stmt = stmt.where(
                            or_(
                                LayeredMemory.project_id.is_(None),
                                LayeredMemory.project_id == resolved_project_id,
                            )
                        )
                rows_result = await db.execute(stmt)
                return list(rows_result.scalars().all())

            user_global_rows = await _scope_rows("user_global")
            character_rows = await _scope_rows("character")
            project_rows = await _scope_rows("project")
            cross_rows = await _scope_rows("cross_session")

            project_template_enabled = False
            project_template_reason = "no_project_bound"
            if resolved_project_id:
                project_pair = await db.execute(
                    select(Project, ProjectType)
                    .outerjoin(ProjectType, Project.project_type_id == ProjectType.id)
                    .where(Project.user_id == user_id, Project.id == resolved_project_id)
                )
                pair = project_pair.first()
                if pair:
                    _, project_type = pair
                    if project_type and (project_type.system_prompt_template or "").strip():
                        project_template_enabled = True
                        project_template_reason = "loaded"
                    else:
                        project_template_reason = "empty_template"
                else:
                    project_template_reason = "project_not_found"

            def _rows_tokens(rows: list[LayeredMemory]) -> int:
                return estimate_tokens("\n".join(r.content for r in rows))

            status["layered_context"] = {
                "enabled": True,
                "session_bound": bool(session_row),
                "resolved": {
                    "persona_id": resolved_persona_id,
                    "project_id": resolved_project_id,
                },
                "project_template": {
                    "enabled": project_template_enabled,
                    "reason": project_template_reason,
                },
                "fallback_legacy_persona_memory": bool(resolved_persona_id and len(character_rows) == 0),
                "layers": {
                    "user_global": {
                        "count": len(user_global_rows),
                        "tokens_estimate": _rows_tokens(user_global_rows),
                        "budget": budgets["user_global"],
                    },
                    "character": {
                        "count": len(character_rows),
                        "tokens_estimate": _rows_tokens(character_rows),
                        "budget": budgets["character"],
                    },
                    "project": {
                        "count": len(project_rows),
                        "tokens_estimate": _rows_tokens(project_rows),
                        "budget": budgets["project"],
                    },
                    "cross_session": {
                        "count": len(cross_rows),
                        "tokens_estimate": _rows_tokens(cross_rows),
                        "budget": budgets["cross_session"],
                    },
                },
            }
    except Exception:
        logger.exception("build_memory_status failed")
        status["summary"] = {"enabled": False, "reason": "status_error"}
        status["memory_extract"] = {"enabled": False, "reason": "status_error"}
        status["layered_context"] = {"enabled": False, "reason": "status_error"}

    if not settings.embedding_enabled:
        status["embedding"] = {"enabled": False, "reason": "disabled"}
    else:
        status["embedding"] = {"enabled": True, "reason": "ready"}
    return status


async def run_chat(
    *,
    system_prompt: str,
    messages: list[ChatMessage],
    model: Optional[str],
    temperature: Optional[float],
    top_p: Optional[float] = None,
    frequency_penalty: Optional[float] = None,
    presence_penalty: Optional[float] = None,
    request_id: str,
    user_id: str | None = None,
    persona_id: str | None = None,
    project_id: str | None = None,
    session_id: str | None = None,
) -> tuple[ChatMessage, Usage | None, dict[str, Any]]:
    use_model = model or settings.llm_model
    use_temp = temperature if temperature is not None else settings.llm_temperature
    raw_messages = [{"role": m.role, "content": m.content} for m in messages]
    persona_id, project_id = await _resolve_session_bindings(
        user_id=user_id,
        session_id=session_id,
        persona_id=persona_id,
        project_id=project_id,
    )

    if user_id:
        latest_user = ""
        for m in reversed(raw_messages):
            if m["role"] == "user":
                latest_user = m["content"]
                break
        req_messages = await assemble_context(
            user_id=user_id,
            persona_id=persona_id,
            project_id=project_id,
            session_id=session_id,
            messages=raw_messages,
            settings={"system_prompt": system_prompt, "app_settings": settings},
            latest_user_message=latest_user,
            request_id=request_id,
        )
    else:
        req_messages: list[dict[str, str]] = []
        if system_prompt.strip():
            req_messages.append({"role": "system", "content": system_prompt})
        req_messages.extend(raw_messages)

    data = await llm_client.chat_completions(
        model=use_model,
        messages=req_messages,
        temperature=use_temp,
        top_p=top_p,
        frequency_penalty=frequency_penalty,
        presence_penalty=presence_penalty,
        request_id=request_id,
    )
    if settings.app_debug_raw:
        data["_assembled_messages"] = req_messages
        data["_memory_status"] = await _build_memory_status(
            user_id=user_id,
            session_id=session_id,
            persona_id=persona_id,
            project_id=project_id,
            messages=raw_messages,
        )

    try:
        content = data["choices"][0]["message"]["content"]
    except Exception:
        raise AppError("LLM response missing choices[0].message.content", status_code=502, code="llm_parse_error")

    reply = ChatMessage(role="assistant", content=content)
    usage = _extract_usage(data)

    if user_id:
        asyncio.create_task(
            post_reply_memory_tasks(
                user_id=user_id,
                persona_id=persona_id,
                project_id=project_id,
                session_id=session_id,
                messages=raw_messages + [{"role": "assistant", "content": content}],
                model=use_model,
                request_id=request_id,
            )
        )

    return reply, usage, data


async def run_chat_stream(
    *,
    system_prompt: str,
    messages: list[ChatMessage],
    model: Optional[str],
    temperature: Optional[float],
    top_p: Optional[float] = None,
    frequency_penalty: Optional[float] = None,
    presence_penalty: Optional[float] = None,
    request_id: str,
    user_id: str | None = None,
    persona_id: str | None = None,
    project_id: str | None = None,
    session_id: str | None = None,
):
    use_model = model or settings.llm_model
    use_temp = temperature if temperature is not None else settings.llm_temperature
    raw_messages = [{"role": m.role, "content": m.content} for m in messages]
    persona_id, project_id = await _resolve_session_bindings(
        user_id=user_id,
        session_id=session_id,
        persona_id=persona_id,
        project_id=project_id,
    )

    if user_id:
        latest_user = ""
        for m in reversed(raw_messages):
            if m["role"] == "user":
                latest_user = m["content"]
                break
        req_messages = await assemble_context(
            user_id=user_id,
            persona_id=persona_id,
            project_id=project_id,
            session_id=session_id,
            messages=raw_messages,
            settings={"system_prompt": system_prompt, "app_settings": settings},
            latest_user_message=latest_user,
            request_id=request_id,
        )
    else:
        req_messages: list[dict[str, str]] = []
        if system_prompt.strip():
            req_messages.append({"role": "system", "content": system_prompt})
        req_messages.extend(raw_messages)

    acc_content = ""
    if settings.app_debug_raw:
        yield {"type": "assembled", "messages": req_messages}
        yield {
            "type": "memory_status",
            "status": await _build_memory_status(
                user_id=user_id,
                session_id=session_id,
                persona_id=persona_id,
                project_id=project_id,
                messages=raw_messages,
            ),
        }

    async for line in llm_client.chat_completions_stream(
        model=use_model,
        messages=req_messages,
        temperature=use_temp,
        top_p=top_p,
        frequency_penalty=frequency_penalty,
        presence_penalty=presence_penalty,
        request_id=request_id,
    ):
        if not line:
            continue
        if not line.startswith("data:"):
            continue
        data = line[len("data:") :].strip()
        if data == "[DONE]":
            yield {"type": "done"}
            break
        try:
            payload = json.loads(data)
        except Exception:
            continue

        model = payload.get("model")
        if isinstance(model, str) and model:
            yield {"type": "model", "model": model}

        if settings.app_debug_raw:
            yield {"type": "raw", "raw": payload}

        usage = payload.get("usage")
        if isinstance(usage, dict):
            yield {"type": "usage", "usage": usage}

        try:
            delta = payload["choices"][0]["delta"]
        except Exception:
            delta = {}

        content = delta.get("content")
        if isinstance(content, str) and content:
            acc_content += content
            yield {"type": "delta", "content": content}

        reasoning = delta.get("reasoning_content") or delta.get("thinking")
        if isinstance(reasoning, str) and reasoning:
            yield {"type": "thinking", "content": reasoning}

    if user_id:
        asyncio.create_task(
            post_reply_memory_tasks(
                user_id=user_id,
                persona_id=persona_id,
                project_id=project_id,
                session_id=session_id,
                messages=raw_messages + [{"role": "assistant", "content": acc_content}],
                model=use_model,
                request_id=request_id,
            )
        )


async def post_reply_memory_tasks(
    *,
    user_id: str,
    persona_id: str | None,
    project_id: str | None,
    session_id: str | None,
    messages: list[dict[str, str]],
    model: str,
    request_id: str,
) -> None:
    if not session_id:
        return
    resolved_project_id = project_id
    if resolved_project_id is None:
        try:
            async with SessionLocal() as db:
                session_result = await db.execute(
                    select(ChatSession).where(ChatSession.user_id == user_id, ChatSession.id == session_id)
                )
                session_row = session_result.scalar_one_or_none()
                resolved_project_id = session_row.project_id if session_row else None
        except Exception:
            logger.exception("post_reply_memory_tasks resolve project_id failed request_id=%s", request_id)

    summary_text: str | None = None
    try:
        summary_text, _ = await maybe_compress_session(
            session_id=session_id,
            user_id=user_id,
            messages=messages,
            settings=settings,
            request_id=request_id,
            persona_id=persona_id,
        )
    except Exception:
        logger.exception("post_reply_memory_tasks summary failed request_id=%s", request_id)

    if summary_text:
        try:
            await extract_from_summary_and_persist(
                user_id=user_id,
                character_id=persona_id,
                project_id=resolved_project_id,
                session_id=session_id,
                summary_text=summary_text,
                model=getattr(settings, "memory_extract_model", "") or model,
                request_id=request_id,
            )
        except Exception:
            logger.exception("post_reply_memory_tasks layered extract failed request_id=%s", request_id)

    try:
        await maybe_extract_memories(
            message_count=count_user_rounds(messages),
            messages=messages,
            user_id=user_id,
            persona_id=persona_id,
            session_id=session_id,
            model=model,
            request_id=request_id,
            settings=settings,
        )
    except Exception:
        logger.exception("post_reply_memory_tasks memory extract failed request_id=%s", request_id)

    if settings.embedding_enabled:
        try:
            await chunk_and_store_session(
                user_id=user_id,
                persona_id=persona_id,
                session_id=session_id,
                messages=messages,
                request_id=request_id,
                model=model,
            )
        except Exception:
            logger.exception("post_reply_memory_tasks embedding failed request_id=%s", request_id)
