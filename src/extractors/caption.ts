import { pipeline, env, RawImage } from "@xenova/transformers";
import sharp from "sharp";
import { logger } from "../logger.js";

// Configure transformers.js for Node.js environment
env.allowLocalModels = true;
env.useBrowserCache = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let captionPipeline: any = null;

const MODEL_NAME = "Xenova/vit-gpt2-image-captioning";

export async function loadCaptionModel(): Promise<void> {
  if (!captionPipeline) {
    logger.info("Loading caption model...");
    captionPipeline = await pipeline("image-to-text", MODEL_NAME);
    logger.info("Caption model loaded");
  }
}

interface CaptionResult {
  generated_text: string;
}

export async function generateCaption(imageBuffer: Buffer): Promise<string> {
  await loadCaptionModel();

  if (!captionPipeline) {
    throw new Error("Caption pipeline not initialized");
  }

  // Use sharp to decode image and get raw pixel data
  const { data, info } = await sharp(imageBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Create RawImage from pixel data (avoids URL fetch issues)
  const image = new RawImage(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
    info.channels as 1 | 2 | 3 | 4
  );

  const result = (await captionPipeline(image, {
    max_new_tokens: 50,
  })) as CaptionResult[];

  if (Array.isArray(result) && result.length > 0) {
    return result[0].generated_text.trim();
  }

  return "";
}
