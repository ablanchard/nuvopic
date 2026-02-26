# Coding Conventions

**Analysis Date:** 2026-02-26

## Naming Patterns

**Files:**
- Module files use lowercase with hyphens: `exif.ts`, `modal-client.ts`, `jwt.ts`
- Component files use PascalCase: `PhotoCard.tsx`, `PersonList.tsx`, `PhotoGrid.tsx`
- Index files named `index.ts` for module entry points: `src/extractors/index.ts`, `src/api/index.ts`
- Test files follow source file name with `.test.ts`: `extractors.test.ts`, `process-photo.test.ts`

**Functions:**
- Use camelCase for all functions: `parseExifDate()`, `extractExif()`, `loadPage()`, `getOptimalConcurrency()`
- Prefix utility/helper functions clearly: `convertGpsToDecimal()`, `parseExifDateString()`, `isSupportedImage()`
- Factory/loader functions start with `load` or `get`: `loadFaceModels()`, `getOptimalConcurrency()`, `getPool()`
- Async handlers/middleware use descriptive names: `handleLogin()`, `handleLogout()`, `handleLoginPage()`

**Variables:**
- Use camelCase for all variables: `imageBuffer`, `photoSize`, `selectedPhoto`, `loadingRef`
- Boolean flags start with `is` or have `Ref` suffix for refs: `isModalEnabled()`, `isIntersecting`, `loadingRef`, `sentinelRef`
- State signals use descriptive nouns: `photoSize`, `selectedTag`, `selectedPerson`, `searchQuery`
- Refs explicitly named with `Ref` suffix: `pageRef`, `observerRef`, `sentinelRef`, `loadingRef`

**Types:**
- Interfaces use PascalCase with descriptive names: `PhotoRecord`, `FaceRecord`, `ProcessPhotoInput`, `ProcessPhotoOutput`
- Type aliases also PascalCase: `ExifData`, `GpsData`, `JwtPayload`
- Interfaces for function parameters: `InsertPhotoParams`, `InsertFaceParams`
- Response types nest fields: `PhotoListResponse` with `photos`, `pagination`

**Database Fields:**
- Snake_case in database schemas: `s3_path`, `taken_at`, `location_lat`, `bounding_box`
- Converted to camelCase in TypeScript interfaces: `s3Path`, `takenAt`, `locationLat`, `boundingBox`

## Code Style

**Formatting:**
- No explicit formatter configured (no .eslintrc, .prettierrc, or biome.json found)
- Code uses consistent 2-space indentation throughout
- Imports organized with blank lines between groups: Node modules → internal modules → type imports

**Linting:**
- TypeScript strict mode enabled (`strict: true` in tsconfig.json)
- Module resolution uses `bundler` strategy for ES modules

**Import Organization:**

1. **Standard library imports** - Node.js modules first (`import crypto from "node:crypto"`, `import * as os from "os"`)
2. **External packages** - Third-party imports (`import sharp from "sharp"`, `import { Hono } from "hono"`)
3. **Internal modules** - Relative imports from same project (`import { logger } from "./logger.js"`)
4. **Type imports** - Type-only imports at end (`import type { Photo } from "../api/client"`)

All imports use explicit `.js` extensions for ES module compatibility.

**Path Aliases:**
- No path aliases configured in webapp or backend
- All imports use relative paths with `.js` extensions: `./src/logger.js`, `../../db/queries.js`

## Error Handling

**Patterns:**
- Graceful fallbacks with `try-catch` blocks returning null/empty values on error
- Functions return nullable types for safe error handling: `Date | null`, `ExifData | null`, `{ lat, lng } | null`
- Errors logged via `logger.error()` but execution continues (non-blocking)
- HTTP handlers return appropriate status codes: 400 for bad requests, 401 for unauthorized, 404 for not found, 500 for server errors

**Example from `extractors/exif.ts`:**
```typescript
export async function extractExif(imageBuffer: Buffer): Promise<ExifData> {
  try {
    const metadata = await sharp(imageBuffer).metadata();
    if (!metadata.exif) {
      return { takenAt: null, location: null };
    }
    // ... processing
  } catch (error) {
    logger.warn("Failed to extract EXIF data:", error);
    return { takenAt: null, location: null };
  }
}
```

**Promise.allSettled() pattern:** When multiple async operations are independent, use `Promise.allSettled()` to avoid cascading failures:
```typescript
const [exifResult, thumbnailResult, modalResult] = await Promise.allSettled([
  extractExif(imageBuffer),
  generateThumbnail(imageBuffer),
  analyzeWithModal(imageBuffer),
]);

exif = exifResult.status === "fulfilled" ? exifResult.value : { takenAt: null, location: null };
```

## Logging

**Framework:** Custom logger in `src/logger.ts` wrapping `console`

**Log Levels:** `debug`, `info`, `warn`, `error`

**Patterns:**
- Use `logger.info()` for operation summaries: `logger.info(\`Processing photo: ${s3Path}\`)`
- Use `logger.debug()` for detailed data: `logger.debug(\`Downloaded ${imageBuffer.length} bytes\`)`
- Use `logger.warn()` for non-blocking issues: `logger.warn("Failed to extract EXIF data:", error)`
- Use `logger.error()` for failures or exceptions: `logger.error("Webhook processing error:", error)`
- Log structured information as objects: `logger.info("Processed photo:", { photoId, facesDetected, errorCount })`
- Use `LOG_LEVEL` environment variable to control verbosity

**Examples from codebase:**
```typescript
logger.info(`Processing photo: ${s3Path}`);
logger.debug(`Downloaded ${imageBuffer.length} bytes`);
logger.info(`Processed ${s3Path}:`, {
  photoId,
  mode: isModalEnabled() ? "modal" : "local",
  takenAt: takenAt?.toISOString(),
  hasLocation: !!exif.location,
});
```

## Comments

**When to Comment:**
- Use JSDoc blocks for exported functions with parameters and return types
- Comments explain WHY, not WHAT (code should be self-documenting)
- Inline comments for non-obvious logic or performance decisions

**JSDoc Pattern:**
```typescript
/**
 * Attempt to extract a date from a filename when EXIF data is unavailable.
 * Supports common patterns:
 *   - IMG_20231015_143022.jpg  (Android)
 *   - 2023-10-15_14-30-22.jpg
 *   - Photo 2023-10-15 at 14.30.22.jpg (Apple)
 */
export function parseDateFromFilename(filename: string): Date | null {
```

**Block Comments:**
```typescript
// EXIF + thumbnail stay local (fast, no GPU needed).
// Caption + faces go to Modal as a single HTTP call (non-blocking I/O).
```

## Function Design

**Size:** Functions typically 20-50 lines; longer functions break into helpers
- `extractExif()` is 19 lines
- `parseExif()` and `parseExifGps()` are 20-40 lines each
- Route handlers are 30-50 lines with helper utilities

**Parameters:**
- Single parameter object pattern for functions with multiple params: `processPhoto(input: ProcessPhotoInput)`
- Function signatures clear about required vs optional: `createToken(subject: string, expiresInSeconds = 86400 * 7)`

**Return Values:**
- Explicit return types in signatures: `Promise<ExifData>`, `Date | null`, `Promise<ProcessPhotoOutput>`
- Functions return data, not void, for composability
- When function has no value to return but needs to complete, return `Promise<void>`

**Preact Hook Patterns (frontend):**
- Use `useState()` for component state: `const [photos, setPhotos] = useState<Photo[]>([])`
- Use `useRef()` for mutable values persisting across renders: `const pageRef = useRef(1)`
- Use `useCallback()` for stable function references: `const loadPage = useCallback(async (page) => {...}, [])`
- Use `useSignalEffect()` for Signals integration: `useSignalEffect(() => { /* runs when signals change */ })`
- Use `useEffect()` for side effects with cleanup: `useEffect(() => { /* setup */ return () => { /* cleanup */ } }, [deps])`

## Module Design

**Exports:**
- Default exports for single main export: `export default api`, `export default photos`
- Named exports for utilities and types: `export const PROCESS_VERSION`, `export interface PhotoRecord`, `export async function insertPhoto()`
- Type-only exports: `export type { Photo, PhotoListResponse }` (when needed)

**Barrel Files:**
- Used in extractors: `src/extractors/index.ts` re-exports all extractor functions
- Simplifies imports: `import { extractExif, generateThumbnail, detectFaces } from "./extractors/index.js"`

**File Organization:**
- Database logic in `src/db/` modules:
  - `client.ts` - connection pool
  - `queries.ts` - SQL operations
  - `search.ts` - complex queries
  - `tags.ts`, `persons.ts` - domain-specific operations

- API routes in `src/api/routes/`:
  - `photos.ts`, `persons.ts`, `tags.ts` - one module per resource

- Extractors in `src/extractors/`:
  - `exif.ts`, `thumbnail.ts`, `caption.ts`, `faces.ts`, `modal-client.ts`

## Type Usage

**Strict TypeScript:**
- All functions have explicit return types
- Interfaces defined for all external data boundaries
- Use `satisfies` keyword for type checking without explicit type annotation:
```typescript
const payload = base64UrlEncode(
  JSON.stringify({
    sub: subject,
    iat: now,
    exp: now + expiresInSeconds,
  } satisfies JwtPayload)
);
```

**Nullability:**
- Use nullable types for optional data: `Date | null`, `ExifData | null`
- Nullish coalescing for defaults: `exif.location?.lat ?? null`, `caption ?? null`
- Optional chaining extensively: `exif.location?.lat`, `photo.thumbnail?.buffer.length`

---

*Convention analysis: 2026-02-26*
