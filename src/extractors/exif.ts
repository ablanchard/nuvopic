import ExifReader from "exif-reader";
import sharp from "sharp";
import { logger } from "../logger.js";

export interface ExifData {
  takenAt: Date | null;
  location: {
    lat: number;
    lng: number;
  } | null;
}

export type PhotoDatePrecision = "exact" | "day" | "month" | "year" | "unknown";
export type PhotoDateSource = "exif" | "filename" | "path" | "manual" | "legacy" | "unknown";

export interface ResolvedPhotoDate {
  takenAt: Date | null;
  precision: PhotoDatePrecision;
  source: PhotoDateSource;
}

const MIN_CAPTURE_YEAR = 1800;

function maxCaptureYear(): number {
  return new Date().getUTCFullYear() + 1;
}

function isPlausibleDate(date: Date): boolean {
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getUTCFullYear();
  return year >= MIN_CAPTURE_YEAR && year <= maxCaptureYear();
}

function buildUtcDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): Date | null {
  if (
    year < MIN_CAPTURE_YEAR ||
    year > maxCaptureYear() ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return date;
}

export async function extractExif(imageBuffer: Buffer): Promise<ExifData> {
  try {
    const metadata = await sharp(imageBuffer).metadata();

    if (!metadata.exif) {
      return { takenAt: null, location: null };
    }

    const exif = ExifReader(metadata.exif);

    const takenAt = parseExifDate(exif);
    const location = parseExifGps(exif);

    return { takenAt, location };
  } catch (error) {
    logger.warn("Failed to extract EXIF data:", error);
    return { takenAt: null, location: null };
  }
}

function parseExifDate(exif: Record<string, unknown>): Date | null {
  const photo = (exif.Photo ?? {}) as Record<string, unknown>;
  const image = (exif.Image ?? {}) as Record<string, unknown>;
  // exif-reader groups tags by IFD. Prefer the original capture time, then
  // digitization time, and finally the generic image modification time.
  const values = [
    photo.DateTimeOriginal,
    photo.DateTimeDigitized,
    photo.CreateDate,
    image.DateTime,
    image.ModifyDate,
    // Retain compatibility with callers/tests that provide a flat EXIF map.
    exif.DateTimeOriginal,
    exif.CreateDate,
    exif.ModifyDate,
    exif.DateTime,
  ];

  for (const value of values) {
    if (value instanceof Date) {
      if (isPlausibleDate(value)) return value;
      continue;
    }
    if (typeof value === "string") {
      const parsed = parseExifDateString(value);
      if (parsed) return parsed;
    }
  }

  return null;
}

function parseExifDateString(dateStr: string): Date | null {
  // EXIF date format: "YYYY:MM:DD HH:MM:SS"
  const match = dateStr.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    return buildUtcDate(
      parseInt(year, 10),
      parseInt(month, 10),
      parseInt(day, 10),
      parseInt(hour, 10),
      parseInt(minute, 10),
      parseInt(second, 10)
    );
  }
  return null;
}

interface GpsData {
  GPSLatitude?: number[];
  GPSLatitudeRef?: string;
  GPSLongitude?: number[];
  GPSLongitudeRef?: string;
}

function parseExifGps(
  exif: Record<string, unknown>
): { lat: number; lng: number } | null {
  const gps = (exif.GPSInfo ?? exif) as GpsData;

  if (
    !gps.GPSLatitude ||
    !gps.GPSLongitude ||
    !gps.GPSLatitudeRef ||
    !gps.GPSLongitudeRef
  ) {
    return null;
  }

  try {
    const lat = convertGpsToDecimal(gps.GPSLatitude, gps.GPSLatitudeRef);
    const lng = convertGpsToDecimal(gps.GPSLongitude, gps.GPSLongitudeRef);

    if (isNaN(lat) || isNaN(lng)) {
      return null;
    }

    return { lat, lng };
  } catch {
    return null;
  }
}

function convertGpsToDecimal(coords: number[], ref: string): number {
  // coords is [degrees, minutes, seconds]
  const [degrees, minutes, seconds] = coords;
  let decimal = degrees + minutes / 60 + seconds / 3600;

  if (ref === "S" || ref === "W") {
    decimal = -decimal;
  }

  return decimal;
}

/**
 * Attempt to extract a date from a filename when EXIF data is unavailable.
 * Supports common patterns:
 *   - IMG_20231015_143022.jpg  (Android)
 *   - 20231015_143022.jpg
 *   - 2023-10-15_14-30-22.jpg
 *   - 2023-10-15 14.30.22.jpg
 *   - Photo 2023-10-15 at 14.30.22.jpg (Apple)
 *   - Screenshot_2023-10-15-14-30-22.png
 *   - PXL_20231015_143022123.jpg (Pixel)
 */
export function parseDateFromFilename(filename: string): Date | null {
  // Strip path, keep only the basename
  const basename = filename.replace(/^.*[\\/]/, "");

  // Pattern 1: YYYYMMDD_HHMMSS (e.g. IMG_20231015_143022, PXL_20231015_143022123)
  const p1 = basename.match(/(?<!\d)(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[_-](\d{2})(\d{2})(\d{2})(?:\d{1,3})?(?!\d)/);
  if (p1) {
    const [, year, month, day, hour, minute, second] = p1;
    return buildUtcDate(+year, +month, +day, +hour, +minute, +second);
  }

  // Pattern 2: YYYY-MM-DD[_ T at]HH[-.]MM[-.]SS (e.g. 2023-10-15_14-30-22, Photo 2023-10-15 at 14.30.22)
  const p2 = basename.match(/(?<!\d)(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[\s_T-]+(?:at\s+)?(\d{2})[.\-:](\d{2})[.\-:](\d{2})(?!\d)/);
  if (p2) {
    const [, year, month, day, hour, minute, second] = p2;
    return buildUtcDate(+year, +month, +day, +hour, +minute, +second);
  }

  // Pattern 3: YYYY-MM-DD only (no time component)
  const p3 = basename.match(/(?<!\d)(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)/);
  if (p3) {
    const [, year, month, day] = p3;
    return buildUtcDate(+year, +month, +day);
  }

  // Pattern 4: YYYYMMDD only (e.g. 20231015_photo.jpg)
  const p4 = basename.match(/(?<!\d)(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/);
  if (p4) {
    const [, year, month, day] = p4;
    return buildUtcDate(+year, +month, +day);
  }

  return null;
}

function filenameDatePrecision(filename: string): Exclude<PhotoDatePrecision, "month" | "year" | "unknown"> | null {
  const basename = filename.replace(/^.*[\\/]/, "");
  if (
    /(?<!\d)\d{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[_-]\d{6}(?:\d{1,3})?(?!\d)/.test(basename) ||
    /(?<!\d)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])[\s_T-]+(?:at\s+)?\d{2}[.\-:]\d{2}[.\-:]\d{2}(?!\d)/.test(basename)
  ) {
    return "exact";
  }
  return parseDateFromFilename(basename) ? "day" : null;
}

function parseDateFromPath(path: string): ResolvedPhotoDate | null {
  const dayMatch = path.match(/(?:^|[\\/])(\d{4})[\\/](0[1-9]|1[0-2])[\\/](0[1-9]|[12]\d|3[01])(?:[\\/]|$)/);
  if (dayMatch) {
    const date = buildUtcDate(+dayMatch[1], +dayMatch[2], +dayMatch[3]);
    if (date) return { takenAt: date, precision: "day", source: "path" };
  }

  const monthMatch = path.match(/(?:^|[\\/])(\d{4})[\\/](0[1-9]|1[0-2])(?:[\\/]|$)/);
  if (monthMatch) {
    const date = buildUtcDate(+monthMatch[1], +monthMatch[2], 1);
    if (date) return { takenAt: date, precision: "month", source: "path" };
  }

  const yearMatch = path.match(/(?:^|[\\/])(\d{4})(?:[\\/]|$)/);
  if (yearMatch) {
    const date = buildUtcDate(+yearMatch[1], 1, 1);
    if (date) return { takenAt: date, precision: "year", source: "path" };
  }
  return null;
}

export function resolvePhotoDate(exifTakenAt: Date | null, path: string): ResolvedPhotoDate {
  if (exifTakenAt && isPlausibleDate(exifTakenAt)) {
    return { takenAt: exifTakenAt, precision: "exact", source: "exif" };
  }

  const filenameDate = parseDateFromFilename(path);
  const precision = filenameDatePrecision(path);
  if (filenameDate && precision) {
    return { takenAt: filenameDate, precision, source: "filename" };
  }

  return parseDateFromPath(path) ?? {
    takenAt: null,
    precision: "unknown",
    source: "unknown",
  };
}
