export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.heic', '.webp'];
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'];
export function isVideo(key: string): boolean {
  return VIDEO_EXTENSIONS.some((extension) => key.toLowerCase().endsWith(extension));
}
export function isSupportedMedia(key: string): boolean {
  return [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].some((extension) => key.toLowerCase().endsWith(extension));
}
