import { signal, computed } from '@preact/signals';

export const searchQuery = signal('');
export const selectedTag = signal<string | null>(null);
export const selectedPerson = signal<string | null>(null);
export const selectedSmartTag = signal<string | null>(null);
export const dateFrom = signal<string | null>(null);
export const dateTo = signal<string | null>(null);
export const dateUnknown = signal(false);
export const selectedLocationCity = signal<string | null>(null);
export const selectedLocationRegion = signal<string | null>(null);
export const selectedLocationCountry = signal<string | null>(null);

export const DEFAULT_PHOTO_SIZE = 200;
export const MOBILE_DEFAULT_PHOTO_SIZE = 100;

const initialPhotoSize =
  typeof window !== 'undefined' &&
  window.matchMedia('(max-width: 768px)').matches
    ? MOBILE_DEFAULT_PHOTO_SIZE
    : DEFAULT_PHOTO_SIZE;

export const photoSize = signal(initialPhotoSize);

// Bumped whenever filters change, so PhotoGrid knows to reset accumulated photos
export const filterVersion = signal(0);

export const filters = computed(() => ({
  search: searchQuery.value || undefined,
  tag: selectedTag.value || undefined,
  person: selectedPerson.value || undefined,
  smartTag: selectedSmartTag.value || undefined,
  from: dateFrom.value || undefined,
  to: dateTo.value || undefined,
  dateUnknown: dateUnknown.value || undefined,
  city: selectedLocationCity.value || undefined,
  region: selectedLocationRegion.value || undefined,
  country: selectedLocationCountry.value || undefined,
}));

export function resetFilters() {
  searchQuery.value = '';
  selectedTag.value = null;
  selectedPerson.value = null;
  selectedSmartTag.value = null;
  dateFrom.value = null;
  dateTo.value = null;
  dateUnknown.value = false;
  selectedLocationCity.value = null;
  selectedLocationRegion.value = null;
  selectedLocationCountry.value = null;
  filterVersion.value++;
}
