from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
import json
from app.core.config import settings
from app.core.auth import get_optional_current_user

from app.models import User
from app.schemas.chat import ChatRequest, ChatResponse
from app.services.chat_service import run_chat, run_chat_stream

router = APIRouter()


@router.post("/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    request: Request,
    user: User | None = Depends(get_optional_current_user),
):
    request_id: str = request.state.request_id

    reply, usage, raw = await run_chat(
        system_prompt=req.system_prompt,
        messages=req.messages,
        model=req.model,
        temperature=req.temperature,
        top_p=req.top_p,
        frequency_penalty=req.frequency_penalty,
        presence_penalty=req.presence_penalty,
        request_id=request_id,
        user_id=user.id if user else None,
        persona_id=req.persona_id,
        project_id=req.project_id,
        session_id=req.session_id,
    )

    return ChatResponse(
        reply=reply,
        request_id=request_id,
        usage=usage,
        raw=raw if settings.app_debug_raw else None,
    )


@router.post("/chat/stream")
async def chat_stream(
    req: ChatRequest,
    request: Request,
    user: User | None = Depends(get_optional_current_user),
):
    request_id: str = request.state.request_id

    async def event_generator():
        yield f"data: {json.dumps({'type': 'meta', 'request_id': request_id}, ensure_ascii=False)}\n\n"
        try:
            async for event in run_chat_stream(
                system_prompt=req.system_prompt,
                messages=req.messages,
                model=req.model,
                temperature=req.temperature,
                top_p=req.top_p,
                frequency_penalty=req.frequency_penalty,
                presence_penalty=req.presence_penalty,
                request_id=request_id,
                user_id=user.id if user else None,
                persona_id=req.persona_id,
                project_id=req.project_id,
                session_id=req.session_id,
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:
            err = {"type": "error", "message": str(e)}
            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
