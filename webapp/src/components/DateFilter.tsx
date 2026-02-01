import { dateFrom, dateTo, currentPage } from '../state/filters';

export function DateFilter() {
  return (
    <div class="filter-section">
      <h3>Date Range</h3>
      <div class="date-inputs">
        <input
          type="date"
          value={dateFrom.value || ''}
          onInput={(e) => {
            dateFrom.value = (e.target as HTMLInputElement).value || null;
            currentPage.value = 1;
          }}
        />
        <span>to</span>
        <input
          type="date"
          value={dateTo.value || ''}
          onInput={(e) => {
            dateTo.value = (e.target as HTMLInputElement).value || null;
            currentPage.value = 1;
          }}
        />
      </div>
    </div>
  );
}
