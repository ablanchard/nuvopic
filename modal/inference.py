"""
NuvoPic GPU inference endpoint on Modal.

Thin wrapper around core.PhotoAnalyzer with Modal decorators.
Deploy: modal deploy modal/inference.py
Test:   modal serve modal/inference.py  (local dev with hot reload)
"""

import modal
from core import PhotoAnalyzer as _PhotoAnalyzerCore, download_models


# ---------------------------------------------------------------------------
# Modal image: bake models into the container at build time
# ---------------------------------------------------------------------------
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
    .add_local_file("modal/core.py", "/root/core.py")
)

app = modal.App("nuvopic-inference", image=image)

# ---------------------------------------------------------------------------
# PhotoAnalyzer: Modal wrapper around core.PhotoAnalyzer
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
        self._core = _PhotoAnalyzerCore()
        self._core.load_models()

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
        from fastapi.responses import JSONResponse

        try:
            return self._core.analyze(data)
        except ValueError as e:
            return JSONResponse(status_code=400, content={"error": str(e)})
        except RuntimeError as e:
            return JSONResponse(status_code=500, content={"error": str(e)})
