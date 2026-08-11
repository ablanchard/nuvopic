import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api/client';
import type { Cluster, ClusterFace } from '../api/client';
import { FaceCrop } from './FaceCrop';
import { FaceMetrics } from './FaceMetrics';

interface ClusterCardProps {
  cluster: Cluster;
  onRefresh: () => void;
  reloadToken: number;
  minConfidence: number;
  minArea: number;
  mergeTargets: Cluster[];
}

const INITIAL_VISIBLE = 6;

export function ClusterCard({
  cluster,
  onRefresh,
  reloadToken,
  minConfidence,
  minArea,
  mergeTargets,
}: ClusterCardProps) {
  const [faces, setFaces] = useState<ClusterFace[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(cluster.personName ?? '');
  const [saving, setSaving] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api.clusters.getFaces(cluster.id)
      .then((data) => {
        if (!cancelled) setFaces(data.faces);
      })
      .catch(() => {
        // Keep the currently rendered faces when a background sync fails.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cluster.id, reloadToken]);

  const visibleFaces = expanded ? faces : faces.slice(0, INITIAL_VISIBLE);
  const hiddenCount = faces.length - INITIAL_VISIBLE;

  const handleNameSave = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed || savingRef.current) return;

    savingRef.current = true;
    setSaving(true);
    try {
      if (cluster.personName) {
        // Rename existing person
        await api.clusters.rename(cluster.id, trimmed);
      } else {
        // Name the cluster (creates person, locks all faces)
        await api.clusters.name(cluster.id, trimmed);
      }
      setEditing(false);
      onRefresh();
    } catch (err) {
      console.error('Failed to save name:', err);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleNameKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNameSave();
    } else if (e.key === 'Escape') {
      setEditing(false);
      setNameInput(cluster.personName ?? '');
    }
  };

  const handleRemoveFace = async (faceId: string) => {
    // Optimistic removal
    setFaces((prev) => prev.filter((f) => f.id !== faceId));
    try {
      await api.clusters.removeFace(cluster.id, faceId);
      onRefresh();
    } catch (err) {
      console.error('Failed to remove face:', err);
      // Revert - reload faces
      api.clusters.getFaces(cluster.id)
        .then((data) => setFaces(data.faces));
    }
  };

  const handleMerge = async () => {
    if (!mergeTargetId || merging) return;

    setMerging(true);
    setMergeError(null);
    try {
      await api.clusters.merge(cluster.id, mergeTargetId);
      setMergeOpen(false);
      setMergeTargetId('');
      onRefresh();
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Failed to merge clusters');
    } finally {
      setMerging(false);
    }
  };

  return (
    <div class={`cluster-card ${cluster.personName ? 'cluster-card--named' : ''}`}>
      <div class="cluster-card-header">
        {editing || !cluster.personName ? (
          <div class="cluster-name-edit">
            <input
              type="text"
              class="cluster-name-input"
              placeholder="Name this person..."
              value={nameInput}
              onInput={(e) => setNameInput((e.target as HTMLInputElement).value)}
              onKeyDown={handleNameKeyDown}
              onBlur={handleNameSave}
              disabled={saving}
              autoFocus={editing}
            />
          </div>
        ) : (
          <div class="cluster-name-display">
            <span class="cluster-person-name">{cluster.personName}</span>
            <button
              class="cluster-edit-btn"
              onClick={() => {
                setEditing(true);
                setNameInput(cluster.personName ?? '');
              }}
              title="Edit name"
            >
              &#9998;
            </button>
          </div>
        )}
        <span class="cluster-face-count">{cluster.faceCount} face{cluster.faceCount !== 1 ? 's' : ''}</span>
      </div>

      <div class="cluster-face-grid">
        {loading ? (
          <div class="cluster-loading">Loading faces...</div>
        ) : (
          <>
            {visibleFaces.map((face) => (
              <div key={face.id} class="cluster-face-item">
                <FaceCrop
                  faceId={face.id}
                  photoId={face.photoId}
                  size={72}
                />
                {(face.confidence === null ||
                  face.confidence < minConfidence ||
                  face.area < minArea) && (
                  <FaceMetrics confidence={face.confidence} area={face.area} />
                )}
                <button
                  class="face-remove-btn"
                  onClick={() => handleRemoveFace(face.id)}
                  title="Remove from cluster"
                >
                  &times;
                </button>
              </div>
            ))}
            {!expanded && hiddenCount > 0 && (
              <button
                class="cluster-show-more"
                onClick={() => setExpanded(true)}
              >
                +{hiddenCount} more
              </button>
            )}
            {expanded && hiddenCount > 0 && (
              <button
                class="cluster-show-more"
                onClick={() => setExpanded(false)}
              >
                Show less
              </button>
            )}
          </>
        )}
      </div>

      {mergeTargets.length > 0 && (
        <div class="cluster-merge">
          {!mergeOpen ? (
            <button
              class="btn btn-small cluster-merge-toggle"
              onClick={() => {
                setMergeOpen(true);
                setMergeError(null);
              }}
            >
              Merge
            </button>
          ) : (
            <div class="cluster-merge-controls">
              <select
                class="cluster-merge-select"
                value={mergeTargetId}
                onChange={(event) => setMergeTargetId((event.target as HTMLSelectElement).value)}
                disabled={merging}
                aria-label="Merge into cluster"
              >
                <option value="">Select target cluster…</option>
                {mergeTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.personName || 'Unnamed cluster'} ({target.faceCount} face{target.faceCount === 1 ? '' : 's'})
                  </option>
                ))}
              </select>
              <div class="cluster-merge-actions">
                <button
                  class="btn btn-small btn-primary"
                  onClick={handleMerge}
                  disabled={!mergeTargetId || merging}
                >
                  {merging ? 'Merging…' : 'Merge into selected'}
                </button>
                <button
                  class="btn btn-small btn-secondary"
                  onClick={() => {
                    setMergeOpen(false);
                    setMergeTargetId('');
                    setMergeError(null);
                  }}
                  disabled={merging}
                >
                  Cancel
                </button>
              </div>
              {mergeError && <div class="cluster-merge-error">{mergeError}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
