from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    worker_host: str = "0.0.0.0"
    worker_port: int = 8000
    insightface_model: str = "buffalo_l"
    redis_url: str = "redis://localhost:6379"
    database_url: str = ""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
