from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import HTTPException

from app.core.logging import request_id_middleware
from app.core.config import settings
from app.core.errors import AppError, app_error_handler, http_exception_handler
from app.db import init_db
from app.routes.auth import router as auth_router
from app.routes.chat import router as chat_router
from app.routes.embeddings import router as embeddings_router
from app.routes.layered_memory import router as layered_memory_router
from app.routes.memory import router as memory_router
from app.routes.personas import router as personas_router
from app.routes.projects import router as projects_router
from app.routes.sessions import router as sessions_router


app = FastAPI(title="Project Origin API", version="0.1.0")


@app.on_event("startup")
async def startup() -> None:
    if settings.db_auto_create:
        await init_db()

# middleware: request_id
app.middleware("http")(request_id_middleware)

# CORS（MVP：先放开，后面再收紧）
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# error handlers
app.add_exception_handler(AppError, app_error_handler)
app.add_exception_handler(HTTPException, http_exception_handler)

# routes
app.include_router(chat_router, prefix="/api")
app.include_router(auth_router, prefix="/api")
app.include_router(sessions_router, prefix="/api")
app.include_router(embeddings_router, prefix="/api")
app.include_router(memory_router, prefix="/api")
app.include_router(personas_router, prefix="/api")
app.include_router(projects_router, prefix="/api")
app.include_router(layered_memory_router, prefix="/api")
