import { useState, useEffect } from 'preact/hooks';
import { api } from '../api/client';
import type { SmartTag } from '../api/client';
import { selectedSmartTag, filterVersion } from '../state/filters';

export function SmartTagFilter() {
  const [tags, setTags] = useState<SmartTag[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.smartTags.list().then((res) => {
      setTags(res.smartTags);
    }).catch((err) => {
      console.error('Failed to load smart tags:', err);
    }).finally(() => {
      setLoading(false);
    });
  }, []);

  if (loading || tags.length === 0) return null;

  const handleChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value;
    selectedSmartTag.value = value || null;
    filterVersion.value++;
  };

  return (
    <div class="filter-section">
      <h3>Smart Tag</h3>
      <select
        class="smart-tag-filter-select"
        value={selectedSmartTag.value ?? ''}
        onChange={handleChange}
      >
        <option value="">All photos</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label} ({t.photoCount})
          </option>
        ))}
      </select>
    </div>
  );
}
