"""
Shared inference core for NuvoPic GPU processing.

Pure Python — no Modal or FastAPI dependencies.
Used by both modal/inference.py (Modal deployment) and modal/server.py (standalone).

Provides separate CaptionAnalyzer and FaceAnalyzer so each can be updated
and reprocessed independently. PhotoAnalyzer combines both for backward
compatibility with the /analyze endpoint.
"""

import base64
import io
import traceback
from typing import Any


def download_models():
    """Download models so cold starts don't fetch from HuggingFace."""
    from transformers import BlipProcessor, BlipForConditionalGeneration
    from insightface.app import FaceAnalysis
    import numpy as np

    # BLIP captioning model
    BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-base")
    BlipForConditionalGeneration.from_pretrained(
        "Salesforce/blip-image-captioning-base"
    )

    # InsightFace buffalo_l model (downloads to ~/.insightface/models/)
    fa = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    fa.prepare(ctx_id=-1, det_size=(640, 640))

    # Warm run to ensure all files are cached
    dummy = np.zeros((640, 640, 3), dtype=np.uint8)
    fa.get(dummy)


def _decode_image(data: dict):
    """Validate input and decode base64 image to PIL Image."""
    from PIL import Image

    if not data or "image" not in data:
        raise ValueError("Missing 'image' field in request body")

    try:
        image_bytes = base64.b64decode(data["image"])
    except Exception:
        raise ValueError("Invalid base64-encoded image data")

    try:
        pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception:
        raise ValueError("Could not decode image from provided bytes")

    return pil_image


class CaptionAnalyzer:
    """
    GPU-accelerated image captioning using BLIP.

    Usage:
        analyzer = CaptionAnalyzer()
        analyzer.load_models()
        result = analyzer.caption({"image": "<base64>"})
    """

    def load_models(self):
        """Load BLIP model onto GPU. Call once at startup."""
        import torch
        from transformers import BlipProcessor, BlipForConditionalGeneration

        self.blip_processor = BlipProcessor.from_pretrained(
            "Salesforce/blip-image-captioning-base"
        )
        self.blip_model = BlipForConditionalGeneration.from_pretrained(
            "Salesforce/blip-image-captioning-base"
        ).to("cuda")
        self.blip_model.eval()
        self.device = torch.device("cuda")

        print("BLIP captioning model loaded on GPU")

    def caption(self, data: dict) -> dict[str, Any]:
        """
        Generate a caption for a base64-encoded image.

        Args:
            data: {"image": "<base64-encoded image bytes>"}

        Returns:
            {"caption": "..."}
        """
        import torch

        pil_image = _decode_image(data)

        try:
            inputs = self.blip_processor(pil_image, return_tensors="pt").to(self.device)
            with torch.no_grad():
                output_ids = self.blip_model.generate(**inputs, max_new_tokens=50)
            caption = self.blip_processor.decode(
                output_ids[0], skip_special_tokens=True
            )
            return {"caption": caption}
        except Exception as e:
            traceback.print_exc()
            raise RuntimeError(f"Captioning failed: {str(e)}")


class FaceAnalyzer:
    """
    GPU-accelerated face detection and embedding using InsightFace.

    Usage:
        analyzer = FaceAnalyzer()
        analyzer.load_models()
        result = analyzer.detect({"image": "<base64>"})
    """

    def load_models(self):
        """Load InsightFace model onto GPU. Call once at startup."""
        import torch
        from insightface.app import FaceAnalysis

        self.face_app = FaceAnalysis(
            name="buffalo_l",
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self.face_app.prepare(ctx_id=0, det_size=(640, 640))

        # Verify GPU is actually being used
        import onnxruntime as ort

        print(f"ONNX Runtime version: {ort.__version__}")
        print(f"ONNX Runtime available providers: {ort.get_available_providers()}")
        print(f"PyTorch CUDA available: {torch.cuda.is_available()}")
        print(f"PyTorch CUDA version: {torch.version.cuda}")
        print(f"GPU device: {torch.cuda.get_device_name(0)}")

        for model in self.face_app.models:
            if hasattr(model, "session") and model.session:
                active_providers = model.session.get_providers()
                print(
                    f"InsightFace model '{model.taskname}' providers: {active_providers}"
                )

        print("InsightFace face detection model loaded on GPU")

    def detect(self, data: dict) -> dict[str, Any]:
        """
        Detect faces in a base64-encoded image.

        Args:
            data: {"image": "<base64-encoded image bytes>"}

        Returns:
            {"faces": [{"bbox": {...}, "embedding": [...], "confidence": float}]}
        """
        import numpy as np

        pil_image = _decode_image(data)

        try:
            # InsightFace expects BGR numpy array
            img_array = np.array(pil_image)[:, :, ::-1]  # RGB -> BGR
            detected_faces = self.face_app.get(img_array)

            faces = []
            for face in detected_faces:
                bbox = face.bbox.astype(int)  # [x1, y1, x2, y2]
                faces.append(
                    {
                        "bbox": {
                            "x": int(bbox[0]),
                            "y": int(bbox[1]),
                            "width": int(bbox[2] - bbox[0]),
                            "height": int(bbox[3] - bbox[1]),
                        },
                        "embedding": face.embedding.tolist(),  # 512-dim float list
                        "confidence": float(face.det_score),
                    }
                )

            return {"faces": faces}
        except Exception as e:
            traceback.print_exc()
            raise RuntimeError(f"Face detection failed: {str(e)}")


class PhotoAnalyzer:
    """
    Combined GPU-accelerated image captioning (BLIP) + face detection (InsightFace).

    Wraps CaptionAnalyzer + FaceAnalyzer for backward compatibility with
    the /analyze endpoint. New code should use the individual analyzers.

    Usage:
        analyzer = PhotoAnalyzer()
        analyzer.load_models()
        result = analyzer.analyze({"image": "<base64>"})
    """

    def __init__(self):
        self._caption = CaptionAnalyzer()
        self._faces = FaceAnalyzer()

    def load_models(self):
        """Load BLIP + InsightFace models onto GPU. Call once at startup."""
        self._caption.load_models()
        self._faces.load_models()
        print("All models loaded on GPU")

    @property
    def caption_analyzer(self) -> CaptionAnalyzer:
        return self._caption

    @property
    def face_analyzer(self) -> FaceAnalyzer:
        return self._faces

    def analyze(self, data: dict) -> dict[str, Any]:
        """
        Analyze a base64-encoded image (caption + face detection).

        Args:
            data: {"image": "<base64-encoded image bytes>"}

        Returns:
            {"caption": "...", "faces": [{"bbox": {...}, "embedding": [...], "confidence": float}]}
        """
        caption_result = self._caption.caption(data)
        faces_result = self._faces.detect(data)
        return {**caption_result, **faces_result}
