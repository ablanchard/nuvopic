import { useEffect, useState } from 'preact/hooks';
import { api } from '../api/client';
import type { GpuWalletEstimate } from '../api/client';
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
  const [estimates, setEstimates] = useState<Record<ReprocessMode, GpuWalletEstimate | null>>({
    caption: null,
    faces: null,
    all: null,
  });

  useEffect(() => {
    if (!photoCount) {
      setEstimates({ caption: null, faces: null, all: null });
      return;
    }
    let cancelled = false;
    void Promise.all([
      api.gpu.estimate(photoCount, 'caption-only'),
      api.gpu.estimate(photoCount, 'faces-only'),
      api.gpu.estimate(photoCount, 'all'),
    ]).then(([caption, faces, all]) => {
      if (!cancelled) {
        setEstimates({
          caption: caption.estimate,
          faces: faces.estimate,
          all: all.estimate,
        });
      }
    }).catch(() => {
      if (!cancelled) setEstimates({ caption: null, faces: null, all: null });
    });
    return () => { cancelled = true; };
  }, [photoCount]);

  const formatEstimate = (estimate: GpuWalletEstimate | null): string => {
    if (!estimate) return '';
    const amount = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: estimate.currency,
    }).format(Number(estimate.estimatedMicros) / 1_000_000);
    return ` · up to ${amount}`;
  };

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
          {triggering === 'caption' ? 'Reprocessing...' : `Reprocess captions${formatEstimate(estimates.caption)}`}
        </button>
        <button
          class="btn btn-secondary"
          disabled={disabled}
          onClick={() => handleTrigger('faces')}
        >
          {triggering === 'faces' ? 'Reprocessing...' : `Reprocess faces${formatEstimate(estimates.faces)}`}
        </button>
        <button
          class="btn btn-primary"
          disabled={disabled}
          onClick={() => handleTrigger('all')}
        >
          {triggering === 'all' ? 'Reprocessing...' : `Reprocess all${formatEstimate(estimates.all)}`}
        </button>
      </div>
      {Object.values(estimates).some((estimate) => estimate?.sufficient === false) && (
        <p class="photo-actions-scope">
          One or more maximum estimates exceed your current allowance. The exact filtered set is checked before processing. <a href="/profile">Open your wallet</a>.
        </p>
      )}
      {status && (
        <div class={`photo-actions-status photo-actions-status--${status.type}`}>
          {status.message}
        </div>
      )}
    </div>
  );
}
