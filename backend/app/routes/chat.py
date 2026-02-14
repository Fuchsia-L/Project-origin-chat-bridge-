from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
import json
from app.core.config import settings

from app.schemas.chat import ChatRequest, ChatResponse
from app.services.chat_service import run_chat, run_chat_stream

router = APIRouter()


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, request: Request):
    request_id: str = request.state.request_id

    reply, usage, raw = await run_chat(
        system_prompt=req.system_prompt,
        messages=req.messages,
        model=req.model,
        temperature=req.temperature,
        request_id=request_id,
    )

    return ChatResponse(
        reply=reply,
        request_id=request_id,
        usage=usage,
        raw=raw if settings.app_debug_raw else None,
    )


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request):
    request_id: str = request.state.request_id

    async def event_generator():
        yield f"data: {json.dumps({'type': 'meta', 'request_id': request_id}, ensure_ascii=False)}\n\n"
        async for event in run_chat_stream(
            system_prompt=req.system_prompt,
            messages=req.messages,
            model=req.model,
            temperature=req.temperature,
            request_id=request_id,
        ):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
