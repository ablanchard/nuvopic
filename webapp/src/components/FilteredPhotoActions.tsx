import { useState } from 'preact/hooks';
import { api } from '../api/client';
import { filters, filterVersion } from '../state/filters';

interface FilteredPhotoActionsProps {
  photoCount: number | null;
}

type ReprocessMode = 'caption' | 'faces' | 'all';

export function FilteredPhotoActions({ photoCount }: FilteredPhotoActionsProps) {
  const [triggering, setTriggering] = useState<ReprocessMode | null>(null);
  const [status, setStatus] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const handleTrigger = async (mode: ReprocessMode) => {
    setTriggering(mode);
    setStatus(null);

    try {
      const result = await api.reprocess.trigger({
        mode,
        filters: { ...filters.value },
      });
      const processed = result.reprocessed + result.failed;

      if (processed === 0) {
        setStatus({
          type: 'success',
          message: 'All matching photos are already up to date.',
        });
      } else {
        setStatus({
          type: result.failed > 0 ? 'error' : 'success',
          message: `${result.reprocessed} reprocessed, ${result.failed} failed.`,
        });
      }

      filterVersion.value++;
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Reprocess failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setTriggering(null);
    }
  };

  const disabled = photoCount === null || photoCount === 0 || triggering !== null;
  const scopeLabel = photoCount === null
    ? 'Loading current selection...'
    : `Applies only to ${photoCount} filtered photo${photoCount === 1 ? '' : 's'}; up-to-date photos are skipped.`;

  return (
    <div class="filter-section photo-actions-section">
      <h3>Actions</h3>
      <p class="photo-actions-scope">{scopeLabel}</p>
      <div class="photo-actions-buttons">
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
