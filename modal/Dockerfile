# =============================================================================
# NuvoPic GPU Inference Server — for Vast.ai / standalone deployment
#
# Build:
#   docker build -f modal/Dockerfile -t nuvopic-inference:latest .
#
# Run locally (for testing):
#   docker run --gpus all -p 8000:8000 -e INFERENCE_API_KEY=secret nuvopic-inference:latest
#
# Push to registry (for Vast.ai):
#   docker tag nuvopic-inference:latest bobmoriss/nuvopic-inference:latest
#   docker push bobmoriss/nuvopic-inference:latest
#
# Or trigger the GitHub Actions workflow (recommended — builds on amd64 natively):
#   gh workflow run inference-docker.yml
# =============================================================================

FROM vastai/pytorch:cuda-13.0.2-auto

WORKDIR /app

# Install uv for fast dependency resolution, then install Python dependencies
RUN pip install --no-cache-dir uv && \
    uv pip install --system --no-cache \
    "fastapi[standard]" \
    "torch==2.5.1" \
    "torchvision==0.20.1" \
    "transformers==4.36.2" \
    "Pillow>=10.0.0" \
    "insightface==0.7.3" \
    "onnxruntime-gpu==1.20.1" \
    "nvidia-cudnn-cu12" \
    "nvidia-cuda-nvrtc-cu12" \
    "numpy<2" \
    "uvicorn[standard]"

# Make cuDNN/CUDA .so files discoverable by the dynamic linker at runtime
RUN python3 -c "\
import os, glob; \
libs = glob.glob('/usr/local/lib/python*/site-packages/nvidia/*/lib'); \
print('NVIDIA lib dirs:', libs); \
os.makedirs('/usr/local/lib/nvidia', exist_ok=True); \
[os.symlink(so, f'/usr/local/lib/nvidia/{os.path.basename(so)}') \
 for d in libs for so in glob.glob(os.path.join(d, '*.so*')) \
 if not os.path.exists(f'/usr/local/lib/nvidia/{os.path.basename(so)}')]"

ENV LD_LIBRARY_PATH="/usr/local/lib/nvidia:${LD_LIBRARY_PATH}"

# Copy inference code
COPY modal/core.py modal/server.py ./

# Download and bake models into the image (avoids download on every startup)
RUN python3 -c "\
from core import download_models; \
download_models(); \
print('Models baked into image.')"

EXPOSE 8000

# Start the inference server
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
