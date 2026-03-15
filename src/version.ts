/**
 * Process version tracks which version of the processing pipeline was used.
 * Bump this version when extractors or processing logic changes.
 *
 * Follows semver:
 *   - MAJOR: breaking changes (e.g. new DB schema for extracted data)
 *   - MINOR: new extractors or significant extraction improvements
 *   - PATCH: bug fixes in existing extractors
 *
 * Since v3.0.0, caption and face detection are versioned independently
 * so you can update one model without reprocessing the other.
 */

/** Overall process version (for local extraction: EXIF, thumbnail, placeholder, dimensions). */
export const PROCESS_VERSION = "3.1.0";

/** Caption model version — bump when changing the captioning model or prompt. */
export const CAPTION_VERSION = "1.0.0";

/** Face detection version — bump when changing the face detection/embedding model. */
export const FACES_VERSION = "1.0.0";

/**
 * Changelog describing what changed in each version.
 * Used by the reprocess endpoint to inform the user what re-running will do.
 */
export const PROCESS_CHANGELOG: Record<string, string> = {
  "3.1.0":
    "Generate tiny 16x16 WebP placeholder for progressive grid loading; photos load directly from S3 on scroll",
  "3.0.0":
    "Split GPU processing: caption and face detection are now independent pipelines with separate versioning. Reprocess one without the other.",
  "2.2.0":
    "Store original image dimensions (width/height) in DB for aspect-ratio-aware modal display; skipModal reprocess support",
  "2.1.0":
    "Upgraded thumbnails from 200x200 JPEG to 300x300 WebP for sharper previews on high-density screens with reduced storage",
  "2.0.0":
    "GPU-accelerated processing via Modal: BLIP captioning, InsightFace 512-dim embeddings (breaking: incompatible with 128-dim face-api.js embeddings)",
  "1.1.0": "Fallback to filename-based date parsing when EXIF data is missing",
  "1.0.0": "Initial processing: EXIF extraction, thumbnails, AI captions, face detection",
};

export const CAPTION_CHANGELOG: Record<string, string> = {
  "1.0.0": "BLIP image captioning (Salesforce/blip-image-captioning-base)",
};

export const FACES_CHANGELOG: Record<string, string> = {
  "1.0.0": "InsightFace buffalo_l with 512-dim embeddings",
};

/**
 * Compare two semver strings. Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}
