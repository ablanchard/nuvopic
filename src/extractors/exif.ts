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
  // Try different date fields in order of preference
  const dateFields = [
    "DateTimeOriginal",
    "CreateDate",
    "ModifyDate",
    "DateTime",
  ];

  for (const field of dateFields) {
    const value = exif[field];
    if (value instanceof Date) {
      return value;
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
    return new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour),
      parseInt(minute),
      parseInt(second)
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
  const gps = exif as GpsData;

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
  const p1 = basename.match(/(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[_-](\d{2})(\d{2})(\d{2})/);
  if (p1) {
    const [, year, month, day, hour, minute, second] = p1;
    const date = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
    if (!isNaN(date.getTime())) return date;
  }

  // Pattern 2: YYYY-MM-DD[_ T at]HH[-.]MM[-.]SS (e.g. 2023-10-15_14-30-22, Photo 2023-10-15 at 14.30.22)
  const p2 = basename.match(/(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[\s_T-]+(?:at\s+)?(\d{2})[.\-:](\d{2})[.\-:](\d{2})/);
  if (p2) {
    const [, year, month, day, hour, minute, second] = p2;
    const date = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
    if (!isNaN(date.getTime())) return date;
  }

  // Pattern 3: YYYY-MM-DD only (no time component)
  const p3 = basename.match(/(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/);
  if (p3) {
    const [, year, month, day] = p3;
    const date = new Date(Date.UTC(+year, +month - 1, +day));
    if (!isNaN(date.getTime())) return date;
  }

  // Pattern 4: YYYYMMDD only (e.g. 20231015_photo.jpg)
  const p4 = basename.match(/(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (p4) {
    const [, year, month, day] = p4;
    const date = new Date(Date.UTC(+year, +month - 1, +day));
    if (!isNaN(date.getTime())) return date;
  }

  return null;
}
