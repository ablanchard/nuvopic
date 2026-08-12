import { useState } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { api } from '../api/client';
import type { LocationFacet } from '../api/client';
import {
  filters,
  filterVersion,
  selectedLocationCity,
  selectedLocationCountry,
  selectedLocationRegion,
} from '../state/filters';

function isSelected(facet: LocationFacet): boolean {
  return selectedLocationCity.value === facet.city &&
    selectedLocationRegion.value === facet.region &&
    selectedLocationCountry.value === facet.country;
}

export function LocationFilter() {
  const [facets, setFacets] = useState<LocationFacet[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useSignalEffect(() => {
    const current = filters.value;
    void filterVersion.value;
    let cancelled = false;
    setLoading(true);

    api.photos.locationFacets({
      search: current.search,
      tag: current.tag,
      person: current.person,
      smartTag: current.smartTag,
      from: current.from,
      to: current.to,
      dateUnknown: current.dateUnknown,
    }).then((response) => {
      if (!cancelled) {
        setFacets(response.facets.sort((a, b) =>
          b.count - a.count || a.city.localeCompare(b.city)));
      }
    }).catch(() => {
      if (!cancelled) setFacets([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  });

  if (loading) {
    return <div class="filter-section">Loading cities...</div>;
  }

  if (facets.length === 0) return null;

  return (
    <details
      class="filter-section facet-filter"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary class="facet-filter-summary">Cities</summary>
      <div class="person-list">
        {facets.map((facet) => {
          const active = isSelected(facet);
          const key = `${facet.country}\u0000${facet.region ?? ''}\u0000${facet.city}`;

          return (
            <button
              key={key}
              class={`person-item ${active ? 'active' : ''}`}
              title={[facet.city, facet.region, facet.country].filter(Boolean).join(', ')}
              onClick={() => {
                selectedLocationCity.value = active ? null : facet.city;
                selectedLocationRegion.value = active ? null : facet.region;
                selectedLocationCountry.value = active ? null : facet.country;
                filterVersion.value++;
              }}
            >
              <span class="person-name">{facet.city}</span>
              <span class="person-count">{facet.count}</span>
            </button>
          );
        })}
      </div>
    </details>
  );
}
