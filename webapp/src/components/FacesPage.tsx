import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { api } from '../api/client';
import type { Cluster, ClusterFace, ClusterStrategy } from '../api/client';
import { ClusterCard } from './ClusterCard';
import { FaceCrop } from './FaceCrop';
import { FaceMetrics } from './FaceMetrics';
import type { RoutableProps } from 'preact-router';

const DEFAULT_MIN_CONFIDENCE = '0.7';
const DEFAULT_MIN_AREA = '2500';

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
  const [filteredOut, setFilteredOut] = useState<ClusterFace[]>([]);
  const [filteredOutTotal, setFilteredOutTotal] = useState(0);
  const [wontAssign, setWontAssign] = useState<ClusterFace[]>([]);
  const [wontAssignTotal, setWontAssignTotal] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  // Face quality filters
  const [minConfidence, setMinConfidence] = useState(DEFAULT_MIN_CONFIDENCE);
  const [minArea, setMinArea] = useState(DEFAULT_MIN_AREA);
  const [savedMinConfidence, setSavedMinConfidence] = useState(DEFAULT_MIN_CONFIDENCE);
  const [savedMinArea, setSavedMinArea] = useState(DEFAULT_MIN_AREA);
  const [qualityLoading, setQualityLoading] = useState(true);
  const [qualitySaving, setQualitySaving] = useState(false);
  const [qualityStatus, setQualityStatus] = useState<string | null>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [clustering, setClustering] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [changingWontAssignFaceId, setChangingWontAssignFaceId] = useState<string | null>(null);

  // Assign popover state
  const [assignPopover, setAssignPopover] = useState<{ faceId: string; x: number; y: number } | null>(null);

  // Sorted clusters — stable order that doesn't change when face counts change
  const sortedClusters = useMemo(() => sortClusters(clusters), [clusters]);

  const refresh = useCallback(async (options: { initial?: boolean } = {}) => {
    if (options.initial) setLoading(true);
    try {
      const [clustersRes, unassignedRes, filteredOutRes, wontAssignRes] = await Promise.all([
        api.clusters.list(),
        api.clusters.getUnassigned(),
        api.clusters.getFilteredOut(),
        api.clusters.getWontAssign(),
      ]);
      setClusters(clustersRes.clusters);
      setUnassigned(unassignedRes.faces);
      setFilteredOut(filteredOutRes.faces);
      setFilteredOutTotal(filteredOutRes.total);
      setWontAssign(wontAssignRes.faces);
      setWontAssignTotal(wontAssignRes.total);
      setReloadToken((value) => value + 1);
    } catch (err) {
      console.error('Failed to load clusters:', err);
    } finally {
      if (options.initial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh({ initial: true });
  }, [refresh]);

  useEffect(() => {
    api.settings.get()
      .then((settings) => {
        const confidence = settings.face_min_confidence ?? DEFAULT_MIN_CONFIDENCE;
        const area = settings.face_min_size ?? DEFAULT_MIN_AREA;
        setMinConfidence(confidence);
        setSavedMinConfidence(confidence);
        setMinArea(area);
        setSavedMinArea(area);
      })
      .catch((err) => {
        setQualityStatus(`Failed to load face quality settings: ${err instanceof Error ? err.message : 'Unknown error'}`);
      })
      .finally(() => setQualityLoading(false));
  }, []);

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

  const handleApplyQuality = async () => {
    const confidence = Number(minConfidence);
    const area = Number(minArea);

    if (minConfidence.trim() === '' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      setQualityStatus('Minimum confidence must be between 0 and 1');
      return;
    }
    if (minArea.trim() === '' || !Number.isFinite(area) || area < 0) {
      setQualityStatus('Minimum area must be zero or greater');
      return;
    }

    const normalizedConfidence = String(confidence);
    const normalizedArea = String(Math.round(area));
    setQualitySaving(true);
    setQualityStatus(null);
    try {
      await api.settings.update({
        face_min_confidence: normalizedConfidence,
        face_min_size: normalizedArea,
      });
      setMinConfidence(normalizedConfidence);
      setSavedMinConfidence(normalizedConfidence);
      setMinArea(normalizedArea);
      setSavedMinArea(normalizedArea);
      await refresh();
      setQualityStatus('Filters applied');
    } catch (err) {
      setQualityStatus(`Failed to apply filters: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setQualitySaving(false);
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
    setStatus(null);
    try {
      await api.clusters.create(faceId);
      await refresh();
      setStatus('Created new cluster');
    } catch (err) {
      console.error('Failed to create cluster:', err);
      setStatus(`Failed to create cluster: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleWontAssign = async (faceId: string) => {
    setAssignPopover(null);
    setChangingWontAssignFaceId(faceId);
    setStatus(null);
    try {
      await api.clusters.markWontAssign(faceId);
      const face = unassigned.find((candidate) => candidate.id === faceId);
      setUnassigned((current) => current.filter((candidate) => candidate.id !== faceId));
      if (face) {
        setWontAssign((current) => [face, ...current.filter((candidate) => candidate.id !== faceId)]);
        setWontAssignTotal((current) => current + 1);
      }
      setStatus("Face moved to Won't assign");
      void refresh();
    } catch (err) {
      setStatus(`Failed to exclude face: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setChangingWontAssignFaceId(null);
    }
  };

  const handleRestoreAssignment = async (faceId: string) => {
    setChangingWontAssignFaceId(faceId);
    setStatus(null);
    try {
      await api.clusters.restoreAssignment(faceId);
      setWontAssign((current) => current.filter((face) => face.id !== faceId));
      setWontAssignTotal((current) => Math.max(0, current - 1));
      setStatus('Face restored to assignment');
      void refresh();
    } catch (err) {
      setStatus(`Failed to restore face: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setChangingWontAssignFaceId(null);
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
                  faceId={face.id}
                  photoId={face.photoId}
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

        <details class="filtered-faces-section">
          <summary class="filtered-faces-summary">
            Filtered out ({filteredOutTotal})
          </summary>
          {loading ? (
            <div class="sidebar-empty">Loading...</div>
          ) : filteredOut.length === 0 ? (
            <div class="sidebar-empty">No faces filtered out</div>
          ) : (
            <>
              <div class="unassigned-grid">
                {filteredOut.map((face) => (
                  <div key={face.id} class="unassigned-face-item">
                    <FaceCrop
                      faceId={face.id}
                      photoId={face.photoId}
                      size={64}
                    />
                    <FaceMetrics confidence={face.confidence} area={face.area} />
                  </div>
                ))}
              </div>
              {filteredOutTotal > filteredOut.length && (
                <div class="filtered-faces-limit">
                  Showing the first {filteredOut.length} faces
                </div>
              )}
            </>
          )}
        </details>

        <details class="filtered-faces-section wont-assign-section">
          <summary class="filtered-faces-summary">
            Won't assign ({wontAssignTotal})
          </summary>
          {loading ? (
            <div class="sidebar-empty">Loading...</div>
          ) : wontAssign.length === 0 ? (
            <div class="sidebar-empty">No manually excluded faces</div>
          ) : (
            <>
              <div class="unassigned-grid">
                {wontAssign.map((face) => (
                  <div key={face.id} class="unassigned-face-item">
                    <FaceCrop
                      faceId={face.id}
                      photoId={face.photoId}
                      size={64}
                    />
                    {(face.confidence === null ||
                      face.confidence < Number(savedMinConfidence) ||
                      face.area < Number(savedMinArea)) && (
                      <FaceMetrics confidence={face.confidence} area={face.area} />
                    )}
                    <button
                      class="btn btn-small"
                      onClick={() => handleRestoreAssignment(face.id)}
                      disabled={changingWontAssignFaceId === face.id}
                    >
                      {changingWontAssignFaceId === face.id ? 'Restoring…' : 'Restore'}
                    </button>
                  </div>
                ))}
              </div>
              {wontAssignTotal > wontAssign.length && (
                <div class="filtered-faces-limit">
                  Showing the first {wontAssign.length} faces
                </div>
              )}
            </>
          )}
        </details>
      </aside>

      {/* Main Content: Controls + Cluster Grid */}
      <main class="main-content">
        <div class="clustering-controls">
          <h2>Face Quality</h2>
          <div class="controls-row">
            <div class="control-group">
              <label for="face-min-confidence">Minimum confidence</label>
              <div class="control-with-value">
                <input
                  id="face-min-confidence"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={minConfidence}
                  onInput={(e) => {
                    setMinConfidence((e.target as HTMLInputElement).value);
                    setQualityStatus(null);
                  }}
                  disabled={qualityLoading || qualitySaving}
                />
                <span class="control-value">{Number(minConfidence).toFixed(2)}</span>
              </div>
              <span class="control-hint">Detector score from 0 to 1</span>
            </div>

            <div class="control-group">
              <label for="face-min-area">Minimum area (px²)</label>
              <input
                id="face-min-area"
                class="face-quality-number-input"
                type="number"
                min="0"
                max="50000"
                step="100"
                value={minArea}
                onInput={(e) => {
                  setMinArea((e.target as HTMLInputElement).value);
                  setQualityStatus(null);
                }}
                disabled={qualityLoading || qualitySaving}
              />
              <span class="control-hint">Width × height; 50 × 50 = 2,500</span>
            </div>

            <div class="control-actions">
              <button
                class="btn btn-primary"
                onClick={handleApplyQuality}
                disabled={
                  qualityLoading ||
                  qualitySaving ||
                  (minConfidence === savedMinConfidence && minArea === savedMinArea)
                }
              >
                {qualitySaving ? 'Applying...' : 'Apply Filters'}
              </button>
            </div>
          </div>
          {qualityStatus && <div class="clustering-status">{qualityStatus}</div>}
        </div>

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
                      reloadToken={reloadToken}
                      minConfidence={Number(savedMinConfidence)}
                      minArea={Number(savedMinArea)}
                      mergeTargets={sortedClusters.filter((target) => target.id !== cluster.id)}
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
          <button
            class="assign-popover-item assign-popover-exclude"
            onClick={() => handleWontAssign(assignPopover.faceId)}
            disabled={changingWontAssignFaceId === assignPopover.faceId}
          >
            Won't assign
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
                  faceId={cluster.representativeFace.faceId}
                  photoId={cluster.representativeFace.photoId}
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
