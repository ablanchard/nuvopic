import * as faceapi from "face-api.js";
import { Canvas, Image, ImageData, createCanvas, loadImage } from "canvas";
import * as path from "path";
import * as fs from "fs";
import { logger } from "../logger.js";

// Monkey-patch face-api.js to use node-canvas
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const faceApiEnv = faceapi.env as any;
faceApiEnv.monkeyPatch({
  Canvas: Canvas,
  Image: Image,
  ImageData: ImageData,
  createCanvasElement: () => createCanvas(1, 1),
  createImageElement: () => new Image(),
});

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

let modelsLoaded = false;

export async function loadFaceModels(modelsPath?: string): Promise<void> {
  if (modelsLoaded) return;

  const modelDir = modelsPath || path.join(process.cwd(), "models", "face-api");

  if (!fs.existsSync(modelDir)) {
    throw new Error(
      `Face-api models not found at ${modelDir}. Run 'npm run download-models' first.`
    );
  }

  logger.info("Loading face detection models...");

  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir),
    faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir),
  ]);

  modelsLoaded = true;
  logger.info("Face detection models loaded");
}

export async function detectFaces(
  imageBuffer: Buffer
): Promise<FaceDetection[]> {
  await loadFaceModels();

  // Load image using node-canvas
  const img = await loadImage(imageBuffer);

  // Create canvas and draw image
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  // Detect faces with landmarks and descriptors
  const detections = await faceapi
    .detectAllFaces(canvas as unknown as HTMLCanvasElement)
    .withFaceLandmarks()
    .withFaceDescriptors();

  return detections.map((detection) => ({
    boundingBox: {
      x: Math.round(detection.detection.box.x),
      y: Math.round(detection.detection.box.y),
      width: Math.round(detection.detection.box.width),
      height: Math.round(detection.detection.box.height),
    },
    embedding: Array.from(detection.descriptor),
    confidence: detection.detection.score,
  }));
}
