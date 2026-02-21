import { signal, computed } from '@preact/signals';

export const searchQuery = signal('');
export const selectedTag = signal<string | null>(null);
export const selectedPerson = signal<string | null>(null);
export const dateFrom = signal<string | null>(null);
export const dateTo = signal<string | null>(null);
export const currentPage = signal(1);
export const photoSize = signal(200);

export const filters = computed(() => ({
  search: searchQuery.value || undefined,
  tag: selectedTag.value || undefined,
  person: selectedPerson.value || undefined,
  from: dateFrom.value || undefined,
  to: dateTo.value || undefined,
  page: currentPage.value,
}));

export function resetFilters() {
  searchQuery.value = '';
  selectedTag.value = null;
  selectedPerson.value = null;
  dateFrom.value = null;
  dateTo.value = null;
  currentPage.value = 1;
}

export function setPage(page: number) {
  currentPage.value = page;
}
