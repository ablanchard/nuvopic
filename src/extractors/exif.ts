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
