import { dateFrom, dateTo, dateUnknown, filterVersion } from '../state/filters';

export function DateFilter() {
  return (
    <div class="filter-section">
      <h3>Date Range</h3>
      <div class="date-inputs">
        <input
          type="date"
          value={dateFrom.value || ''}
          disabled={dateUnknown.value}
          onInput={(e) => {
            dateFrom.value = (e.target as HTMLInputElement).value || null;
            filterVersion.value++;
          }}
        />
        <span>to</span>
        <input
          type="date"
          value={dateTo.value || ''}
          disabled={dateUnknown.value}
          onInput={(e) => {
            dateTo.value = (e.target as HTMLInputElement).value || null;
            filterVersion.value++;
          }}
        />
      </div>
      <label class="unknown-date-filter">
        <input
          type="checkbox"
          checked={dateUnknown.value}
          onChange={(e) => {
            const checked = (e.target as HTMLInputElement).checked;
            dateUnknown.value = checked;
            if (checked) {
              dateFrom.value = null;
              dateTo.value = null;
            }
            filterVersion.value++;
          }}
        />
        Unknown date only
      </label>
    </div>
  );
}
