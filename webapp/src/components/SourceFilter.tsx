import { useState, useEffect } from 'preact/hooks';
import { api } from '../api/client';
import type { PhotoSource } from '../api/client';
import { selectedSource, filterVersion } from '../state/filters';

export function SourceFilter() {
  const [sources, setSources] = useState<PhotoSource[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.sources.list().then((res) => {
      setSources(res.sources);
    }).catch((err) => {
      console.error('Failed to load sources:', err);
    }).finally(() => {
      setLoading(false);
    });
  }, []);

  if (loading || sources.length === 0) return null;

  const handleChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value;
    selectedSource.value = value || null;
    filterVersion.value++;
  };

  return (
    <div class="filter-section">
      <h3>Source</h3>
      <select
        class="source-filter-select"
        value={selectedSource.value ?? ''}
        onChange={handleChange}
      >
        <option value="">All sources</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label} ({s.photoCount})
          </option>
        ))}
      </select>
    </div>
  );
}
