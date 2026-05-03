# Python AI worker — CPU mode (small Droplet friendly)
# For GPU production, change base to nvidia/cuda:12.x-runtime + onnxruntime-gpu
FROM python:3.11-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY worker/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir insightface==0.7.3 onnxruntime==1.19.2

COPY worker/app ./app

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
