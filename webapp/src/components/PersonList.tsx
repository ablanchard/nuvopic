import { useEffect, useState } from 'preact/hooks';
import { api } from '../api/client';
import type { Person } from '../api/client';
import { selectedPerson, filterVersion } from '../state/filters';

export function PersonList() {
  const [persons, setPersons] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.persons.list()
      .then((data) => setPersons(data.persons))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div class="filter-section">Loading persons...</div>;
  }

  if (persons.length === 0) {
    return null;
  }

  return (
    <div class="filter-section">
      <h3>People</h3>
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
    </div>
  );
}
