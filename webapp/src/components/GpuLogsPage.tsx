import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api/client';
import type { GpuLog, GpuLogFilters } from '../api/client';
import type { RoutableProps } from 'preact-router';

/** Format a duration in ms to a human-readable string. */
function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.round(secs % 60);
  return `${mins}m ${remainSecs}s`;
}

/** Format a date string to a compact local representation. */
function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Status badge component. */
function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'completed'
      ? 'gpu-log-badge gpu-log-badge--completed'
      : status === 'failed'
        ? 'gpu-log-badge gpu-log-badge--failed'
        : 'gpu-log-badge gpu-log-badge--running';

  return <span class={cls}>{status}</span>;
}

/** Type badge component. */
function TypeBadge({ type }: { type: string }) {
  return <span class="gpu-log-type-badge">{type}</span>;
}

/** Single expanded row showing children (per-photo logs). */
function ChildrenRows({ parentId }: { parentId: string }) {
  const [children, setChildren] = useState<GpuLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.gpuLogs.getChildren(parentId).then((res) => {
      setChildren(res.children);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [parentId]);

  if (loading) return <tr><td colSpan={8} class="gpu-log-children-loading">Loading...</td></tr>;
  if (children.length === 0) return <tr><td colSpan={8} class="gpu-log-children-loading">No per-photo logs</td></tr>;

  return (
    <>
      {children.map((child) => (
        <tr key={child.id} class="gpu-log-child-row">
          <td></td>
          <td><TypeBadge type={child.type} /></td>
          <td class="gpu-log-s3path" title={child.s3Path ?? ''}>
            {child.s3Path ? child.s3Path.replace(/^s3:\/\/[^/]+\//, '') : '-'}
          </td>
          <td>{child.provider ?? '-'}</td>
          <td><StatusBadge status={child.status} /></td>
          <td>{formatDuration(child.durationMs)}</td>
          <td class="gpu-log-error" title={child.error ?? ''}>
            {child.error ? child.error.substring(0, 80) : '-'}
          </td>
          <td>{formatDate(child.startedAt)}</td>
        </tr>
      ))}
    </>
  );
}

export function GpuLogsPage(_props: RoutableProps) {
  const [logs, setLogs] = useState<GpuLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const limit = 20;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const filters: GpuLogFilters = { page, limit };
      if (filterType) filters.type = filterType;
      if (filterStatus) filters.status = filterStatus;

      const res = await api.gpuLogs.list(filters);
      setLogs(res.logs);
      setTotal(res.pagination.total);
    } catch (err) {
      console.error('Failed to load GPU logs:', err);
    } finally {
      setLoading(false);
    }
  }, [page, filterType, filterStatus]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / limit);

  const handleToggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

   return (
    <div class="app-content">
      <aside class="sidebar">
        <h3 class="sidebar-heading">Settings</h3>
        <nav class="settings-nav">
          <a href="/settings" class="settings-nav-link">General</a>
          <a href="/settings/gpu-logs" class="settings-nav-link settings-nav-link--active">GPU Logs</a>
          <a href="/settings/sources" class="settings-nav-link">Sources</a>
        </nav>

        <h3 class="sidebar-heading" style="margin-top: 1.25rem;">Filters</h3>
        <div class="gpu-log-filters">
          <label class="gpu-log-filter-label">Type</label>
          <select
            class="gpu-log-filter-select"
            value={filterType}
            onChange={(e) => { setFilterType((e.target as HTMLSelectElement).value); setPage(1); }}
          >
            <option value="">All</option>
            <option value="import">Import</option>
            <option value="reprocess">Reprocess</option>
            <option value="single">Single</option>
          </select>

          <label class="gpu-log-filter-label">Status</label>
          <select
            class="gpu-log-filter-select"
            value={filterStatus}
            onChange={(e) => { setFilterStatus((e.target as HTMLSelectElement).value); setPage(1); }}
          >
            <option value="">All</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>

          <button class="btn btn-secondary gpu-log-refresh-btn" onClick={fetchLogs}>
            Refresh
          </button>
        </div>
      </aside>

      <main class="main-content">
        {loading ? (
          <div class="loading">Loading GPU logs...</div>
        ) : logs.length === 0 ? (
          <div class="gpu-log-empty">
            No GPU logs found.
            {(filterType || filterStatus) && ' Try clearing the filters.'}
          </div>
        ) : (
          <>
            <div class="gpu-log-table-wrapper">
              <table class="gpu-log-table">
                <thead>
                  <tr>
                    <th class="gpu-log-expand-col"></th>
                    <th>Type</th>
                    <th>Photos</th>
                    <th>Provider</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Result</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <>
                      <tr
                        key={log.id}
                        class={`gpu-log-row ${expandedId === log.id ? 'gpu-log-row--expanded' : ''}`}
                        onClick={() => log.childrenCount > 0 && handleToggleExpand(log.id)}
                      >
                        <td class="gpu-log-expand-col">
                          {log.childrenCount > 0 && (
                            <span class={`gpu-log-caret ${expandedId === log.id ? 'gpu-log-caret--open' : ''}`}>
                              &#9654;
                            </span>
                          )}
                        </td>
                        <td><TypeBadge type={log.type} /></td>
                        <td>
                          {log.photoCount ?? '-'}
                          {log.photosSucceeded !== null && log.photosFailed !== null && (
                            <span class="gpu-log-photo-counts">
                              {' '}({log.photosSucceeded} ok / {log.photosFailed} err)
                            </span>
                          )}
                        </td>
                        <td>{log.provider ?? '-'}</td>
                        <td><StatusBadge status={log.status} /></td>
                        <td>{formatDuration(log.durationMs)}</td>
                        <td class="gpu-log-error" title={log.error ?? ''}>
                          {log.error ? log.error.substring(0, 80) : log.status === 'completed' ? 'Success' : '-'}
                        </td>
                        <td>{formatDate(log.startedAt)}</td>
                      </tr>
                      {expandedId === log.id && (
                        <ChildrenRows parentId={log.id} />
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div class="gpu-log-pagination">
                <button
                  class="btn btn-secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <span class="gpu-log-page-info">
                  Page {page} of {totalPages} ({total} total)
                </span>
                <button
                  class="btn btn-secondary"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
