export interface FaceDetection {
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  embedding: number[];
  confidence: number;
}

const LOCAL_FACE_ERROR =
  "Local face-api.js inference is no longer supported because its 128-dimensional " +
  "descriptors are incompatible with NuvoPic's 512-dimensional InsightFace index. " +
  "Configure Modal or Vast.ai for face inference, or import with GPU mode 'skip'.";

/** Retained as an explicit compatibility error for callers of the old API. */
export async function loadFaceModels(_modelsPath?: string): Promise<void> {
  throw new Error(LOCAL_FACE_ERROR);
}

/**
 * Face inference must use the shared InsightFace buffalo_l implementation so
 * every persisted embedding belongs to the same vector space.
 */
export async function detectFaces(
  _imageBuffer: Buffer
): Promise<FaceDetection[]> {
  throw new Error(LOCAL_FACE_ERROR);
}
