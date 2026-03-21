import type { TimelineGroup } from '../api/client';

export interface GridSection {
  /** Unique key, e.g. "2024-12" or "undated" */
  key: string;
  /** Display label, e.g. "December 2024" */
  label: string;
  year: number | null;
  month: number | null;
  /** Number of photos in this section */
  photoCount: number;
  /** Number of grid rows needed for photos */
  photoRows: number;
  /** Cumulative photo offset (how many photos come before this section) */
  photoOffset: number;
  /** Y position of the section header (px) */
  startY: number;
  /** Y position after the last photo row (px) */
  endY: number;
}

export interface GridLayout {
  sections: GridSection[];
  totalHeight: number;
  totalPhotos: number;
}

export interface VisibleRange {
  /** Sections that overlap the visible window */
  sections: Array<{
    section: GridSection;
    /** First visible photo row index within section (0-based) */
    firstRow: number;
    /** Last visible photo row index within section (0-based, inclusive) */
    lastRow: number;
  }>;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const SECTION_HEADER_HEIGHT = 48;
export const ROW_GAP = 6;

/**
 * Compute the full grid layout from timeline groups.
 * Pure computation -- no DOM access.
 */
export function computeLayout(
  groups: TimelineGroup[],
  columnCount: number,
  rowHeight: number,
): GridLayout {
  const sections: GridSection[] = [];
  let currentY = 0;
  let photoOffset = 0;

  for (const group of groups) {
    const key = group.year !== null && group.month !== null
      ? `${group.year}-${String(group.month).padStart(2, '0')}`
      : 'undated';

    const label = group.year !== null && group.month !== null
      ? `${MONTH_NAMES[group.month - 1]} ${group.year}`
      : 'Unknown date';

    const photoRows = Math.ceil(group.count / columnCount);
    const startY = currentY;

    // Section header + photo rows (with gaps between rows)
    const sectionHeight = SECTION_HEADER_HEIGHT
      + photoRows * rowHeight
      + (photoRows > 0 ? (photoRows - 1) * ROW_GAP : 0);

    currentY += sectionHeight;

    sections.push({
      key,
      label,
      year: group.year,
      month: group.month,
      photoCount: group.count,
      photoRows,
      photoOffset,
      startY,
      endY: currentY,
    });

    photoOffset += group.count;
  }

  return {
    sections,
    totalHeight: currentY,
    totalPhotos: photoOffset,
  };
}

/**
 * Get which sections and rows are visible in the current viewport.
 * Includes a buffer of extra rows above/below.
 */
export function getVisibleRange(
  layout: GridLayout,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  bufferRows: number = 5,
): VisibleRange {
  const bufferPx = bufferRows * (rowHeight + ROW_GAP);
  const top = Math.max(0, scrollTop - bufferPx);
  const bottom = scrollTop + viewportHeight + bufferPx;

  const result: VisibleRange = { sections: [] };

  for (const section of layout.sections) {
    // Skip sections entirely outside the window
    if (section.endY <= top || section.startY >= bottom) continue;

    // The photo area starts after the section header
    const photosStartY = section.startY + SECTION_HEADER_HEIGHT;

    // Calculate which rows within this section are visible
    if (photosStartY >= bottom) {
      // Only the header is visible
      result.sections.push({ section, firstRow: -1, lastRow: -1 });
      continue;
    }

    const relativeTop = Math.max(0, top - photosStartY);
    const relativeBottom = Math.max(0, bottom - photosStartY);

    const firstRow = Math.max(0, Math.floor(relativeTop / (rowHeight + ROW_GAP)));
    const lastRow = Math.min(
      section.photoRows - 1,
      Math.floor(relativeBottom / (rowHeight + ROW_GAP)),
    );

    result.sections.push({ section, firstRow, lastRow });
  }

  return result;
}

/**
 * Get the Y position to scroll to for a given section key.
 */
export function getYForSection(layout: GridLayout, key: string): number | null {
  const section = layout.sections.find((s) => s.key === key);
  return section ? section.startY : null;
}

/**
 * Get the Y position to scroll to for the first section of a given year.
 */
export function getYForYear(layout: GridLayout, year: number): number | null {
  const section = layout.sections.find((s) => s.year === year);
  return section ? section.startY : null;
}

/**
 * Get which section corresponds to a given Y position.
 */
export function getSectionAtY(layout: GridLayout, y: number): GridSection | null {
  for (const section of layout.sections) {
    if (y >= section.startY && y < section.endY) return section;
  }
  // If past the end, return the last section
  return layout.sections[layout.sections.length - 1] ?? null;
}

/**
 * Get the Y position of a photo row within a section.
 */
export function getRowY(section: GridSection, rowIndex: number, rowHeight: number): number {
  return section.startY + SECTION_HEADER_HEIGHT + rowIndex * (rowHeight + ROW_GAP);
}

/**
 * Get all unique years from the layout, ordered descending.
 */
export function getYears(layout: GridLayout): Array<{ year: number; startY: number; photoCount: number }> {
  const yearMap = new Map<number, { startY: number; photoCount: number }>();

  for (const section of layout.sections) {
    if (section.year === null) continue;
    if (!yearMap.has(section.year)) {
      yearMap.set(section.year, { startY: section.startY, photoCount: 0 });
    }
    yearMap.get(section.year)!.photoCount += section.photoCount;
  }

  return Array.from(yearMap.entries())
    .map(([year, data]) => ({ year, ...data }))
    .sort((a, b) => b.year - a.year);
}
