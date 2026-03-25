import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api/client';
import type { ReprocessStatsResponse, PipelineStats, PathFacetEntry } from '../api/client';
import { SettingsSidebar } from './SettingsSidebar';
import type { RoutableProps } from 'preact-router';

/* =========================================================================
   Path tree helpers (shared pattern from SmartTagsSettingsPage)
   ========================================================================= */

interface PathLevel3 {
  level3: string;
  count: number;
  value: string;
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
   Formatting helpers
   ========================================================================= */

function formatTime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  if (mins < 60) return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
}

function formatCost(dollars: number): string {
  if (dollars < 0.01) return `< $0.01`;
  return `$${dollars.toFixed(2)}`;
}

/** Sort version keys: "null" first, then semver ascending. */
function sortVersionKeys(keys: string[]): string[] {
  return keys.sort((a, b) => {
    if (a === 'null') return -1;
    if (b === 'null') return 1;
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const va = pa[i] ?? 0;
      const vb = pb[i] ?? 0;
      if (va !== vb) return va - vb;
    }
    return 0;
  });
}

/* =========================================================================
   Pipeline card sub-component
   ========================================================================= */

interface PipelineCardProps {
  title: string;
  pipeline: PipelineStats;
  secsPerPhoto: number;
  costPerHour: number;
}

function PipelineCard({ title, pipeline, secsPerPhoto, costPerHour }: PipelineCardProps) {
  const versionKeys = sortVersionKeys(Object.keys(pipeline.versions));
  const latestCount = pipeline.versions[pipeline.latestVersion] ?? 0;

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">{title}</h2>
      <div class="settings-card">
        {/* Summary row */}
        <div class="reprocess-summary-row">
          <div class="reprocess-stat">
            <span class="reprocess-stat-value reprocess-stat-value--ok">{latestCount}</span>
            <span class="reprocess-stat-label">at latest ({pipeline.latestVersion})</span>
          </div>
          <div class="reprocess-stat">
            <span class={`reprocess-stat-value ${pipeline.outdated > 0 ? 'reprocess-stat-value--warn' : 'reprocess-stat-value--ok'}`}>
              {pipeline.outdated}
            </span>
            <span class="reprocess-stat-label">outdated / missing</span>
          </div>
        </div>

        {/* Version table */}
        <table class="reprocess-version-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Description</th>
              <th>Photos</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {versionKeys.map((version) => {
              const count = pipeline.versions[version];
              const isNull = version === 'null';
              const isLatest = version === pipeline.latestVersion;
              const description = isNull
                ? 'Not yet processed'
                : pipeline.changelog[version] ?? '-';
              const badge = isNull
                ? 'missing'
                : isLatest
                  ? 'latest'
                  : 'outdated';

              return (
                <tr key={version}>
                  <td class="reprocess-version-cell">
                    {isNull ? <em>None</em> : <code>{version}</code>}
                  </td>
                  <td class="reprocess-desc-cell" title={description}>
                    {description.length > 80 ? description.substring(0, 77) + '...' : description}
                  </td>
                  <td class="reprocess-count-cell">{count}</td>
                  <td>
                    <span class={`reprocess-badge reprocess-badge--${badge}`}>
                      {badge}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Cost/time estimate */}
        {pipeline.outdated > 0 && (
          <div class="reprocess-estimate">
            <span class="reprocess-estimate-time">
              ~{formatTime(Math.ceil(pipeline.outdated * secsPerPhoto))}
            </span>
            {costPerHour > 0 && (
              <span class="reprocess-estimate-cost">
                ~{formatCost((pipeline.outdated * secsPerPhoto / 3600) * costPerHour)}
              </span>
            )}
            <span class="reprocess-estimate-detail">
              ({pipeline.outdated} photos x {secsPerPhoto}s/photo)
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================================================================
   Main component
   ========================================================================= */

export function ReprocessPage(_props: RoutableProps) {
  const [stats, setStats] = useState<ReprocessStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Path filter state
  const [pathPrefix, setPathPrefix] = useState<string | undefined>(undefined);
  const [pathTree, setPathTree] = useState<PathTree[]>([]);
  const [expandedL1, setExpandedL1] = useState<Set<string>>(new Set());
  const [expandedL2, setExpandedL2] = useState<Set<string>>(new Set());
  const [pathLoading, setPathLoading] = useState(true);

  // Load path facets + bucket name on mount
  useEffect(() => {
    async function loadPathData() {
      setPathLoading(true);
      try {
        const [facetsRes, s3Config] = await Promise.all([
          api.smartTags.facets('s3_path'),
          api.settings.getS3Config(),
        ]);
        const bucketName = s3Config.s3_bucket?.effectiveValue ?? '';
        if (facetsRes.type === 'path') {
          setPathTree(buildPathTree(facetsRes.facets, bucketName));
        }
      } catch (err) {
        console.error('Failed to load path facets:', err);
      } finally {
        setPathLoading(false);
      }
    }
    loadPathData();
  }, []);

  // Load stats (re-fetches when pathPrefix changes)
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.reprocess.getStats(pathPrefix);
      setStats(data);
    } catch (err) {
      console.error('Failed to load reprocess stats:', err);
    } finally {
      setLoading(false);
    }
  }, [pathPrefix]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Handle reprocess trigger
  const handleTrigger = async (mode: string, force = false) => {
    if (force) {
      const confirmed = window.confirm(
        `This will force-reprocess ALL ${stats?.totalPhotos ?? 0} photos. This may take a long time and incur significant cost. Continue?`
      );
      if (!confirmed) return;
    }

    setTriggering(mode);
    setStatus(null);
    try {
      const options: { mode?: string; force?: boolean; pathPrefix?: string } = {};
      if (mode !== 'all') options.mode = mode;
      if (force) options.force = true;
      if (pathPrefix) options.pathPrefix = pathPrefix;

      const result = await api.reprocess.trigger(options);
      const total = result.reprocessed + result.failed;
      setStatus({
        type: result.failed > 0 ? 'error' : 'success',
        message: `Reprocess completed: ${result.reprocessed} succeeded, ${result.failed} failed out of ${total} photos (${result.elapsedSeconds.toFixed(1)}s).`,
      });
      // Refresh stats after reprocess
      await refresh();
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Reprocess failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setTriggering(null);
    }
  };

  // Handle path selection (single-select)
  const selectPath = (value: string | undefined) => {
    setPathPrefix(value);
    setStatus(null);
  };

  // Display-friendly prefix label
  const pathLabel = pathPrefix
    ? pathPrefix.replace(/^s3:\/\/[^/]+\//, '').replace(/\/$/, '')
    : 'All photos';

  return (
    <div class="app-content">
      <SettingsSidebar activePath="/settings/reprocess" />

      <main class="main-content">
        {loading ? (
          <div class="loading">Loading reprocess stats...</div>
        ) : !stats ? (
          <div class="loading">Failed to load stats</div>
        ) : (
          <div class="reprocess-layout">
            {/* ── Left column: actions + path filter ── */}
            <div class="reprocess-left-col">
              {/* Header */}
              <div class="reprocess-header">
                <h2 class="reprocess-header-title">
                  {stats.totalPhotos.toLocaleString()} photos
                  {pathPrefix && (
                    <span class="reprocess-header-path"> in {pathLabel}</span>
                  )}
                </h2>
                <div class="reprocess-header-provider">
                  {stats.estimates.gpuEnabled
                    ? `GPU: ${stats.estimates.provider} (~${stats.estimates.secsPerPhoto}s/photo)`
                    : `Local CPU (~${stats.estimates.secsPerPhoto}s/photo)`}
                  {stats.estimates.costPerHour > 0 && ` @ $${stats.estimates.costPerHour}/hr`}
                </div>
              </div>

              {/* Reprocess Options */}
              <div class="settings-section">
                <h2 class="settings-section-title">Reprocess Options</h2>
                <div class="settings-card">
                  <div class="reprocess-actions">
                    <button
                      class="btn btn-primary"
                      disabled={stats.caption.outdated === 0 || triggering !== null}
                      onClick={() => handleTrigger('caption')}
                    >
                      {triggering === 'caption'
                        ? 'Reprocessing...'
                        : `Reprocess outdated captions (${stats.caption.outdated})`}
                    </button>

                    <button
                      class="btn btn-primary"
                      disabled={stats.faces.outdated === 0 || triggering !== null}
                      onClick={() => handleTrigger('faces')}
                    >
                      {triggering === 'faces'
                        ? 'Reprocessing...'
                        : `Reprocess outdated faces (${stats.faces.outdated})`}
                    </button>

                    <button
                      class="btn btn-primary"
                      disabled={(stats.process.outdated === 0 && stats.caption.outdated === 0 && stats.faces.outdated === 0) || triggering !== null}
                      onClick={() => handleTrigger('all')}
                    >
                      {triggering === 'all'
                        ? 'Reprocessing...'
                        : 'Reprocess all outdated'}
                    </button>

                    <hr class="reprocess-divider" />

                    <button
                      class="btn btn-danger"
                      disabled={stats.totalPhotos === 0 || triggering !== null}
                      onClick={() => handleTrigger('all', true)}
                    >
                      {triggering === 'all-force'
                        ? 'Reprocessing...'
                        : `Force reprocess everything (${stats.totalPhotos})`}
                    </button>
                  </div>

                  {!stats.estimates.costPerHour && (
                    <p class="reprocess-hint">
                      Set <code>GPU_COST_PER_HOUR</code> env var for cost estimates.
                    </p>
                  )}
                </div>
              </div>

              {/* Status banner */}
              {status && (
                <div class={`settings-status settings-status--${status.type}`}>
                  {status.message}
                  {' '}
                  <a href="/settings/gpu-logs" class="reprocess-logs-link">View GPU Logs</a>
                </div>
              )}

              {/* Path Filter */}
              <div class="settings-section">
                <h2 class="settings-section-title">Path Filter</h2>
                <div class="settings-card">
                  <div class="reprocess-path-filter">
                    <label class="reprocess-path-option">
                      <input
                        type="radio"
                        name="pathFilter"
                        checked={!pathPrefix}
                        onChange={() => selectPath(undefined)}
                      />
                      <span>All photos</span>
                    </label>

                    {pathLoading ? (
                      <div class="reprocess-path-loading">Loading folders...</div>
                    ) : pathTree.length === 0 ? (
                      <div class="reprocess-path-loading">No photos found</div>
                    ) : (
                      <div class="path-tree reprocess-path-tree">
                        {pathTree.map((node) => (
                          <div key={node.level1} class="path-tree-node">
                            <div class="path-tree-level1">
                              {node.children.length > 0 && (
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
                              )}
                              {node.children.length === 0 && <span class="path-tree-toggle-spacer" />}
                              <label class="path-tree-label">
                                <input
                                  type="radio"
                                  name="pathFilter"
                                  checked={pathPrefix === node.value}
                                  onChange={() => selectPath(node.value)}
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
                                            type="radio"
                                            name="pathFilter"
                                            checked={pathPrefix === l2.value}
                                            onChange={() => selectPath(l2.value)}
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
                                                type="radio"
                                                name="pathFilter"
                                                checked={pathPrefix === l3.value}
                                                onChange={() => selectPath(l3.value)}
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
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Right column: pipeline version summaries ── */}
            <div class="reprocess-right-col">
              <PipelineCard
                title="Processing (EXIF, placeholder, dimensions)"
                pipeline={stats.process}
                secsPerPhoto={stats.estimates.secsPerPhoto}
                costPerHour={stats.estimates.costPerHour}
              />

              <PipelineCard
                title="Captioning (AI description)"
                pipeline={stats.caption}
                secsPerPhoto={stats.estimates.secsPerPhoto}
                costPerHour={stats.estimates.costPerHour}
              />

              <PipelineCard
                title="Face Detection (embeddings)"
                pipeline={stats.faces}
                secsPerPhoto={stats.estimates.secsPerPhoto}
                costPerHour={stats.estimates.costPerHour}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
