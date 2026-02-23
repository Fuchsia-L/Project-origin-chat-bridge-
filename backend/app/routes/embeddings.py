from fastapi import APIRouter, HTTPException

from app.core.config import settings

router = APIRouter(prefix="/embeddings", tags=["embeddings"])


def _ensure_enabled() -> None:
    if not (settings.embedding_enabled or settings.embeddings_enabled):
        raise HTTPException(status_code=501, detail="Embeddings are disabled")


@router.get("/status")
async def embeddings_status():
    _ensure_enabled()
    return {"enabled": True}
