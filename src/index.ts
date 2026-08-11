import crypto from "node:crypto";
import { processPhoto, processPhotoBatch, type ProcessPhotoOutput } from "./processor.js";
import { getRealtimeGpuProvider } from "./extractors/gpu-client.js";
import { GpuPaymentRequiredError } from "./metering/gpu-metering.js";
import { logger } from "./logger.js";

// S3 Event types
interface S3EventRecord {
  s3: {
    bucket: {
      name: string;
    };
    object: {
      key: string;
    };
  };
}

interface S3Event {
  Records: S3EventRecord[];
}

// Direct invocation input
interface DirectInvocation {
  s3Bucket: string;
  s3Key: string;
}

// Handler response
interface HandlerResponse {
  statusCode: number;
  body: string;
}

// Supported image extensions
const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".heic", ".webp"];

function isSupportedImage(key: string): boolean {
  const lower = key.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isS3Event(event: unknown): event is S3Event {
  return (
    typeof event === "object" &&
    event !== null &&
    "Records" in event &&
    Array.isArray((event as S3Event).Records)
  );
}

function isDirectInvocation(event: unknown): event is DirectInvocation {
  return (
    typeof event === "object" &&
    event !== null &&
    "s3Bucket" in event &&
    "s3Key" in event
  );
}

export async function handler(
  event: S3Event | DirectInvocation
): Promise<HandlerResponse> {
  const results: ProcessPhotoOutput[] = [];
  const errors: string[] = [];

  try {
    if (isS3Event(event)) {
      const inputs: Array<{ s3Bucket: string; s3Key: string }> = [];
      for (const record of event.Records) {
        const bucket = record.s3.bucket.name;
        const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

        if (!isSupportedImage(key)) {
          logger.debug(`Skipping unsupported file: ${key}`);
          continue;
        }

        inputs.push({ s3Bucket: bucket, s3Key: key });
      }
      if (inputs.length > 0) {
        const batchResults = await processPhotoBatch(inputs, undefined, null, {
          provider: getRealtimeGpuProvider(),
          externalJobId: crypto.randomUUID(),
        });
        for (const result of batchResults) {
          results.push(result);
          if (result.errors.length > 0) errors.push(...result.errors);
        }
      }
    } else if (isDirectInvocation(event)) {
      // Direct invocation
      if (!isSupportedImage(event.s3Key)) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: `Unsupported file type: ${event.s3Key}`,
          }),
        };
      }

      const [result] = await processPhotoBatch(
        [{ s3Bucket: event.s3Bucket, s3Key: event.s3Key }],
        undefined,
        null,
        {
          provider: getRealtimeGpuProvider(),
          externalJobId: crypto.randomUUID(),
        }
      );
      results.push(result);
    } else {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Invalid event format. Expected S3 event or direct invocation.",
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        processed: results.length,
        results,
        errors: errors.length > 0 ? errors : undefined,
      }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Handler error:", err);

    if (err instanceof GpuPaymentRequiredError) {
      return {
        statusCode: 402,
        body: JSON.stringify({
          error: "payment_required",
          message: err.message,
          currency: err.currency,
          requiredMicros: err.requiredMicros,
          availableMicros: err.availableMicros,
        }),
      };
    }
    return { statusCode: 500, body: JSON.stringify({ error: message }) };
  }
}

// Export for direct module execution (testing)
export { processPhoto, type ProcessPhotoOutput };
