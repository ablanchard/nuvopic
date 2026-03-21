import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api/client';
import type { PhotoSource, PathBreakdownEntry } from '../api/client';
import type { RoutableProps } from 'preact-router';

interface PathLevel3 {
  level3: string;
  count: number;
  prefix: string;
}

interface PathLevel2 {
  level2: string;
  totalCount: number;
  children: PathLevel3[];
  prefix: string;
}

interface PathTree {
  level1: string;
  totalCount: number;
  children: PathLevel2[];
  prefix: string;
}

/** Build a hierarchical tree from flat breakdown entries. */
function buildPathTree(breakdown: PathBreakdownEntry[], bucket: string): PathTree[] {
  const l1Map = new Map<string, PathTree>();

  for (const entry of breakdown) {
    // Get or create level 1 node
    let l1 = l1Map.get(entry.level1);
    if (!l1) {
      l1 = {
        level1: entry.level1,
        totalCount: 0,
        children: [],
        prefix: `s3://${bucket}/${entry.level1}/`,
      };
      l1Map.set(entry.level1, l1);
    }

    if (!entry.level2) {
      // Entry is level-1 only (no level2 or level3)
      l1.totalCount += entry.count;
      continue;
    }

    // Find or create level 2 child
    let l2 = l1.children.find((c) => c.level2 === entry.level2);
    if (!l2) {
      l2 = {
        level2: entry.level2,
        totalCount: 0,
        children: [],
        prefix: `s3://${bucket}/${entry.level1}/${entry.level2}/`,
      };
      l1.children.push(l2);
    }

    if (!entry.level3) {
      // Entry is level-1 + level-2 only
      l2.totalCount += entry.count;
      l1.totalCount += entry.count;
      continue;
    }

    // Level 3 entry
    l2.children.push({
      level3: entry.level3,
      count: entry.count,
      prefix: `s3://${bucket}/${entry.level1}/${entry.level2}/${entry.level3}/`,
    });
    l2.totalCount += entry.count;
    l1.totalCount += entry.count;
  }

  // Sort children by count desc at each level
  for (const l1 of l1Map.values()) {
    for (const l2 of l1.children) {
      l2.children.sort((a, b) => b.count - a.count);
    }
    l1.children.sort((a, b) => b.totalCount - a.totalCount);
  }

  return Array.from(l1Map.values()).sort((a, b) => b.totalCount - a.totalCount);
}

export function SourcesSettingsPage(_props: RoutableProps) {
  const [sources, setSources] = useState<PhotoSource[]>([]);
  const [breakdown, setBreakdown] = useState<PathTree[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedLevel1, setExpandedLevel1] = useState<Set<string>>(new Set());
  const [expandedLevel2, setExpandedLevel2] = useState<Set<string>>(new Set());
  const [selectedPrefixes, setSelectedPrefixes] = useState<Set<string>>(new Set());
  const [newLabel, setNewLabel] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editPrefixes, setEditPrefixes] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [sourcesRes, breakdownRes, settingsRes] = await Promise.all([
        api.sources.list(),
        api.sources.pathBreakdown(),
        api.settings.get(),
      ]);
      setSources(sourcesRes.sources);

      // Try to get bucket from settings
      const b = settingsRes['s3_bucket'] || 'nextcloud-prod-ablanchard';

      setBreakdown(buildPathTree(breakdownRes.breakdown, b));
    } catch (err) {
      console.error('Failed to load sources config:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleLevel1 = (level1: string) => {
    setExpandedLevel1((prev) => {
      const next = new Set(prev);
      if (next.has(level1)) next.delete(level1);
      else next.add(level1);
      return next;
    });
  };

  const toggleLevel2 = (key: string) => {
    setExpandedLevel2((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const togglePrefix = (prefix: string, target: 'new' | 'edit') => {
    const setter = target === 'new' ? setSelectedPrefixes : setEditPrefixes;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!newLabel.trim() || selectedPrefixes.size === 0) return;
    setStatus(null);
    try {
      await api.sources.create({
        label: newLabel.trim(),
        pathPrefixes: Array.from(selectedPrefixes),
      });
      setNewLabel('');
      setSelectedPrefixes(new Set());
      setStatus({ type: 'success', message: `Source "${newLabel.trim()}" created` });
      await refresh();
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to create source',
      });
    }
  };

  const handleDelete = async (id: string, label: string) => {
    setStatus(null);
    try {
      await api.sources.delete(id);
      setStatus({ type: 'success', message: `Source "${label}" deleted` });
      await refresh();
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to delete source',
      });
    }
  };

  const startEdit = (source: PhotoSource) => {
    setEditingId(source.id);
    setEditLabel(source.label);
    setEditPrefixes(new Set(source.pathPrefixes));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditLabel('');
    setEditPrefixes(new Set());
  };

  const handleUpdate = async () => {
    if (!editingId || !editLabel.trim() || editPrefixes.size === 0) return;
    setStatus(null);
    try {
      await api.sources.update(editingId, {
        label: editLabel.trim(),
        pathPrefixes: Array.from(editPrefixes),
      });
      setStatus({ type: 'success', message: `Source "${editLabel.trim()}" updated` });
      cancelEdit();
      await refresh();
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to update source',
      });
    }
  };

  const renderPrefixTree = (target: 'new' | 'edit') => {
    const selected = target === 'new' ? selectedPrefixes : editPrefixes;

    return (
      <div class="path-tree">
        {breakdown.map((node) => (
          <div key={node.level1} class="path-tree-node">
            <div class="path-tree-level1">
              <button
                class="path-tree-toggle"
                onClick={() => toggleLevel1(node.level1)}
              >
                <span class={`path-tree-caret ${expandedLevel1.has(node.level1) ? 'path-tree-caret--open' : ''}`}>
                  &#9654;
                </span>
              </button>
              <label class="path-tree-label">
                <input
                  type="checkbox"
                  checked={selected.has(node.prefix)}
                  onChange={() => togglePrefix(node.prefix, target)}
                />
                <span class="path-tree-name">{node.level1}/</span>
                <span class="path-tree-count">{node.totalCount}</span>
              </label>
            </div>
            {expandedLevel1.has(node.level1) && node.children.length > 0 && (
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
                            onClick={() => toggleLevel2(l2Key)}
                          >
                            <span class={`path-tree-caret ${expandedLevel2.has(l2Key) ? 'path-tree-caret--open' : ''}`}>
                              &#9654;
                            </span>
                          </button>
                        ) : (
                          <span class="path-tree-toggle-spacer" />
                        )}
                        <label class="path-tree-label">
                          <input
                            type="checkbox"
                            checked={selected.has(l2.prefix)}
                            onChange={() => togglePrefix(l2.prefix, target)}
                          />
                          <span class="path-tree-name">{l2.level2}/</span>
                          <span class="path-tree-count">{l2.totalCount}</span>
                        </label>
                      </div>
                      {hasL3 && expandedLevel2.has(l2Key) && (
                        <div class="path-tree-children">
                          {l2.children.map((l3) => (
                            <label key={l3.level3} class="path-tree-label path-tree-level3">
                              <input
                                type="checkbox"
                                checked={selected.has(l3.prefix)}
                                onChange={() => togglePrefix(l3.prefix, target)}
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

  return (
    <div class="app-content">
      <aside class="sidebar">
        <h3 class="sidebar-heading">Settings</h3>
        <nav class="settings-nav">
          <a href="/settings" class="settings-nav-link">General</a>
          <a href="/settings/gpu-logs" class="settings-nav-link">GPU Logs</a>
          <a href="/settings/sources" class="settings-nav-link settings-nav-link--active">Sources</a>
        </nav>
      </aside>

      <main class="main-content">
        {loading ? (
          <div class="loading">Loading sources...</div>
        ) : (
          <div class="settings-container">
            {/* Existing sources */}
            <div class="settings-section">
              <h2 class="settings-section-title">Photo Sources</h2>
              {sources.length === 0 ? (
                <p class="sources-empty">
                  No sources defined yet. Create one below by selecting path prefixes and assigning a label.
                </p>
              ) : (
                <div class="sources-list">
                  {sources.map((source) => (
                    <div key={source.id} class="source-card settings-card">
                      {editingId === source.id ? (
                        <>
                          <div class="source-card-header">
                            <input
                              type="text"
                              class="setting-text-input"
                              value={editLabel}
                              onInput={(e) => setEditLabel((e.target as HTMLInputElement).value)}
                              placeholder="Source label"
                            />
                          </div>
                          <div class="source-card-prefixes">
                            <p class="source-prefix-heading">Select path prefixes:</p>
                            {renderPrefixTree('edit')}
                          </div>
                          <div class="source-card-actions">
                            <button
                              class="btn btn-primary"
                              onClick={handleUpdate}
                              disabled={!editLabel.trim() || editPrefixes.size === 0}
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
                          <div class="source-card-header">
                            <span class="source-label">{source.label}</span>
                            <span class="source-photo-count">{source.photoCount} photos</span>
                          </div>
                          <div class="source-card-prefixes">
                            {source.pathPrefixes.map((p) => (
                              <code key={p} class="source-prefix">{p}</code>
                            ))}
                          </div>
                          <div class="source-card-actions">
                            <button class="btn btn-small" onClick={() => startEdit(source)}>
                              Edit
                            </button>
                            <button
                              class="btn btn-small source-delete-btn"
                              onClick={() => handleDelete(source.id, source.label)}
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

            {/* Create new source */}
            <div class="settings-section">
              <h2 class="settings-section-title">Create New Source</h2>
              <div class="settings-card">
                <div class="setting-row" style="flex-direction: column; gap: 1rem;">
                  <div style="width: 100%;">
                    <label class="setting-label">Label</label>
                    <input
                      type="text"
                      class="setting-text-input"
                      value={newLabel}
                      onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
                      placeholder="e.g. Camera, WhatsApp, Signal"
                      style="max-width: 300px;"
                    />
                  </div>
                  <div style="width: 100%;">
                    <label class="setting-label">Path Prefixes</label>
                    <p class="setting-description" style="margin-bottom: 0.75rem;">
                      Select one or more path prefixes to include in this source.
                    </p>
                    {renderPrefixTree('new')}
                  </div>
                  {selectedPrefixes.size > 0 && (
                    <div class="source-selected-summary">
                      Selected: {Array.from(selectedPrefixes).map((p) => (
                        <code key={p} class="source-prefix">{p}</code>
                      ))}
                    </div>
                  )}
                </div>
                <div class="settings-actions">
                  <button
                    class="btn btn-primary"
                    onClick={handleCreate}
                    disabled={!newLabel.trim() || selectedPrefixes.size === 0}
                  >
                    Create Source
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
