import { useRef, useState, useCallback, useEffect, useMemo } from 'preact/hooks';
import type { GridLayout } from '../lib/gridLayout';

interface YearEntry {
  year: number;
  startY: number;
  photoCount: number;
}

interface TimelineScrollbarProps {
  years: YearEntry[];
  layout: GridLayout;
  scrollTop: number;
  viewportHeight: number;
  onScrollTo: (y: number) => void;
}

export function TimelineScrollbar({
  years,
  layout,
  scrollTop,
  viewportHeight,
  onScrollTo,
}: TimelineScrollbarProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const [railHeight, setRailHeight] = useState(0);

  // Observe rail height
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setRailHeight(entry.contentRect.height);
    });
    ro.observe(el);
    setRailHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const totalHeight = layout.totalHeight;

  // Map content Y to rail Y (proportional)
  const contentToRail = useCallback(
    (contentY: number) => {
      if (totalHeight === 0) return 0;
      return (contentY / totalHeight) * railHeight;
    },
    [totalHeight, railHeight],
  );

  // Map rail Y to content Y
  const railToContent = useCallback(
    (rY: number) => {
      if (railHeight === 0) return 0;
      return (rY / railHeight) * totalHeight;
    },
    [railHeight, totalHeight],
  );

  // Current thumb position and size
  const thumbTop = contentToRail(scrollTop);
  const thumbHeight = Math.max(20, contentToRail(viewportHeight));

  // Year label positions on the rail
  const yearLabels = useMemo(() => {
    if (railHeight === 0 || years.length === 0) return [];

    const labels = years.map((y) => ({
      year: y.year,
      railY: contentToRail(y.startY),
    }));

    // Filter labels that are too close together (min 24px apart)
    const filtered: typeof labels = [];
    for (const label of labels) {
      if (filtered.length === 0 || label.railY - filtered[filtered.length - 1].railY >= 24) {
        filtered.push(label);
      }
    }
    return filtered;
  }, [years, railHeight, contentToRail]);

  // Hover tooltip: which year/month is at the hovered position
  const hoverLabel = useMemo(() => {
    if (hoverY === null) return null;
    const contentY = railToContent(hoverY);
    // Find the section at this Y
    for (const section of layout.sections) {
      if (contentY >= section.startY && contentY < section.endY) {
        return section.label;
      }
    }
    return layout.sections[layout.sections.length - 1]?.label ?? null;
  }, [hoverY, railToContent, layout]);

  // Click on rail: jump to that position
  const handleRailClick = useCallback(
    (e: MouseEvent) => {
      const rail = railRef.current;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      const rY = e.clientY - rect.top;
      const contentY = railToContent(rY);
      onScrollTo(Math.max(0, Math.min(contentY, totalHeight - viewportHeight)));
    },
    [railToContent, onScrollTo, totalHeight, viewportHeight],
  );

  // Drag handling
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
    },
    [],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rail = railRef.current;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      const rY = Math.max(0, Math.min(e.clientY - rect.top, railHeight));
      const contentY = railToContent(rY);
      onScrollTo(Math.max(0, Math.min(contentY, totalHeight - viewportHeight)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, railHeight, railToContent, onScrollTo, totalHeight, viewportHeight]);

  // Hover tracking on rail
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isDragging) return;
      const rail = railRef.current;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      setHoverY(e.clientY - rect.top);
    },
    [isDragging],
  );

  const handleMouseLeave = useCallback(() => {
    if (!isDragging) setHoverY(null);
  }, [isDragging]);

  // Year label click: jump to that year
  const handleYearClick = useCallback(
    (year: number, e: MouseEvent) => {
      e.stopPropagation();
      const yearEntry = years.find((y) => y.year === year);
      if (yearEntry) {
        onScrollTo(yearEntry.startY);
      }
    },
    [years, onScrollTo],
  );

  if (totalHeight === 0 || years.length === 0) return null;

  return (
    <div
      class={`timeline-scrollbar ${isDragging ? 'timeline-scrollbar--dragging' : ''}`}
      ref={railRef}
      onClick={handleRailClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Rail track */}
      <div class="timeline-rail" />

      {/* Year labels */}
      {yearLabels.map(({ year, railY }) => (
        <button
          key={year}
          class="timeline-year-label"
          style={{ top: `${railY}px` }}
          onClick={(e) => handleYearClick(year, e)}
        >
          {year}
        </button>
      ))}

      {/* Thumb */}
      <div
        class="timeline-thumb"
        style={{
          top: `${thumbTop}px`,
          height: `${thumbHeight}px`,
        }}
        onMouseDown={handleMouseDown}
      />

      {/* Hover tooltip */}
      {hoverY !== null && hoverLabel && !isDragging && (
        <div
          class="timeline-tooltip"
          style={{ top: `${hoverY}px` }}
        >
          {hoverLabel}
        </div>
      )}
    </div>
  );
}
