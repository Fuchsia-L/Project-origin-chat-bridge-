from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://postgres:postgres@127.0.0.1:5432/project_origin"

    # Auth
    jwt_secret: str = "change_me"
    jwt_access_ttl: int = 900
    jwt_refresh_ttl: int = 60 * 60 * 24 * 7
    sync_max_sessions: int | None = None
    sync_max_bytes: int | None = None

    # LLM
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o-mini"
    llm_temperature: float = 0.7
    llm_timeout_s: float = 60.0
    llm_safety_block: str = "BLOCK_NONE"

    # Server
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    app_debug_raw: bool = False

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


settings = Settings()
