import type { Photo } from '../api/client';

export function formatPhotoDate(
  photo: Pick<Photo, 'takenAt' | 'dateUnknown' | 'datePrecision'>,
  includeTime = false,
): string {
  if (photo.dateUnknown || !photo.takenAt) return 'Unknown date';

  const date = new Date(photo.takenAt);
  if (Number.isNaN(date.getTime())) return 'Unknown date';

  switch (photo.datePrecision) {
    case 'year':
      return new Intl.DateTimeFormat(undefined, { year: 'numeric' }).format(date);
    case 'month':
      return new Intl.DateTimeFormat(undefined, {
        month: 'long',
        year: 'numeric',
      }).format(date);
    case 'day':
      return date.toLocaleDateString();
    case 'exact':
    default:
      return includeTime ? date.toLocaleString() : date.toLocaleDateString();
  }
}
