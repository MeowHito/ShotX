from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    service: str
    model: str


class FaceEmbeddingResponse(BaseModel):
    face_count: int
    embeddings: list[list[float]]


class ProcessPhotoRequest(BaseModel):
    photo_id: str
    event_id: str
    storage_key: str


class ProcessPhotoResponse(BaseModel):
    photo_id: str
    face_count: int
    status: str
