/**
 * Process version tracks which version of the processing pipeline was used.
 * Bump this version when extractors or processing logic changes.
 *
 * Follows semver:
 *   - MAJOR: breaking changes (e.g. new DB schema for extracted data)
 *   - MINOR: new extractors or significant extraction improvements
 *   - PATCH: bug fixes in existing extractors
 */
export const PROCESS_VERSION = "1.1.0";

/**
 * Changelog describing what changed in each version.
 * Used by the reprocess endpoint to inform the user what re-running will do.
 */
export const PROCESS_CHANGELOG: Record<string, string> = {
  "1.1.0": "Fallback to filename-based date parsing when EXIF data is missing",
  "1.0.0": "Initial processing: EXIF extraction, thumbnails, AI captions, face detection",
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
