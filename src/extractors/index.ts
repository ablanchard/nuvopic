export { extractExif, parseDateFromFilename, type ExifData } from "./exif.js";
export {
  generateThumbnail,
  type ThumbnailResult,
} from "./thumbnail.js";
export { generateCaption, loadCaptionModel } from "./caption.js";
export {
  detectFaces,
  loadFaceModels,
  type FaceDetection,
} from "./faces.js";

// GPU client abstraction (provider-agnostic)
export {
  type GpuClient,
  type GpuAnalysisResult,
  type GpuProvider,
  isGpuEnabled,
  getRealtimeGpuProvider,
  getBatchGpuProvider,
  createGpuClient,
  createRealtimeGpuClient,
  createBatchGpuClient,
} from "./gpu-client.js";

// Legacy Modal exports (backward compatibility)
export {
  analyzeWithModal,
  isModalEnabled,
  type ModalAnalysisResult,
} from "./modal-client.js";
