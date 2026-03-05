import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { api } from '../api/client';
import type { Cluster, ClusterFace, ClusterStrategy } from '../api/client';
import { ClusterCard } from './ClusterCard';
import { FaceCrop } from './FaceCrop';
import type { RoutableProps } from 'preact-router';

/** Stable sort: named clusters first (alphabetical), then unnamed (by id). */
function sortClusters(clusters: Cluster[]): Cluster[] {
  return [...clusters].sort((a, b) => {
    if (a.personName && !b.personName) return -1;
    if (!a.personName && b.personName) return 1;
    if (a.personName && b.personName) return a.personName.localeCompare(b.personName);
    return a.id.localeCompare(b.id);
  });
}

export function FacesPage(_props: RoutableProps) {
  // Clustering parameters
  const [threshold, setThreshold] = useState(0.6);
  const [strategy, setStrategy] = useState<ClusterStrategy>('first');

  // Data
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [unassigned, setUnassigned] = useState<ClusterFace[]>([]);

  // UI state
  const [loading, setLoading] = useState(true);
  const [clustering, setClustering] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Assign popover state
  const [assignPopover, setAssignPopover] = useState<{ faceId: string; x: number; y: number } | null>(null);

  // Sorted clusters — stable order that doesn't change when face counts change
  const sortedClusters = useMemo(() => sortClusters(clusters), [clusters]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [clustersRes, unassignedRes] = await Promise.all([
        api.clusters.list(),
        api.clusters.getUnassigned(),
      ]);
      setClusters(clustersRes.clusters);
      setUnassigned(unassignedRes.faces);
    } catch (err) {
      console.error('Failed to load clusters:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Close popover on outside click
  useEffect(() => {
    if (!assignPopover) return;
    const handler = () => setAssignPopover(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [assignPopover]);

  const handleRunClustering = async () => {
    setClustering(true);
    setStatus(null);
    try {
      const result = await api.clusters.run({ threshold, strategy });
      setStatus(`Clustered ${result.clustered} faces, created ${result.newClusters} new clusters`);
      await refresh();
    } catch (err) {
      setStatus(`Clustering failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setClustering(false);
    }
  };

  const handleRecluster = async () => {
    const confirmed = window.confirm(
      'This will rebuild all unnamed clusters. Named clusters and manually assigned faces are preserved. Continue?'
    );
    if (!confirmed) return;

    setClustering(true);
    setStatus(null);
    try {
      const result = await api.clusters.recluster({ threshold, strategy });
      setStatus(
        `Reclustered: ${result.totalClusters} total clusters, ` +
        `${result.namedPreserved} named preserved, ${result.newClusters} new clusters`
      );
      await refresh();
    } catch (err) {
      setStatus(`Recluster failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setClustering(false);
    }
  };

  const handleAssignFace = async (faceId: string, clusterId: string) => {
    setAssignPopover(null);
    try {
      await api.clusters.assignFace(clusterId, faceId);
      await refresh();
    } catch (err) {
      console.error('Failed to assign face:', err);
    }
  };

  const handleCreateCluster = async (faceId: string) => {
    setAssignPopover(null);
    try {
      await api.clusters.create(faceId);
      await refresh();
    } catch (err) {
      console.error('Failed to create cluster:', err);
    }
  };

  const openAssignPopover = (faceId: string, e: MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAssignPopover({
      faceId,
      x: rect.left,
      y: rect.bottom + 4,
    });
  };

  return (
    <div class="app-content">
      {/* Left Sidebar: Unassigned Faces */}
      <aside class="sidebar" style={{ maxHeight: 'calc(100vh - 96px)', overflowY: 'auto' }}>
        <h3 class="sidebar-heading">Unassigned ({unassigned.length})</h3>
        {loading ? (
          <div class="sidebar-empty">Loading...</div>
        ) : unassigned.length === 0 ? (
          <div class="sidebar-empty">All faces assigned</div>
        ) : (
          <div class="unassigned-grid">
            {unassigned.map((face) => (
              <div key={face.id} class="unassigned-face-item">
                <FaceCrop
                  thumbnailUrl={face.thumbnailUrl}
                  boundingBox={face.boundingBox}
                  photoWidth={face.photoWidth}
                  photoHeight={face.photoHeight}
                  size={64}
                />
                <button
                  class="btn btn-small"
                  onClick={(e) => openAssignPopover(face.id, e as unknown as MouseEvent)}
                >
                  Assign
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Main Content: Controls + Cluster Grid */}
      <main class="main-content">
        {/* Clustering Controls */}
        <div class="clustering-controls">
          <h2>Face Clustering</h2>
          <div class="controls-row">
            <div class="control-group">
              <label>Threshold</label>
              <div class="control-with-value">
                <input
                  type="range"
                  min="0.3"
                  max="0.9"
                  step="0.05"
                  value={threshold}
                  onInput={(e) => setThreshold(parseFloat((e.target as HTMLInputElement).value))}
                  disabled={clustering}
                />
                <span class="control-value">{threshold.toFixed(2)}</span>
              </div>
            </div>

            <div class="control-group">
              <label>Strategy</label>
              <select
                value={strategy}
                onChange={(e) => setStrategy((e.target as HTMLSelectElement).value as ClusterStrategy)}
                disabled={clustering}
              >
                <option value="first">First face</option>
                <option value="average">Average embedding</option>
              </select>
            </div>

            <div class="control-actions">
              <button
                class="btn btn-primary"
                onClick={handleRunClustering}
                disabled={clustering}
              >
                {clustering ? 'Running...' : 'Run Clustering'}
              </button>
              <button
                class="btn btn-secondary"
                onClick={handleRecluster}
                disabled={clustering}
              >
                Recluster All
              </button>
            </div>
          </div>

          {status && (
            <div class="clustering-status">{status}</div>
          )}
        </div>

        {/* Cluster Grid */}
        {loading ? (
          <div class="loading">Loading clusters...</div>
        ) : (
          <>
            {sortedClusters.length > 0 && (
              <div class="clusters-section">
                <h3>Clusters ({sortedClusters.length})</h3>
                <div class="cluster-grid">
                  {sortedClusters.map((cluster) => (
                    <ClusterCard
                      key={cluster.id}
                      cluster={cluster}
                      onRefresh={refresh}
                    />
                  ))}
                </div>
              </div>
            )}

            {sortedClusters.length === 0 && unassigned.length === 0 && (
              <div class="empty">
                No faces detected yet. Import or reprocess photos to detect faces.
              </div>
            )}
          </>
        )}
      </main>

      {/* Assign Popover */}
      {assignPopover && (
        <div
          class="assign-popover"
          style={{ left: `${assignPopover.x}px`, top: `${assignPopover.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="assign-popover-header">Assign to:</div>
          <button
            class="assign-popover-item assign-popover-create"
            onClick={() => handleCreateCluster(assignPopover.faceId)}
          >
            + Create new cluster
          </button>
          {sortedClusters.length > 0 && <div class="assign-popover-divider" />}
          {sortedClusters.map((cluster) => (
            <button
              key={cluster.id}
              class="assign-popover-item"
              onClick={() => handleAssignFace(assignPopover.faceId, cluster.id)}
            >
              {cluster.representativeFace && (
                <FaceCrop
                  thumbnailUrl={cluster.representativeFace.thumbnailUrl}
                  boundingBox={cluster.representativeFace.boundingBox}
                  photoWidth={null}
                  photoHeight={null}
                  size={32}
                />
              )}
              <span class="assign-popover-name">
                {cluster.personName || `Unnamed cluster`}
              </span>
              <span class="assign-popover-count">
                {cluster.faceCount}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
