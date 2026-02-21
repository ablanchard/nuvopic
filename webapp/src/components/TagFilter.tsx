import { useEffect, useState } from 'preact/hooks';
import { api } from '../api/client';
import type { Tag } from '../api/client';
import { selectedTag, filterVersion } from '../state/filters';

export function TagFilter() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.tags.list()
      .then((data) => setTags(data.tags))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div class="filter-section">Loading tags...</div>;
  }

  if (tags.length === 0) {
    return null;
  }

  return (
    <div class="filter-section">
      <h3>Tags</h3>
      <div class="tag-chips">
        {tags.map((tag) => (
          <button
            key={tag.id}
            class={`tag-chip ${selectedTag.value === tag.id ? 'active' : ''}`}
            onClick={() => {
              selectedTag.value = selectedTag.value === tag.id ? null : tag.id;
              filterVersion.value++;
            }}
          >
            {tag.name}
          </button>
        ))}
      </div>
    </div>
  );
}
