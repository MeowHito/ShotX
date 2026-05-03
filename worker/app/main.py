from fastapi import FastAPI, File, UploadFile

from app.config import settings
from app.face_service import FaceService
from app.schemas import FaceEmbeddingResponse, HealthResponse, ProcessPhotoRequest, ProcessPhotoResponse

app = FastAPI(title="EventDD AI Worker", version="0.1.0")
face_service = FaceService(settings.insightface_model)


@app.on_event("startup")
def startup() -> None:
    face_service.load()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="eventdd-ai-worker", model=settings.insightface_model)


@app.post("/embed", response_model=FaceEmbeddingResponse)
async def embed(selfie: UploadFile = File(...)) -> FaceEmbeddingResponse:
    image_bytes = await selfie.read()
    embeddings = face_service.embed_image_bytes(image_bytes)
    return FaceEmbeddingResponse(face_count=len(embeddings), embeddings=embeddings)


@app.post("/process-photo", response_model=ProcessPhotoResponse)
def process_photo(payload: ProcessPhotoRequest) -> ProcessPhotoResponse:
    return ProcessPhotoResponse(photo_id=payload.photo_id, face_count=0, status="placeholder")
