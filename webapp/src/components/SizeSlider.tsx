import { useState } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { photoSize } from '../state/filters';

export function SizeSlider() {
  const [draftSize, setDraftSize] = useState(photoSize.value);

  useSignalEffect(() => {
    setDraftSize(photoSize.value);
  });

  const parseSize = (input: HTMLInputElement) => parseInt(input.value, 10);

  const commitSize = (size: number) => {
    if (!Number.isFinite(size) || photoSize.value === size) return;
    photoSize.value = size;
  };

  return (
    <div class="size-slider">
      <label>Size</label>
      <input
        type="range"
        min="100"
        max="400"
        step="25"
        value={draftSize}
        onInput={(e) => {
          setDraftSize(parseSize(e.currentTarget as HTMLInputElement));
        }}
        onChange={(e) => {
          commitSize(parseSize(e.currentTarget as HTMLInputElement));
        }}
        onPointerUp={(e) => {
          commitSize(parseSize(e.currentTarget as HTMLInputElement));
        }}
        onKeyUp={(e) => {
          commitSize(parseSize(e.currentTarget as HTMLInputElement));
        }}
        onBlur={(e) => {
          commitSize(parseSize(e.currentTarget as HTMLInputElement));
        }}
      />
    </div>
  );
}
