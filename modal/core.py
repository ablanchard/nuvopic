"""
Shared inference core for NuvoPic GPU processing.

Pure Python — no Modal or FastAPI dependencies.
Used by both modal/inference.py (Modal deployment) and modal/server.py (standalone).
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


class PhotoAnalyzer:
    """
    GPU-accelerated image captioning (BLIP) + face detection (InsightFace).

    Usage:
        analyzer = PhotoAnalyzer()
        analyzer.load_models()
        result = analyzer.analyze({"image": "<base64>"})
    """

    def load_models(self):
        """Load BLIP + InsightFace models onto GPU. Call once at startup."""
        import torch
        from transformers import BlipProcessor, BlipForConditionalGeneration
        from insightface.app import FaceAnalysis

        # BLIP captioning
        self.blip_processor = BlipProcessor.from_pretrained(
            "Salesforce/blip-image-captioning-base"
        )
        self.blip_model = BlipForConditionalGeneration.from_pretrained(
            "Salesforce/blip-image-captioning-base"
        ).to("cuda")
        self.blip_model.eval()

        # InsightFace (uses ONNX Runtime with GPU)
        self.face_app = FaceAnalysis(
            name="buffalo_l",
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self.face_app.prepare(ctx_id=0, det_size=(640, 640))

        self.device = torch.device("cuda")

        # Verify GPU is actually being used
        import onnxruntime as ort

        print(f"ONNX Runtime version: {ort.__version__}")
        print(f"ONNX Runtime available providers: {ort.get_available_providers()}")
        print(f"PyTorch CUDA available: {torch.cuda.is_available()}")
        print(f"PyTorch CUDA version: {torch.version.cuda}")
        print(f"GPU device: {torch.cuda.get_device_name(0)}")

        # Check which provider InsightFace models are actually using
        for model in self.face_app.models:
            if hasattr(model, "session") and model.session:
                active_providers = model.session.get_providers()
                print(
                    f"InsightFace model '{model.taskname}' providers: {active_providers}"
                )

        print("Models loaded on GPU")

    def analyze(self, data: dict) -> dict[str, Any]:
        """
        Analyze a base64-encoded image.

        Args:
            data: {"image": "<base64-encoded image bytes>"}

        Returns:
            {"caption": "...", "faces": [{"bbox": {...}, "embedding": [...], "confidence": float}]}

        Raises:
            ValueError: on invalid input (missing image, bad base64, undecodable image)
            RuntimeError: on inference failure
        """
        import numpy as np
        import torch
        from PIL import Image

        # Validate input
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

        try:
            # --- Captioning ---
            inputs = self.blip_processor(pil_image, return_tensors="pt").to(self.device)
            with torch.no_grad():
                output_ids = self.blip_model.generate(**inputs, max_new_tokens=50)
            caption = self.blip_processor.decode(
                output_ids[0], skip_special_tokens=True
            )

            # --- Face detection + embedding ---
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

            return {"caption": caption, "faces": faces}

        except Exception as e:
            traceback.print_exc()
            raise RuntimeError(f"Inference failed: {str(e)}")
