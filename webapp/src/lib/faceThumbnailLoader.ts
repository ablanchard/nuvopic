import { api } from '../api/client';

// A Faces page can put dozens of crops inside the 240px preload margin at
// once. Letting HTTP/2 start all of them concurrently makes the data plane
// download and resize many source photos at the same time, which delays the
// first visible row and creates a large memory spike on mobile and server.
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_MEMORY_CACHE_ENTRIES = 300;

interface QueuedRequest {
  photoId: string;
  faceId: string;
  size: number;
  signal?: AbortSignal;
  started: boolean;
  cancelled: boolean;
  resolve: (blob: Blob) => void;
  reject: (reason?: unknown) => void;
  onAbort?: () => void;
}

const queue: QueuedRequest[] = [];
const completed = new Map<string, Blob>();
let activeRequests = 0;

function cacheKey(photoId: string, faceId: string, size: number): string {
  return `${photoId}:${faceId}:${size}`;
}

function abortError(): DOMException {
  return new DOMException('Face thumbnail request was cancelled', 'AbortError');
}

function remember(key: string, blob: Blob): void {
  // Refresh insertion order when an existing item is reused.
  completed.delete(key);
  completed.set(key, blob);

  if (completed.size > MAX_MEMORY_CACHE_ENTRIES) {
    const oldestKey = completed.keys().next().value;
    if (oldestKey !== undefined) completed.delete(oldestKey);
  }
}

function pumpQueue(): void {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
    const request = queue.shift()!;
    if (request.cancelled || request.signal?.aborted) {
      if (request.onAbort) request.signal?.removeEventListener('abort', request.onAbort);
      continue;
    }

    request.started = true;
    activeRequests += 1;
    const key = cacheKey(request.photoId, request.faceId, request.size);

    api.photos.getFaceThumbnail(
      request.photoId,
      request.faceId,
      request.size,
      request.signal,
    )
      .then((blob) => {
        if (request.cancelled) return;
        remember(key, blob);
        request.resolve(blob);
      })
      .catch((error) => {
        if (!request.cancelled) request.reject(error);
      })
      .finally(() => {
        if (request.onAbort) request.signal?.removeEventListener('abort', request.onAbort);
        activeRequests -= 1;
        pumpQueue();
      });
  }
}

/**
 * Loads a face crop through a small global queue and keeps completed blobs in
 * memory for the lifetime of the app. The HTTP cache remains the durable
 * browser cache; this avoids even a cached request when a crop is rendered in
 * more than one Faces-page component.
 */
export function loadFaceThumbnail(
  photoId: string,
  faceId: string,
  size: number,
  signal?: AbortSignal,
): Promise<Blob> {
  if (signal?.aborted) return Promise.reject(abortError());

  const key = cacheKey(photoId, faceId, size);
  const cached = completed.get(key);
  if (cached) {
    remember(key, cached);
    return Promise.resolve(cached);
  }

  return new Promise<Blob>((resolve, reject) => {
    const request: QueuedRequest = {
      photoId,
      faceId,
      size,
      signal,
      started: false,
      cancelled: false,
      resolve,
      reject,
    };

    if (signal) {
      request.onAbort = () => {
        request.cancelled = true;
        reject(abortError());
        // Running fetches receive the same signal. Queued requests are skipped
        // the next time the queue is pumped.
        if (!request.started) pumpQueue();
      };
      signal.addEventListener('abort', request.onAbort, { once: true });
    }

    queue.push(request);
    pumpQueue();
  });
}
