import type { Photo } from '../api/client';

interface PhotoCardProps {
  photo: Photo;
  onClick?: () => void;
}

export function PhotoCard({ photo, onClick }: PhotoCardProps) {
  return (
    <div class="photo-card" onClick={onClick}>
      <img
        src={photo.thumbnailUrl}
        alt={photo.description || 'Photo'}
        loading="lazy"
      />
      <div class="photo-card-overlay">
        {photo.faceCount > 0 && (
          <span class="face-badge">{photo.faceCount} face{photo.faceCount > 1 ? 's' : ''}</span>
        )}
        {photo.takenAt && (
          <span class="date-badge">
            {new Date(photo.takenAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}
