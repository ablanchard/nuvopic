import KDBush from "kdbush";
import * as geokdbush from "geokdbush";
import { createRequire } from "node:module";

interface CityRecord {
  city: string;
  lat: string;
  lng: string;
  country: string;
  admin_name: string;
}

export interface ResolvedLocation {
  name: string;
  region: string | null;
  country: string;
}

const require = createRequire(import.meta.url);

let cityRecords: CityRecord[] | null = null;
let cityIndex: KDBush | null = null;

function getCityRecords(): CityRecord[] {
  if (!cityRecords) {
    cityRecords = (require("world-cities-json") as { cities: CityRecord[] }).cities;
  }
  return cityRecords;
}

function getCityIndex(): KDBush {
  if (cityIndex) return cityIndex;

  const records = getCityRecords();
  const index = new KDBush(records.length);
  for (const city of records) {
    index.add(Number(city.lng), Number(city.lat));
  }
  cityIndex = index.finish();
  return cityIndex;
}

/** Resolve WGS84 coordinates to the nearest city, entirely offline. */
export function resolveLocation(lat: number, lng: number): ResolvedLocation | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const [nearestId] = geokdbush.around(getCityIndex(), lng, lat, 1);
  if (nearestId === undefined) return null;

  const city = getCityRecords()[nearestId];
  if (!city?.city || !city.country) return null;

  return {
    name: city.city,
    region: city.admin_name || null,
    country: city.country,
  };
}
