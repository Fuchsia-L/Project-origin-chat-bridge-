from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Environment
    app_env: str = "development"

    # Database
    database_url: str = "postgresql://postgres:postgres@127.0.0.1:5432/project_origin"
    db_auto_create: bool = True

    # Auth
    jwt_secret: str = "change_me"
    jwt_access_ttl: int = 900
    jwt_refresh_ttl: int = 60 * 60 * 24 * 7
    password_min_length: int = 8

    # Sync limits
    sync_max_sessions: int | None = None
    sync_max_bytes: int | None = None
    session_tombstone_ttl_days: int = 30

    # Embeddings
    embeddings_enabled: bool = False
    embedding_enabled: bool = False
    embedding_model: str = "text-embedding-3-small"
    embedding_dim: int = 1536
    embedding_api_url: str = ""
    embedding_api_key: str = ""
    embedding_chunk_size: int = 8
    embedding_chunk_overlap: int = 2
    embedding_top_k: int = 3
    embedding_min_similarity: float = 0.75

    # Context window
    context_max_tokens: int = 8000
    context_recent_rounds: int = 10
    context_summary_trigger: int = 10
    context_summary_batch_rounds: int = 5
    context_summary_min_tokens: int = 1800
    context_summary_tail_round_index: int = 7

    # Memory extraction
    memory_extract_enabled: bool = True
    memory_extract_interval: int = 10
    memory_max_per_persona: int = 50
    memory_extract_require_confirm: bool = True
    memory_extract_model: str = "gemini-3-flash-preview-thinking"
    memory_extract_fallback_model: str = "claude-sonnet-4-5-20250929"
    memory_extract_timeout_s: int = 20

    # LLM
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model: str = "gemini-3-flash-preview"
    summary_model: str = "gemini-3-flash-preview-thinking"
    llm_temperature: float = 0.7
    llm_timeout_s: float = 60.0
    llm_safety_block: str = "BLOCK_NONE"

    # Server
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    app_debug_raw: bool = False
    app_timezone: str = "UTC+8"
    cors_allow_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="",
        case_sensitive=False,
        extra="ignore",
    )

    @field_validator("sync_max_sessions", "sync_max_bytes", mode="before")
    @classmethod
    def _empty_to_none(cls, value):
        if value in ("", None):
            return None
        return value

    @field_validator("cors_allow_origins", mode="before")
    @classmethod
    def _parse_origins(cls, value):
        if value is None:
            return value
        if isinstance(value, str):
            items = [v.strip() for v in value.split(",") if v.strip()]
            return items
        return value

    @field_validator("password_min_length", mode="before")
    @classmethod
    def _min_length(cls, value):
        if value in ("", None):
            return 8
        return value

    @field_validator("session_tombstone_ttl_days", mode="before")
    @classmethod
    def _ttl_days(cls, value):
        if value in ("", None):
            return 30
        return value

    def model_post_init(self, __context):
        if self.embeddings_enabled and not self.embedding_enabled:
            self.embedding_enabled = True
        if self.app_env.lower() == "production":
            if not self.jwt_secret or self.jwt_secret == "change_me":
                raise ValueError("JWT_SECRET must be set in production")


settings = Settings()
