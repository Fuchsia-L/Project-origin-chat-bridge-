from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


Role = Literal["system", "user", "assistant"]


class ChatMessage(BaseModel):
    role: Role
    content: str


class ChatRequest(BaseModel):
    system_prompt: str = Field(default="")
    model: Optional[str] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    frequency_penalty: Optional[float] = None
    presence_penalty: Optional[float] = None
    session_id: Optional[str] = None
    persona_id: Optional[str] = None
    project_id: Optional[str] = None
    messages: list[ChatMessage] = Field(default_factory=list)


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


class ChatResponse(BaseModel):
    reply: ChatMessage
    request_id: str
    usage: Optional[Usage] = None
    raw: Optional[dict[str, Any]] = None  # 方便你调试（MVP 可留可删）
