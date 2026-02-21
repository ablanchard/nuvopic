import * as path from "path";
import * as fs from "fs";
import { logger } from "../logger.js";

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let faceapi: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let canvasLib: any = null;

async function loadLibs(): Promise<void> {
  if (!faceapi) {
    // @ts-ignore — package only available in local fallback mode
    faceapi = await import("face-api.js");
    // @ts-ignore — package only available in local fallback mode
    canvasLib = await import("canvas");

    // Monkey-patch face-api.js to use node-canvas
    const faceApiEnv = faceapi.env as any;
    faceApiEnv.monkeyPatch({
      Canvas: canvasLib.Canvas,
      Image: canvasLib.Image,
      ImageData: canvasLib.ImageData,
      createCanvasElement: () => canvasLib.createCanvas(1, 1),
      createImageElement: () => new canvasLib.Image(),
    });
  }
}

export async function loadFaceModels(modelsPath?: string): Promise<void> {
  if (modelsLoaded) return;

  await loadLibs();

  const modelDir = modelsPath || path.join(process.cwd(), "models", "face-api");

  if (!fs.existsSync(modelDir)) {
    throw new Error(
      `Face-api models not found at ${modelDir}. Local face detection requires face-api.js model weights.`
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
  await loadLibs();

  // Load image using node-canvas
  const img = await canvasLib.loadImage(imageBuffer);

  // Create canvas and draw image
  const canvas = canvasLib.createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  // Detect faces with landmarks and descriptors
  const detections = await faceapi
    .detectAllFaces(canvas)
    .withFaceLandmarks()
    .withFaceDescriptors();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return detections.map((detection: any) => ({
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
