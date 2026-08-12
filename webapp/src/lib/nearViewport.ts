const DEFAULT_MARGIN = 240;

type NearViewportCallback = () => void;

const targets = new Map<Element, NearViewportCallback>();
let observer: IntersectionObserver | null = null;
let fallbackFrame: number | null = null;
let fallbackListening = false;

function isNearViewport(element: Element, margin: number): boolean {
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;

  return (
    rect.bottom >= -margin &&
    rect.top <= viewportHeight + margin &&
    rect.right >= -margin &&
    rect.left <= viewportWidth + margin
  );
}

function stopFallbackListeners() {
  if (!fallbackListening) return;

  fallbackListening = false;
  window.removeEventListener('scroll', scheduleFallbackCheck, true);
  window.removeEventListener('resize', scheduleFallbackCheck);
  window.visualViewport?.removeEventListener('scroll', scheduleFallbackCheck);
  window.visualViewport?.removeEventListener('resize', scheduleFallbackCheck);
}

function reveal(element: Element) {
  const callback = targets.get(element);
  if (!callback) return;

  targets.delete(element);
  observer?.unobserve(element);
  callback();

  if (targets.size === 0) stopFallbackListeners();
}

function checkTargets() {
  fallbackFrame = null;
  for (const element of targets.keys()) {
    if (isNearViewport(element, DEFAULT_MARGIN)) reveal(element);
  }
}

function scheduleFallbackCheck() {
  if (fallbackFrame !== null) return;
  fallbackFrame = window.requestAnimationFrame(checkTargets);
}

function startFallbackListeners() {
  if (fallbackListening) return;

  fallbackListening = true;
  // Scroll does not bubble, so capture it to cover the Faces sidebar and any
  // other nested scroll containers as well as the document viewport.
  window.addEventListener('scroll', scheduleFallbackCheck, { capture: true, passive: true });
  window.addEventListener('resize', scheduleFallbackCheck, { passive: true });
  window.visualViewport?.addEventListener('scroll', scheduleFallbackCheck, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleFallbackCheck, { passive: true });
}

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;

  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) reveal(entry.target);
    }
  }, { rootMargin: `${DEFAULT_MARGIN}px` });

  return observer;
}

/**
 * Runs callback once an element is close enough to the visible viewport.
 *
 * IntersectionObserver remains the primary path. The geometry check is a
 * fallback for mobile browsers whose viewport changes or nested scrolling can
 * leave an observer callback stale.
 */
export function whenNearViewport(
  element: Element,
  callback: NearViewportCallback,
): () => void {
  targets.set(element, callback);
  getObserver()?.observe(element);
  startFallbackListeners();
  scheduleFallbackCheck();

  return () => {
    targets.delete(element);
    observer?.unobserve(element);
    if (targets.size === 0) stopFallbackListeners();
  };
}
