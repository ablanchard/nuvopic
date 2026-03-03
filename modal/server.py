"""
Standalone FastAPI inference server for NuvoPic.

Runs the same BLIP + InsightFace pipeline as the Modal endpoint, but as a
plain HTTP server — suitable for Vast.ai, RunPod, or any GPU instance.

Usage:
    INFERENCE_API_KEY=secret uvicorn server:app --host 0.0.0.0 --port 8000

Environment variables:
    INFERENCE_API_KEY  — Bearer token for authentication (required)
"""

import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from core import PhotoAnalyzer

analyzer: PhotoAnalyzer | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models on startup, release on shutdown."""
    global analyzer
    print("Loading models onto GPU...")
    analyzer = PhotoAnalyzer()
    analyzer.load_models()
    print("Server ready.")
    yield
    analyzer = None
    print("Server shut down.")


app = FastAPI(title="NuvoPic Inference", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Auth middleware
# ---------------------------------------------------------------------------
INFERENCE_API_KEY = os.environ.get("INFERENCE_API_KEY", "")

if not INFERENCE_API_KEY:
    print(
        "WARNING: INFERENCE_API_KEY is not set — server is unauthenticated!",
        file=sys.stderr,
    )


def _check_auth(request: Request):
    if not INFERENCE_API_KEY:
        return  # no auth configured
    auth = request.headers.get("Authorization", "")
    if auth != f"Bearer {INFERENCE_API_KEY}":
        raise HTTPException(status_code=401, detail="Unauthorized")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    """Health check — returns 200 when models are loaded and ready."""
    if analyzer is None:
        raise HTTPException(status_code=503, detail="Models not loaded yet")
    return {"status": "ok"}


@app.post("/analyze")
async def analyze(request: Request):
    """
    POST /analyze
    Body: { "image": "<base64-encoded image bytes>" }
    Headers: Authorization: Bearer <INFERENCE_API_KEY>

    Returns: {
        "caption": "a dog sitting on a couch",
        "faces": [
            {
                "bbox": { "x": 100, "y": 50, "width": 80, "height": 100 },
                "embedding": [0.123, -0.456, ...],  // 512 floats
                "confidence": 0.98
            }
        ]
    }
    """
    _check_auth(request)

    if analyzer is None:
        raise HTTPException(status_code=503, detail="Models not loaded yet")

    data = await request.json()

    try:
        result = analyzer.analyze(data)
        return result
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except RuntimeError as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
