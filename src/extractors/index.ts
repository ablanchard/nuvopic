export { extractExif, parseDateFromFilename, type ExifData } from "./exif.js";
export {
  generateThumbnail,
  generatePlaceholder,
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
  type GpuCaptionResult,
  type GpuFacesResult,
  type GpuProvider,
  isGpuEnabled,
  getRealtimeGpuProvider,
  getBatchGpuProvider,
  createGpuClient,
  createRealtimeGpuClient,
  createBatchGpuClient,
} from "./gpu-client.js";

// Vast.ai exports
export { InstanceDeadError } from "./vast-client.js";

// Legacy Modal exports (backward compatibility)
export {
  analyzeWithModal,
  isModalEnabled,
  type ModalAnalysisResult,
} from "./modal-client.js";
