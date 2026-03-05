import { useState, useEffect } from 'preact/hooks';
import { api } from '../api/client';
import type { Cluster, ClusterFace } from '../api/client';
import { FaceCrop } from './FaceCrop';

interface ClusterCardProps {
  cluster: Cluster;
  onRefresh: () => void;
}

const INITIAL_VISIBLE = 6;

export function ClusterCard({ cluster, onRefresh }: ClusterCardProps) {
  const [faces, setFaces] = useState<ClusterFace[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(cluster.personName ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.clusters.getFaces(cluster.id)
      .then((data) => setFaces(data.faces))
      .catch(() => setFaces([]))
      .finally(() => setLoading(false));
  }, [cluster.id]);

  const visibleFaces = expanded ? faces : faces.slice(0, INITIAL_VISIBLE);
  const hiddenCount = faces.length - INITIAL_VISIBLE;

  const handleNameSave = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;

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
                  thumbnailUrl={face.thumbnailUrl}
                  boundingBox={face.boundingBox}
                  photoWidth={face.photoWidth}
                  photoHeight={face.photoHeight}
                  size={72}
                />
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
    </div>
  );
}
