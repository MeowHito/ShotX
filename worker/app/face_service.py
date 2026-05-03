import numpy as np


class FaceService:
    def __init__(self, model_name: str) -> None:
        self.model_name = model_name
        self.app = None

    def load(self) -> None:
        try:
            from insightface.app import FaceAnalysis

            app = FaceAnalysis(name=self.model_name)
            app.prepare(ctx_id=0, det_size=(640, 640))
            self.app = app
        except Exception:
            self.app = None

    def embed_image_bytes(self, image_bytes: bytes) -> list[list[float]]:
        if self.app is None:
            return []

        import cv2

        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if image is None:
            return []

        faces = self.app.get(image)
        return [face.embedding.astype(float).tolist() for face in faces]
