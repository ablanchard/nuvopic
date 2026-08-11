import { useState } from 'preact/hooks';
import { api } from '../api/client';
import { filters, filterVersion } from '../state/filters';

interface FilteredPhotoActionsProps {
  photoCount: number | null;
  onPhotosChanged?: () => void;
}

type ReprocessMode = 'caption' | 'faces' | 'all';
type PhotoAction = ReprocessMode | 'refresh';

export function FilteredPhotoActions({ photoCount, onPhotosChanged }: FilteredPhotoActionsProps) {
  const [triggering, setTriggering] = useState<PhotoAction | null>(null);
  const [status, setStatus] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const handleTrigger = async (action: PhotoAction) => {
    const refreshFromStorage = action === 'refresh';
    if (refreshFromStorage) {
      const confirmed = window.confirm(
        `Refresh all ${photoCount ?? 0} filtered photos from cloud storage? ` +
        'This downloads every matching source file and refreshes local metadata such as EXIF dates, dimensions, and placeholders. ' +
        'Tags, captions, and faces are preserved. No GPU inference will run.'
      );
      if (!confirmed) return;
    }

    setTriggering(action);
    setStatus(null);

    try {
      const result = await api.reprocess.trigger({
        mode: refreshFromStorage ? 'all' : action,
        force: refreshFromStorage || undefined,
        skipModal: refreshFromStorage || undefined,
        filters: { ...filters.value },
      });
      const processed = result.reprocessed + result.failed;

      if (processed === 0) {
        setStatus({
          type: 'success',
          message: refreshFromStorage
            ? 'No matching photos were available to refresh.'
            : 'All matching photos are already up to date.',
        });
      } else {
        setStatus({
          type: result.failed > 0 ? 'error' : 'success',
          message: refreshFromStorage
            ? `${result.reprocessed} refreshed from storage, ${result.failed} failed.`
            : `${result.reprocessed} reprocessed, ${result.failed} failed.`,
        });
      }

      onPhotosChanged?.();
      filterVersion.value++;
    } catch (err) {
      setStatus({
        type: 'error',
        message: `${refreshFromStorage ? 'Refresh' : 'Reprocess'} failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setTriggering(null);
    }
  };

  const disabled = photoCount === null || photoCount === 0 || triggering !== null;
  const scopeLabel = photoCount === null
    ? 'Loading current selection...'
    : `Applies only to ${photoCount} filtered photo${photoCount === 1 ? '' : 's'}. Reprocess skips up-to-date photos; refresh reloads local metadata for every match without GPU inference.`;

  return (
    <div class="filter-section photo-actions-section">
      <h3>Actions</h3>
      <p class="photo-actions-scope">{scopeLabel}</p>
      <div class="photo-actions-buttons">
        <button
          class="btn btn-secondary"
          disabled={disabled}
          onClick={() => handleTrigger('refresh')}
        >
          {triggering === 'refresh' ? 'Refreshing...' : 'Refresh from storage'}
        </button>
        <button
          class="btn btn-secondary"
          disabled={disabled}
          onClick={() => handleTrigger('caption')}
        >
          {triggering === 'caption' ? 'Reprocessing...' : 'Reprocess captions'}
        </button>
        <button
          class="btn btn-secondary"
          disabled={disabled}
          onClick={() => handleTrigger('faces')}
        >
          {triggering === 'faces' ? 'Reprocessing...' : 'Reprocess faces'}
        </button>
        <button
          class="btn btn-primary"
          disabled={disabled}
          onClick={() => handleTrigger('all')}
        >
          {triggering === 'all' ? 'Reprocessing...' : 'Reprocess all'}
        </button>
      </div>
      {status && (
        <div class={`photo-actions-status photo-actions-status--${status.type}`}>
          {status.message}
        </div>
      )}
    </div>
  );
}
