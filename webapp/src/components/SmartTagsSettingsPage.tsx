import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api/client';
import type {
  SmartTag,
  PathFacetEntry,
  DateFacetEntry,
  TextFacetEntry,
  FacetsResponse,
} from '../api/client';
import { SettingsSidebar } from './SettingsSidebar';
import type { RoutableProps } from 'preact-router';

/* =========================================================================
   Path facet tree helpers (3-level hierarchy)
   ========================================================================= */

interface PathLevel3 {
  level3: string;
  count: number;
  value: string; // the prefix to use as a smart-tag value
}

interface PathLevel2 {
  level2: string;
  totalCount: number;
  children: PathLevel3[];
  value: string;
}

interface PathTree {
  level1: string;
  totalCount: number;
  children: PathLevel2[];
  value: string;
}

function buildPathTree(facets: PathFacetEntry[], bucket: string): PathTree[] {
  const l1Map = new Map<string, PathTree>();

  for (const entry of facets) {
    let l1 = l1Map.get(entry.level1);
    if (!l1) {
      l1 = {
        level1: entry.level1,
        totalCount: 0,
        children: [],
        value: `s3://${bucket}/${entry.level1}/`,
      };
      l1Map.set(entry.level1, l1);
    }

    if (!entry.level2) {
      l1.totalCount += entry.count;
      continue;
    }

    let l2 = l1.children.find((c) => c.level2 === entry.level2);
    if (!l2) {
      l2 = {
        level2: entry.level2,
        totalCount: 0,
        children: [],
        value: `s3://${bucket}/${entry.level1}/${entry.level2}/`,
      };
      l1.children.push(l2);
    }

    if (!entry.level3) {
      l2.totalCount += entry.count;
      l1.totalCount += entry.count;
      continue;
    }

    l2.children.push({
      level3: entry.level3,
      count: entry.count,
      value: `s3://${bucket}/${entry.level1}/${entry.level2}/${entry.level3}/`,
    });
    l2.totalCount += entry.count;
    l1.totalCount += entry.count;
  }

  for (const l1 of l1Map.values()) {
    for (const l2 of l1.children) {
      l2.children.sort((a, b) => b.count - a.count);
    }
    l1.children.sort((a, b) => b.totalCount - a.totalCount);
  }

  return Array.from(l1Map.values()).sort((a, b) => b.totalCount - a.totalCount);
}

/* =========================================================================
   Date facet tree helpers (year > month)
   ========================================================================= */

interface DateYear {
  year: number;
  totalCount: number;
  months: { month: number; count: number; value: string }[];
  value: string;
}

function buildDateTree(facets: DateFacetEntry[]): DateYear[] {
  const yearMap = new Map<number, DateYear>();

  for (const entry of facets) {
    let y = yearMap.get(entry.year);
    if (!y) {
      y = {
        year: entry.year,
        totalCount: 0,
        months: [],
        value: String(entry.year),
      };
      yearMap.set(entry.year, y);
    }
    if (entry.month !== null) {
      const monthStr = `${entry.year}-${String(entry.month).padStart(2, '0')}`;
      y.months.push({ month: entry.month, count: entry.count, value: monthStr });
      y.totalCount += entry.count;
    } else {
      y.totalCount += entry.count;
    }
  }

  for (const y of yearMap.values()) {
    y.months.sort((a, b) => a.month - b.month);
  }

  return Array.from(yearMap.values()).sort((a, b) => b.year - a.year);
}

const MONTH_NAMES = [
  '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/* =========================================================================
   Component
   ========================================================================= */

export function SmartTagsSettingsPage(_props: RoutableProps) {
  // Smart tag list
  const [smartTags, setSmartTags] = useState<SmartTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Create form state
  const [newLabel, setNewLabel] = useState('');
  const [newField, setNewField] = useState('s3_path');
  const [newRule, setNewRule] = useState('any');
  const [newValues, setNewValues] = useState<Set<string>>(new Set());
  const [availableFields, setAvailableFields] = useState<string[]>([]);

  // Facets state
  const [facets, setFacets] = useState<FacetsResponse | null>(null);
  const [facetsLoading, setFacetsLoading] = useState(false);

  // Path tree expand state
  const [expandedL1, setExpandedL1] = useState<Set<string>>(new Set());
  const [expandedL2, setExpandedL2] = useState<Set<string>>(new Set());
  // Date tree expand state
  const [expandedYears, setExpandedYears] = useState<Set<number>>(new Set());

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editField, setEditField] = useState('s3_path');
  const [editRule, setEditRule] = useState('any');
  const [editValues, setEditValues] = useState<Set<string>>(new Set());
  const [editFacets, setEditFacets] = useState<FacetsResponse | null>(null);
  const [editFacetsLoading, setEditFacetsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [tagsRes, fieldsRes] = await Promise.all([
        api.smartTags.list(),
        api.smartTags.fields(),
      ]);
      setSmartTags(tagsRes.smartTags);
      setAvailableFields(fieldsRes.fields);
    } catch (err) {
      console.error('Failed to load smart tags:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Load facets when newField changes
  useEffect(() => {
    setFacetsLoading(true);
    setFacets(null);
    setNewValues(new Set());
    api.smartTags.facets(newField).then((res) => {
      setFacets(res);
    }).catch((err) => {
      console.error('Failed to load facets:', err);
    }).finally(() => {
      setFacetsLoading(false);
    });
  }, [newField]);

  // Load facets when editing field changes
  const loadEditFacets = useCallback((field: string) => {
    setEditFacetsLoading(true);
    setEditFacets(null);
    api.smartTags.facets(field).then((res) => {
      setEditFacets(res);
    }).catch((err) => {
      console.error('Failed to load facets:', err);
    }).finally(() => {
      setEditFacetsLoading(false);
    });
  }, []);

  const toggleValue = (value: string, target: 'new' | 'edit') => {
    const setter = target === 'new' ? setNewValues : setEditValues;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  // Create
  const handleCreate = async () => {
    if (!newLabel.trim() || newValues.size === 0) return;
    setStatus(null);
    try {
      await api.smartTags.create({
        label: newLabel.trim(),
        field: newField,
        values: Array.from(newValues),
        rule: newRule,
      });
      setNewLabel('');
      setNewValues(new Set());
      setStatus({ type: 'success', message: `Smart tag "${newLabel.trim()}" created` });
      await refresh();
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to create smart tag',
      });
    }
  };

  // Delete
  const handleDelete = async (id: string, label: string) => {
    setStatus(null);
    try {
      await api.smartTags.delete(id);
      setStatus({ type: 'success', message: `Smart tag "${label}" deleted` });
      await refresh();
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to delete smart tag',
      });
    }
  };

  // Start editing
  const startEdit = (tag: SmartTag) => {
    setEditingId(tag.id);
    setEditLabel(tag.label);
    setEditField(tag.field);
    setEditRule(tag.rule);
    setEditValues(new Set(tag.values));
    loadEditFacets(tag.field);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditLabel('');
    setEditValues(new Set());
    setEditFacets(null);
  };

  // Save edit
  const handleUpdate = async () => {
    if (!editingId || !editLabel.trim() || editValues.size === 0) return;
    setStatus(null);
    try {
      await api.smartTags.update(editingId, {
        label: editLabel.trim(),
        field: editField,
        values: Array.from(editValues),
        rule: editRule,
      });
      setStatus({ type: 'success', message: `Smart tag "${editLabel.trim()}" updated` });
      cancelEdit();
      await refresh();
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to update smart tag',
      });
    }
  };

  /* -----------------------------------------------------------------------
     Facets renderers
     ----------------------------------------------------------------------- */

  const renderPathFacets = (
    facetsData: FacetsResponse | null,
    selected: Set<string>,
    target: 'new' | 'edit',
  ) => {
    if (!facetsData || facetsData.type !== 'path') return null;
    const tree = buildPathTree(facetsData.facets, 'nextcloud-prod-ablanchard');

    return (
      <div class="path-tree">
        {tree.map((node) => (
          <div key={node.level1} class="path-tree-node">
            <div class="path-tree-level1">
              <button
                class="path-tree-toggle"
                onClick={() => {
                  setExpandedL1((prev) => {
                    const next = new Set(prev);
                    if (next.has(node.level1)) next.delete(node.level1);
                    else next.add(node.level1);
                    return next;
                  });
                }}
              >
                <span class={`path-tree-caret ${expandedL1.has(node.level1) ? 'path-tree-caret--open' : ''}`}>
                  &#9654;
                </span>
              </button>
              <label class="path-tree-label">
                <input
                  type="checkbox"
                  checked={selected.has(node.value)}
                  onChange={() => toggleValue(node.value, target)}
                />
                <span class="path-tree-name">{node.level1}/</span>
                <span class="path-tree-count">{node.totalCount}</span>
              </label>
            </div>
            {expandedL1.has(node.level1) && node.children.length > 0 && (
              <div class="path-tree-children">
                {node.children.map((l2) => {
                  const l2Key = `${node.level1}/${l2.level2}`;
                  const hasL3 = l2.children.length > 0;

                  return (
                    <div key={l2.level2} class="path-tree-node path-tree-node--nested">
                      <div class="path-tree-level2">
                        {hasL3 ? (
                          <button
                            class="path-tree-toggle"
                            onClick={() => {
                              setExpandedL2((prev) => {
                                const next = new Set(prev);
                                if (next.has(l2Key)) next.delete(l2Key);
                                else next.add(l2Key);
                                return next;
                              });
                            }}
                          >
                            <span class={`path-tree-caret ${expandedL2.has(l2Key) ? 'path-tree-caret--open' : ''}`}>
                              &#9654;
                            </span>
                          </button>
                        ) : (
                          <span class="path-tree-toggle-spacer" />
                        )}
                        <label class="path-tree-label">
                          <input
                            type="checkbox"
                            checked={selected.has(l2.value)}
                            onChange={() => toggleValue(l2.value, target)}
                          />
                          <span class="path-tree-name">{l2.level2}/</span>
                          <span class="path-tree-count">{l2.totalCount}</span>
                        </label>
                      </div>
                      {hasL3 && expandedL2.has(l2Key) && (
                        <div class="path-tree-children">
                          {l2.children.map((l3) => (
                            <label key={l3.level3} class="path-tree-label path-tree-level3">
                              <input
                                type="checkbox"
                                checked={selected.has(l3.value)}
                                onChange={() => toggleValue(l3.value, target)}
                              />
                              <span class="path-tree-name">{l3.level3}/</span>
                              <span class="path-tree-count">{l3.count}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderDateFacets = (
    facetsData: FacetsResponse | null,
    selected: Set<string>,
    target: 'new' | 'edit',
  ) => {
    if (!facetsData || facetsData.type !== 'date') return null;
    const tree = buildDateTree(facetsData.facets);

    return (
      <div class="path-tree">
        {tree.map((yearNode) => (
          <div key={yearNode.year} class="path-tree-node">
            <div class="path-tree-level1">
              <button
                class="path-tree-toggle"
                onClick={() => {
                  setExpandedYears((prev) => {
                    const next = new Set(prev);
                    if (next.has(yearNode.year)) next.delete(yearNode.year);
                    else next.add(yearNode.year);
                    return next;
                  });
                }}
              >
                <span class={`path-tree-caret ${expandedYears.has(yearNode.year) ? 'path-tree-caret--open' : ''}`}>
                  &#9654;
                </span>
              </button>
              <label class="path-tree-label">
                <input
                  type="checkbox"
                  checked={selected.has(yearNode.value)}
                  onChange={() => toggleValue(yearNode.value, target)}
                />
                <span class="path-tree-name">{yearNode.year}</span>
                <span class="path-tree-count">{yearNode.totalCount}</span>
              </label>
            </div>
            {expandedYears.has(yearNode.year) && yearNode.months.length > 0 && (
              <div class="path-tree-children">
                {yearNode.months.map((m) => (
                  <label key={m.month} class="path-tree-label path-tree-level3">
                    <input
                      type="checkbox"
                      checked={selected.has(m.value)}
                      onChange={() => toggleValue(m.value, target)}
                    />
                    <span class="path-tree-name">{MONTH_NAMES[m.month]} {yearNode.year}</span>
                    <span class="path-tree-count">{m.count}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderTextFacets = (
    facetsData: FacetsResponse | null,
    selected: Set<string>,
    target: 'new' | 'edit',
  ) => {
    if (!facetsData || facetsData.type !== 'text') return null;

    return (
      <div class="smart-tag-text-facets">
        {facetsData.facets.map((entry: TextFacetEntry) => (
          <label key={entry.value} class="path-tree-label smart-tag-text-facet-item">
            <input
              type="checkbox"
              checked={selected.has(entry.value)}
              onChange={() => toggleValue(entry.value, target)}
            />
            <span class="path-tree-name">{entry.value}</span>
            <span class="path-tree-count">{entry.count}</span>
          </label>
        ))}
      </div>
    );
  };

  const renderFacets = (
    facetsData: FacetsResponse | null,
    isLoading: boolean,
    selected: Set<string>,
    target: 'new' | 'edit',
  ) => {
    if (isLoading) return <div class="smart-tag-facets-loading">Loading facets...</div>;
    if (!facetsData) return null;

    if (facetsData.type === 'path') return renderPathFacets(facetsData, selected, target);
    if (facetsData.type === 'date') return renderDateFacets(facetsData, selected, target);
    return renderTextFacets(facetsData, selected, target);
  };

  /* -----------------------------------------------------------------------
     Render
     ----------------------------------------------------------------------- */

  const fieldLabel = (f: string) => {
    const labels: Record<string, string> = {
      s3_path: 'File Path (s3_path)',
      taken_at: 'Date Taken (taken_at)',
      description: 'Description',
      location_name: 'Location Name',
    };
    return labels[f] || f;
  };

  const ruleLabel = (r: string) => {
    const labels: Record<string, string> = {
      any: 'Match ANY value',
      all: 'Match ALL values',
      none: 'Match NONE of the values',
    };
    return labels[r] || r;
  };

  return (
    <div class="app-content">
      <SettingsSidebar activePath="/settings/smart-tags" />

      <main class="main-content">
        {loading ? (
          <div class="loading">Loading smart tags...</div>
        ) : (
          <div class="settings-container">
            {/* Existing smart tags */}
            <div class="settings-section">
              <h2 class="settings-section-title">Smart Tags</h2>
              {smartTags.length === 0 ? (
                <p class="smart-tag-empty">
                  No smart tags defined yet. Create one below.
                </p>
              ) : (
                <div class="smart-tag-list">
                  {smartTags.map((tag) => (
                    <div key={tag.id} class="smart-tag-card settings-card">
                      {editingId === tag.id ? (
                        <>
                          <div class="smart-tag-card-header">
                            <input
                              type="text"
                              class="setting-text-input"
                              value={editLabel}
                              onInput={(e) => setEditLabel((e.target as HTMLInputElement).value)}
                              placeholder="Tag label"
                            />
                          </div>
                          <div class="smart-tag-form-row">
                            <div class="smart-tag-form-field">
                              <label class="setting-label">Field</label>
                              <select
                                class="smart-tag-select"
                                value={editField}
                                onChange={(e) => {
                                  const f = (e.target as HTMLSelectElement).value;
                                  setEditField(f);
                                  setEditValues(new Set());
                                  loadEditFacets(f);
                                }}
                              >
                                {availableFields.map((f) => (
                                  <option key={f} value={f}>{fieldLabel(f)}</option>
                                ))}
                              </select>
                            </div>
                            <div class="smart-tag-form-field">
                              <label class="setting-label">Rule</label>
                              <select
                                class="smart-tag-select"
                                value={editRule}
                                onChange={(e) => setEditRule((e.target as HTMLSelectElement).value)}
                              >
                                <option value="any">Match ANY</option>
                                <option value="all">Match ALL</option>
                                <option value="none">Match NONE</option>
                              </select>
                            </div>
                          </div>
                          <div class="smart-tag-facets-section">
                            <label class="setting-label">Values</label>
                            {renderFacets(editFacets, editFacetsLoading, editValues, 'edit')}
                          </div>
                          <div class="smart-tag-card-actions">
                            <button
                              class="btn btn-primary"
                              onClick={handleUpdate}
                              disabled={!editLabel.trim() || editValues.size === 0}
                            >
                              Save
                            </button>
                            <button class="btn btn-secondary" onClick={cancelEdit}>
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div class="smart-tag-card-header">
                            <span class="smart-tag-label">{tag.label}</span>
                            <span class="smart-tag-photo-count">{tag.photoCount} photos</span>
                          </div>
                          <div class="smart-tag-card-meta">
                            <span class="smart-tag-meta-item">
                              <strong>Field:</strong> {fieldLabel(tag.field)}
                            </span>
                            <span class="smart-tag-meta-item">
                              <strong>Rule:</strong> {ruleLabel(tag.rule)}
                            </span>
                          </div>
                          <div class="smart-tag-card-values">
                            {tag.values.map((v) => (
                              <code key={v} class="smart-tag-value">{v}</code>
                            ))}
                          </div>
                          <div class="smart-tag-card-actions">
                            <button class="btn btn-small" onClick={() => startEdit(tag)}>
                              Edit
                            </button>
                            <button
                              class="btn btn-small smart-tag-delete-btn"
                              onClick={() => handleDelete(tag.id, tag.label)}
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Create new smart tag */}
            <div class="settings-section">
              <h2 class="settings-section-title">Create New Smart Tag</h2>
              <div class="settings-card">
                <div class="setting-row" style="flex-direction: column; gap: 1rem;">
                  <div style="width: 100%;">
                    <label class="setting-label">Label</label>
                    <input
                      type="text"
                      class="setting-text-input"
                      value={newLabel}
                      onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
                      placeholder="e.g. Camera Photos, WhatsApp, 2024"
                      style="max-width: 300px;"
                    />
                  </div>

                  <div class="smart-tag-form-row">
                    <div class="smart-tag-form-field">
                      <label class="setting-label">Field</label>
                      <select
                        class="smart-tag-select"
                        value={newField}
                        onChange={(e) => setNewField((e.target as HTMLSelectElement).value)}
                      >
                        {availableFields.map((f) => (
                          <option key={f} value={f}>{fieldLabel(f)}</option>
                        ))}
                      </select>
                    </div>
                    <div class="smart-tag-form-field">
                      <label class="setting-label">Rule</label>
                      <select
                        class="smart-tag-select"
                        value={newRule}
                        onChange={(e) => setNewRule((e.target as HTMLSelectElement).value)}
                      >
                        <option value="any">Match ANY</option>
                        <option value="all">Match ALL</option>
                        <option value="none">Match NONE</option>
                      </select>
                    </div>
                  </div>

                  <div class="smart-tag-facets-section">
                    <label class="setting-label">Values</label>
                    <p class="setting-description" style="margin-bottom: 0.75rem;">
                      Select one or more values to match against the selected field.
                    </p>
                    {renderFacets(facets, facetsLoading, newValues, 'new')}
                  </div>

                  {newValues.size > 0 && (
                    <div class="smart-tag-selected-summary">
                      Selected: {Array.from(newValues).map((v) => (
                        <code key={v} class="smart-tag-value">{v}</code>
                      ))}
                    </div>
                  )}
                </div>
                <div class="settings-actions">
                  <button
                    class="btn btn-primary"
                    onClick={handleCreate}
                    disabled={!newLabel.trim() || newValues.size === 0}
                  >
                    Create Smart Tag
                  </button>
                </div>
              </div>
            </div>

            {status && (
              <div class={`settings-status settings-status--${status.type}`}>
                {status.message}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
