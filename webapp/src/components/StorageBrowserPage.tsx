import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api/client';
import type { StorageFolderInfo } from '../api/client';
import type { RoutableProps } from 'preact-router';

/* =========================================================================
   Types for the folder tree state
   ========================================================================= */

interface FolderNode extends StorageFolderInfo {
  children: FolderNode[] | null; // null = not loaded yet
  loading: boolean;
}

type GpuMode = 'all' | 'caption-only' | 'faces-only' | 'skip';

/* =========================================================================
   Component
   ========================================================================= */

export function StorageBrowserPage(_props: RoutableProps) {
  // Top-level browse state
  const [rootFolders, setRootFolders] = useState<FolderNode[]>([]);
  const [rootImageCount, setRootImageCount] = useState(0);
  const [rootImportedCount, setRootImportedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Selection state
  const [selectedPrefixes, setSelectedPrefixes] = useState<Set<string>>(new Set());

  // Expand state
  const [expandedPrefixes, setExpandedPrefixes] = useState<Set<string>>(new Set());

  // Import options
  const [enableCaption, setEnableCaption] = useState(true);
  const [enableFaces, setEnableFaces] = useState(true);
  const [limitEnabled, setLimitEnabled] = useState(true);
  const [importLimit, setImportLimit] = useState(100);

  // Import progress
  const [importing, setImporting] = useState(false);

  // Child folders cache: prefix -> FolderNode[]
  const [childrenCache, setChildrenCache] = useState<Map<string, FolderNode[]>>(new Map());
  const [childrenImageCounts, setChildrenImageCounts] = useState<Map<string, { imageCount: number; importedCount: number }>>(new Map());
  const [loadingPrefixes, setLoadingPrefixes] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.storage.browse('');
      setRootFolders(
        data.folders.map((f) => ({
          ...f,
          children: null,
          loading: false,
        }))
      );
      setRootImageCount(data.imageCount);
      setRootImportedCount(data.importedCount);
      // Clear caches on refresh
      setChildrenCache(new Map());
      setChildrenImageCounts(new Map());
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Failed to browse storage: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Load children for a folder prefix
  const loadChildren = useCallback(async (prefix: string) => {
    if (childrenCache.has(prefix) || loadingPrefixes.has(prefix)) return;

    setLoadingPrefixes((prev) => new Set(prev).add(prefix));
    try {
      const data = await api.storage.browse(prefix);
      const children: FolderNode[] = data.folders.map((f) => ({
        ...f,
        children: null,
        loading: false,
      }));
      setChildrenCache((prev) => new Map(prev).set(prefix, children));
      setChildrenImageCounts((prev) =>
        new Map(prev).set(prefix, {
          imageCount: data.imageCount,
          importedCount: data.importedCount,
        })
      );
    } catch (err) {
      console.error(`Failed to browse ${prefix}:`, err);
    } finally {
      setLoadingPrefixes((prev) => {
        const next = new Set(prev);
        next.delete(prefix);
        return next;
      });
    }
  }, [childrenCache, loadingPrefixes]);

  // Toggle expand
  const toggleExpand = useCallback((prefix: string) => {
    setExpandedPrefixes((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
        // Trigger lazy load
        loadChildren(prefix);
      }
      return next;
    });
  }, [loadChildren]);

  // Toggle selection
  const toggleSelect = useCallback((prefix: string) => {
    setSelectedPrefixes((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
      }
      return next;
    });
  }, []);

  // Compute gpuMode from toggles
  const getGpuMode = (): GpuMode => {
    if (enableCaption && enableFaces) return 'all';
    if (enableCaption && !enableFaces) return 'caption-only';
    if (!enableCaption && enableFaces) return 'faces-only';
    return 'skip';
  };

  // Import selected folders
  const handleImport = async () => {
    if (selectedPrefixes.size === 0) return;
    setImporting(true);
    setStatus({ type: 'info', message: 'Import started...' });

    const gpuMode = getGpuMode();
    let totalProcessed = 0;
    let totalFailed = 0;
    let totalElapsed = 0;

    try {
      for (const prefix of selectedPrefixes) {
        setStatus({ type: 'info', message: `Importing ${prefix || '(root)'}...` });
        const result = await api.storage.import({
          prefix,
          limit: limitEnabled ? importLimit : 999999,
          sort: 'recent',
          gpuMode,
        });
        totalProcessed += result.processed;
        totalFailed += result.failed;
        totalElapsed += result.elapsedSeconds;
      }

      setStatus({
        type: totalFailed > 0 ? 'error' : 'success',
        message: `Import complete: ${totalProcessed} processed, ${totalFailed} failed (${totalElapsed.toFixed(1)}s)`,
      });

      // Refresh to update counts
      await refresh();
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setImporting(false);
    }
  };

  /* -----------------------------------------------------------------------
     Render folder tree recursively
     ----------------------------------------------------------------------- */

  const renderFolder = (folder: FolderNode, depth: number = 0) => {
    const isExpanded = expandedPrefixes.has(folder.prefix);
    const isSelected = selectedPrefixes.has(folder.prefix);
    const isLoading = loadingPrefixes.has(folder.prefix);
    const children = childrenCache.get(folder.prefix);
    const childImageInfo = childrenImageCounts.get(folder.prefix);

    return (
      <div key={folder.prefix} class="storage-tree-node">
        <div class={`storage-tree-row ${depth === 0 ? 'storage-tree-row--l1' : depth === 1 ? 'storage-tree-row--l2' : 'storage-tree-row--l3'}`}>
          <button
            class="path-tree-toggle"
            onClick={() => toggleExpand(folder.prefix)}
          >
            <span class={`path-tree-caret ${isExpanded ? 'path-tree-caret--open' : ''}`}>
              &#9654;
            </span>
          </button>
          <label class="path-tree-label">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleSelect(folder.prefix)}
            />
            <span class="path-tree-name">{folder.name}/</span>
            <span class="storage-tree-counts">
              <span class="storage-tree-count-total" title="Total images in this folder (recursive)">
                {folder.imageCount}
              </span>
              {folder.missingCount > 0 && (
                <span class="storage-tree-count-missing" title="Images not yet imported">
                  +{folder.missingCount} new
                </span>
              )}
              {folder.missingCount === 0 && folder.imageCount > 0 && (
                <span class="storage-tree-count-ok" title="All images imported">
                  all imported
                </span>
              )}
            </span>
          </label>
        </div>
        {isExpanded && (
          <div class="path-tree-children">
            {isLoading && <div class="storage-tree-loading">Loading...</div>}
            {children && children.length === 0 && !isLoading && childImageInfo && (
              <div class="storage-tree-leaf-info">
                {childImageInfo.imageCount > 0 ? (
                  <span>
                    {childImageInfo.imageCount} images at this level
                    {childImageInfo.imageCount - childImageInfo.importedCount > 0
                      ? ` (${childImageInfo.imageCount - childImageInfo.importedCount} not imported)`
                      : ' (all imported)'}
                  </span>
                ) : (
                  <span class="storage-tree-no-images">No subfolders</span>
                )}
              </div>
            )}
            {children && children.map((child) => renderFolder(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  /* -----------------------------------------------------------------------
     Main render
     ----------------------------------------------------------------------- */

  const selectedCount = selectedPrefixes.size;

  return (
    <div class="app-content">
      <aside class="sidebar">
        <h3 class="sidebar-heading">Settings</h3>
        <nav class="settings-nav">
          <a href="/settings" class="settings-nav-link">General</a>
          <a href="/settings/gpu-logs" class="settings-nav-link">GPU Logs</a>
          <a href="/settings/smart-tags" class="settings-nav-link">Smart Tags</a>
          <a href="/settings/storage" class="settings-nav-link settings-nav-link--active">Storage</a>
        </nav>
      </aside>

      <main class="main-content">
        {loading ? (
          <div class="settings-container">
            {/* Skeleton: Import Options */}
            <div class="settings-section">
              <h2 class="settings-section-title">Import Options</h2>
              <div class="settings-card">
                <div class="storage-skeleton-toggles">
                  <div class="storage-skeleton-toggle">
                    <div class="skeleton-line storage-skeleton-checkbox" />
                    <div class="skeleton-line" style="width: 130px" />
                  </div>
                  <div class="storage-skeleton-toggle">
                    <div class="skeleton-line storage-skeleton-checkbox" />
                    <div class="skeleton-line" style="width: 110px" />
                  </div>
                  <div class="storage-skeleton-toggle">
                    <div class="skeleton-line storage-skeleton-checkbox" />
                    <div class="skeleton-line" style="width: 100px" />
                  </div>
                </div>
                <div>
                  <div class="skeleton-line" style="width: 150px; height: 2rem; border-radius: 6px" />
                </div>
              </div>
            </div>

            {/* Skeleton: S3 Folders */}
            <div class="settings-section">
              <h2 class="settings-section-title">S3 Folders</h2>
              <div class="settings-card">
                {[0.6, 0.4, 0.5, 0.35, 0.55, 0.3].map((w, i) => (
                  <div key={i} class="storage-skeleton-folder-row">
                    <div class="skeleton-line storage-skeleton-caret" />
                    <div class="skeleton-line storage-skeleton-checkbox" />
                    <div class="skeleton-line storage-skeleton-name" style={`width: ${w * 100}%`} />
                    <div class="skeleton-line storage-skeleton-count" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div class="settings-container">
            {/* Import controls */}
            <div class="settings-section">
              <h2 class="settings-section-title">Import Options</h2>
              <div class="settings-card">
                <div class="storage-import-controls">
                  <div class="storage-import-toggles">
                    <label class="storage-toggle">
                      <input
                        type="checkbox"
                        checked={enableCaption}
                        onChange={(e) => setEnableCaption((e.target as HTMLInputElement).checked)}
                        disabled={importing}
                      />
                      <span>Caption Processing</span>
                    </label>
                    <label class="storage-toggle">
                      <input
                        type="checkbox"
                        checked={enableFaces}
                        onChange={(e) => setEnableFaces((e.target as HTMLInputElement).checked)}
                        disabled={importing}
                      />
                      <span>Face Detection</span>
                    </label>
                    <div class="storage-import-limit">
                      <label class="storage-toggle">
                        <input
                          type="checkbox"
                          checked={limitEnabled}
                          onChange={(e) => setLimitEnabled((e.target as HTMLInputElement).checked)}
                          disabled={importing}
                        />
                        <span>Limit per folder</span>
                      </label>
                      {limitEnabled && (
                        <input
                          type="number"
                          class="setting-number-input"
                          value={importLimit}
                          min={1}
                          max={10000}
                          step={50}
                          onInput={(e) => setImportLimit(parseInt((e.target as HTMLInputElement).value) || 100)}
                          disabled={importing}
                        />
                      )}
                    </div>
                  </div>
                  <div class="storage-import-actions">
                    <button
                      class="btn btn-primary"
                      onClick={handleImport}
                      disabled={importing || selectedCount === 0}
                    >
                      {importing ? 'Importing...' : `Import Selected (${selectedCount})`}
                    </button>
                  </div>
                </div>
                {!enableCaption && !enableFaces && (
                  <p class="storage-import-hint">
                    Both caption and face processing are off. Import will only extract EXIF data and generate placeholders.
                  </p>
                )}
              </div>
            </div>

            {status && (
              <div class={`settings-status settings-status--${status.type === 'info' ? 'success' : status.type}`}>
                {status.message}
              </div>
            )}

            {/* Folder tree */}
            <div class="settings-section">
              <div class="storage-section-header">
                <h2 class="settings-section-title">S3 Folders</h2>
                <button
                  class="storage-refresh-btn"
                  onClick={refresh}
                  disabled={importing}
                  title="Refresh folder listing"
                >
                  &#8635;
                </button>
              </div>
              <div class="settings-card">
                {rootImageCount > 0 && (
                  <div class="storage-root-info">
                    <span>{rootImageCount} images at bucket root</span>
                    {rootImageCount - rootImportedCount > 0 && (
                      <span class="storage-tree-count-missing">
                        ({rootImageCount - rootImportedCount} not imported)
                      </span>
                    )}
                  </div>
                )}
                <div class="path-tree">
                  {rootFolders.length === 0 ? (
                    <p class="storage-tree-empty">No folders found in bucket.</p>
                  ) : (
                    rootFolders.map((folder) => renderFolder(folder))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
