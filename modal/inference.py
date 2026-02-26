"""
NuvoPic GPU inference endpoint on Modal.

Runs BLIP image captioning and InsightFace face detection/recognition on a T4 GPU.
Deploy: modal deploy modal/inference.py
Test:   modal serve modal/inference.py  (local dev with hot reload)
"""

import modal


# ---------------------------------------------------------------------------
# Modal image: bake models into the container at build time
# ---------------------------------------------------------------------------
def download_models():
    """Download models during image build so cold starts don't fetch from HuggingFace."""
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


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "fastapi[standard]",
        # PyTorch 2.5+ ships CUDA 12 by default from PyPI
        "torch==2.5.1",
        "torchvision==0.20.1",
        "transformers==4.36.2",
        "Pillow>=10.0.0",
        "insightface==0.7.3",
        # ORT 1.20+ defaults to CUDA 12.x + cuDNN 9.x on PyPI
        "onnxruntime-gpu==1.20.1",
        # cuDNN 9 shared libs needed by ORT's CUDAExecutionProvider at runtime.
        # PyTorch bundles cuDNN but in a path ORT can't find; installing the
        # official nvidia pip packages puts the .so files on the linker path.
        "nvidia-cudnn-cu12",
        "nvidia-cuda-nvrtc-cu12",
        "numpy<2",
    )
    # Make cuDNN/CUDA .so files discoverable by the dynamic linker at runtime.
    # The nvidia pip packages install into site-packages/nvidia/*/lib/ which
    # is not on LD_LIBRARY_PATH by default.
    .run_commands(
        'python3 -c "'
        "import os, glob;"
        "libs = glob.glob('/usr/local/lib/python3.11/site-packages/nvidia/*/lib');"
        "print('NVIDIA lib dirs:', libs);"
        "[os.makedirs('/usr/local/lib/nvidia', exist_ok=True)];"
        "[os.symlink(so, f'/usr/local/lib/nvidia/{os.path.basename(so)}')"
        " for d in libs for so in glob.glob(os.path.join(d, '*.so*'))"
        " if not os.path.exists(f'/usr/local/lib/nvidia/{os.path.basename(so)}')]"
        '"'
    )
    .env(
        {
            "LD_LIBRARY_PATH": "/usr/local/lib/nvidia:/usr/local/lib/python3.11/site-packages/nvidia/cudnn/lib:/usr/local/lib/python3.11/site-packages/nvidia/cuda_nvrtc/lib"
        }
    )
    .run_function(download_models)
)

app = modal.App("nuvopic-inference", image=image)

# ---------------------------------------------------------------------------
# PhotoAnalyzer: GPU-accelerated captioning + face detection
# ---------------------------------------------------------------------------


@app.cls(gpu="T4", scaledown_window=30, min_containers=0, max_containers=1)
class PhotoAnalyzer:
    """
    Accepts a base64-encoded image and returns:
    - caption: text description of the image
    - faces: list of detected faces with bounding boxes and 512-dim embeddings
    """

    @modal.enter()
    def load_models(self):
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

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    def analyze(self, data: dict):
        """
        POST /analyze
        Body: { "image": "<base64-encoded image bytes>" }
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
        import base64
        import io
        import traceback

        import numpy as np
        import torch
        from fastapi.responses import JSONResponse
        from PIL import Image

        # Validate input
        if not data or "image" not in data:
            return JSONResponse(
                status_code=400,
                content={"error": "Missing 'image' field in request body"},
            )

        try:
            image_bytes = base64.b64decode(data["image"])
        except Exception:
            return JSONResponse(
                status_code=400,
                content={"error": "Invalid base64-encoded image data"},
            )

        try:
            pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        except Exception:
            return JSONResponse(
                status_code=400,
                content={"error": "Could not decode image from provided bytes"},
            )

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
            return JSONResponse(
                status_code=500,
                content={"error": f"Inference failed: {str(e)}"},
            )
