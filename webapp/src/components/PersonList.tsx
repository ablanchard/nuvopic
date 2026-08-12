import { useEffect, useState } from 'preact/hooks';
import { api } from '../api/client';
import type { Person } from '../api/client';
import { selectedPerson, filterVersion } from '../state/filters';

export function PersonList() {
  const [persons, setPersons] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    api.persons.list()
      .then((data) => setPersons(
        data.persons.sort((a, b) =>
          b.faceCount - a.faceCount || a.name.localeCompare(b.name)),
      ))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div class="filter-section">Loading persons...</div>;
  }

  if (persons.length === 0) {
    return null;
  }

  return (
    <details
      class="filter-section facet-filter"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary class="facet-filter-summary">People</summary>
      <div class="person-list">
        {persons.map((person) => (
          <button
            key={person.id}
            class={`person-item ${selectedPerson.value === person.id ? 'active' : ''}`}
            onClick={() => {
              selectedPerson.value = selectedPerson.value === person.id ? null : person.id;
              filterVersion.value++;
            }}
          >
            <span class="person-name">{person.name}</span>
            <span class="person-count">{person.faceCount}</span>
          </button>
        ))}
      </div>
    </details>
  );
}
