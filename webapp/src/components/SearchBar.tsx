import { useEffect, useState } from 'preact/hooks';
import { searchQuery, filterVersion } from '../state/filters';

export function SearchBar() {
  const [value, setValue] = useState(searchQuery.value);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (value !== searchQuery.value) {
        searchQuery.value = value;
        filterVersion.value++;
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [value]);

  return (
    <div class="search-bar">
      <input
        type="text"
        placeholder="Search photos..."
        value={value}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
      />
    </div>
  );
}
