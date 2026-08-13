import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api/client';
import type { AutomaticImportStatus, GpuWalletEstimate, StorageFolderInfo } from '../api/client';
import { SettingsSidebar } from './SettingsSidebar';
import type { RoutableProps } from 'preact-router';
import { STORAGE_PATH } from '../routes';

/* =========================================================================
   Types for the folder tree state
   ========================================================================= */

interface FolderNode extends StorageFolderInfo {
  children: FolderNode[] | null; // null = not loaded yet
  loading: boolean;
}

type GpuMode = 'all' | 'caption-only' | 'faces-only' | 'skip';

function normalizeMonitorPrefixes(prefixes: string[]): string[] {
  const sorted = [...new Set(prefixes)].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  return sorted.filter(
    (prefix, index) => !sorted.slice(0, index).some((parent) => prefix.startsWith(parent)),
  );
}

/* =========================================================================
   Component
   ========================================================================= */

export function StorageBrowserPage(_props: RoutableProps) {
  // Top-level browse state
  const [rootFolders, setRootFolders] = useState<FolderNode[]>([]);
  const [bucketName, setBucketName] = useState('');
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
  const [walletEstimate, setWalletEstimate] = useState<GpuWalletEstimate | null>(null);

  // Automatic import configuration and status
  const [automaticImportStatus, setAutomaticImportStatus] = useState<AutomaticImportStatus | null>(null);
  const [automaticInitialMode, setAutomaticInitialMode] = useState<'new_only' | 'all'>('new_only');
  const [automaticGpuMode, setAutomaticGpuMode] = useState<GpuMode>('all');
  const [automaticScanInterval, setAutomaticScanInterval] = useState(10);
  const [automaticSaving, setAutomaticSaving] = useState(false);
  const [automaticScanning, setAutomaticScanning] = useState(false);

  // Child folders cache: prefix -> FolderNode[]
  const [childrenCache, setChildrenCache] = useState<Map<string, FolderNode[]>>(new Map());
  const [childrenImageCounts, setChildrenImageCounts] = useState<Map<string, { imageCount: number; importedCount: number }>>(new Map());
  const [loadingPrefixes, setLoadingPrefixes] = useState<Set<string>>(new Set());

  const hydrateFolderCounts = useCallback(async (prefix: string, forceRefresh: boolean = false) => {
    try {
      const data = await api.storage.browseCounts(prefix, forceRefresh);
      const imageCounts = new Map(data.folders.map((folder) => [folder.prefix, folder.imageCount]));
      const applyCounts = (folders: FolderNode[]): FolderNode[] =>
        folders.map((folder) => {
          const imageCount = imageCounts.get(folder.prefix) ?? 0;
          return {
            ...folder,
            imageCount,
            missingCount: Math.max(0, imageCount - folder.importedCount),
          };
        });

      if (prefix === '') {
        setRootFolders(applyCounts);
      } else {
        setChildrenCache((previous) => {
          const children = previous.get(prefix);
          if (!children) return previous;
          return new Map(previous).set(prefix, applyCounts(children));
        });
      }
    } catch (error) {
      console.warn(`Failed to load image counts for ${prefix || '(root)'}:`, error);
    }
  }, []);

  const refresh = useCallback(async (forceCountRefresh: boolean = false) => {
    setLoading(true);
    try {
      const [data, automaticImport] = await Promise.all([
        api.storage.browse(''),
        api.storage.automaticImportStatus(),
      ]);
      setBucketName(data.bucket);
      setAutomaticImportStatus(automaticImport);
      if (automaticImport.connection) {
        setAutomaticInitialMode(automaticImport.connection.initialImportMode);
        setAutomaticGpuMode(automaticImport.connection.gpuMode);
        setAutomaticScanInterval(automaticImport.connection.scanIntervalMinutes);
      }
      setRootFolders((previousFolders) => {
        const previousByPrefix = new Map(
          previousFolders.map((folder) => [folder.prefix, folder])
        );
        return data.folders.map((folder) => {
          const previous = previousByPrefix.get(folder.prefix);
          if (!previous || previous.imageCount === null) {
            return { ...folder, children: null, loading: false };
          }
          return {
            ...folder,
            imageCount: previous.imageCount,
            missingCount: Math.max(0, previous.imageCount - folder.importedCount),
            children: null,
            loading: false,
          };
        });
      });
      setRootImageCount(data.imageCount);
      setRootImportedCount(data.importedCount);
      // Clear caches on refresh
      setChildrenCache(new Map());
      setChildrenImageCounts(new Map());
      void hydrateFolderCounts('', forceCountRefresh);
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Failed to browse storage: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setLoading(false);
    }
  }, [hydrateFolderCounts]);

  useEffect(() => {
    void refresh();
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
      void hydrateFolderCounts(prefix);
    } catch (err) {
      console.error(`Failed to browse ${prefix}:`, err);
    } finally {
      setLoadingPrefixes((prev) => {
        const next = new Set(prev);
        next.delete(prefix);
        return next;
      });
    }
  }, [childrenCache, hydrateFolderCounts, loadingPrefixes]);

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
        if (prefix === '') return new Set(['']);
        next.delete('');
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

  const selectedPhotoCount = Array.from(selectedPrefixes).reduce((total, prefix) => {
    const missing = prefix === ''
      ? Math.max(0, rootImageCount - rootImportedCount)
      : [...rootFolders, ...Array.from(childrenCache.values()).flat()]
          .find((folder) => folder.prefix === prefix)?.missingCount ?? 0;
    return total + Math.min(missing, limitEnabled ? importLimit : Number.MAX_SAFE_INTEGER);
  }, 0);

  useEffect(() => {
    const gpuMode = getGpuMode();
    if (selectedPhotoCount === 0 || gpuMode === 'skip') {
      setWalletEstimate(null);
      return;
    }
    let cancelled = false;
    void api.gpu.estimate(selectedPhotoCount, gpuMode)
      .then((result) => {
        if (!cancelled) setWalletEstimate(result.estimate);
      })
      .catch(() => {
        if (!cancelled) setWalletEstimate(null);
      });
    return () => { cancelled = true; };
  }, [selectedPhotoCount, enableCaption, enableFaces]);

  // Import selected folders
  const handleImport = async () => {
    if (selectedPrefixes.size === 0) return;
    setImporting(true);
    setStatus({ type: 'info', message: 'Import started...' });

    const gpuMode = getGpuMode();

    try {
      const queuedJobIds: string[] = [];
      let immediatelyProcessed = 0;
      let immediatelyFailed = 0;
      for (const prefix of selectedPrefixes) {
        setStatus({ type: 'info', message: `Queueing ${prefix || '(root)'}...` });
        const result = await api.storage.import({
          prefix,
          limit: limitEnabled ? importLimit : 999999,
          sort: 'recent',
          gpuMode,
        });
        if (result.jobId) queuedJobIds.push(result.jobId);
        immediatelyProcessed += result.processed;
        immediatelyFailed += result.failed;
      }

      if (queuedJobIds.length === 0) {
        setStatus({
          type: immediatelyFailed > 0 ? 'error' : 'success',
          message: immediatelyProcessed > 0
            ? `Import complete: ${immediatelyProcessed} processed, ${immediatelyFailed} failed`
            : 'All selected photos are already imported.',
        });
        await refresh();
        return;
      }

      // Polling is presentation only: jobs continue from their durable queue
      // if this page is closed, the request disconnects, or the app restarts.
      while (true) {
        const jobs = await Promise.all(
          queuedJobIds.map((jobId) => api.storage.getImportJob(jobId))
        );
        const processed = jobs.reduce((sum, job) => sum + job.photosSucceeded, 0);
        const failed = jobs.reduce((sum, job) => sum + job.photosFailed, 0);
        const total = jobs.reduce((sum, job) => sum + job.photoCount, 0);
        const terminal = jobs.every(
          (job) => job.status === 'completed' || job.status === 'failed'
        );

        if (terminal) {
          const terminalErrors = jobs
            .filter((job) => job.status === 'failed' && job.lastError)
            .map((job) => job.lastError);
          setStatus({
            type: failed > 0 || terminalErrors.length > 0 ? 'error' : 'success',
            message: terminalErrors.length > 0
              ? `Import stopped: ${processed} processed, ${failed} failed. ${terminalErrors[0]}`
              : `Import complete: ${processed} processed, ${failed} failed`,
          });
          break;
        }

        const running = jobs.filter((job) => job.status === 'running').length;
        setStatus({
          type: 'info',
          message: `Durable import ${running > 0 ? 'processing' : 'queued'}: ${processed + failed}/${total}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }

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

  const refreshAutomaticImportStatus = async () => {
    const next = await api.storage.automaticImportStatus();
    setAutomaticImportStatus(next);
    return next;
  };

  const saveAutomaticImportConfig = async (prefixes: string[], enabled: boolean) => {
    await api.settings.update({
      auto_import_enabled: enabled ? 'true' : 'false',
      auto_import_prefixes: prefixes.join(','),
      auto_import_initial_mode: automaticInitialMode,
      auto_import_gpu_mode: automaticGpuMode,
      auto_import_scan_interval_minutes: String(automaticScanInterval),
    });
    return refreshAutomaticImportStatus();
  };

  const handleSaveAutomaticImport = async () => {
    if (selectedPrefixes.size === 0) return;
    setAutomaticSaving(true);
    setStatus(null);
    try {
      const connection = automaticImportStatus?.connection;
      const selected = Array.from(selectedPrefixes);
      const wholeBucketSelected = selectedPrefixes.has('');
      const alreadyWatchingWholeBucket = connection?.enabled && connection.allowedPrefixes.length === 0;
      const existing = connection?.enabled ? connection.allowedPrefixes : [];
      const prefixes = wholeBucketSelected || alreadyWatchingWholeBucket
        ? []
        : normalizeMonitorPrefixes([...existing, ...selected]);
      await saveAutomaticImportConfig(prefixes, true);
      setSelectedPrefixes(new Set());
      setStatus({
        type: 'success',
        message: prefixes.length === 0
          ? 'The entire bucket is monitored automatically.'
          : `Added selected paths. ${prefixes.length} monitor${prefixes.length === 1 ? ' is' : 's are'} active.`,
      });
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Failed to save automatic folders: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setAutomaticSaving(false);
    }
  };

  const handleSaveAutomaticOptions = async () => {
    const connection = automaticImportStatus?.connection;
    if (!connection?.enabled) return;
    setAutomaticSaving(true);
    setStatus(null);
    try {
      await saveAutomaticImportConfig(connection.allowedPrefixes, true);
      setStatus({ type: 'success', message: 'Automatic monitor settings updated.' });
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Failed to update monitor settings: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setAutomaticSaving(false);
    }
  };

  const handleRemoveAutomaticMonitor = async (prefix: string) => {
    const connection = automaticImportStatus?.connection;
    if (!connection?.enabled) return;
    setAutomaticSaving(true);
    setStatus(null);
    try {
      if (prefix === '' || connection.allowedPrefixes.length <= 1) {
        await saveAutomaticImportConfig([], false);
        setStatus({ type: 'success', message: 'The last automatic monitor was removed.' });
      } else {
        const remaining = connection.allowedPrefixes.filter((candidate) => candidate !== prefix);
        await saveAutomaticImportConfig(remaining, true);
        setStatus({
          type: 'success',
          message: `Monitor removed. ${remaining.length} monitor${remaining.length === 1 ? ' remains' : 's remain'}.`,
        });
      }
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Failed to remove monitor: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setAutomaticSaving(false);
    }
  };

  const handleDisableAutomaticImport = async () => {
    setAutomaticSaving(true);
    setStatus(null);
    try {
      await saveAutomaticImportConfig([], false);
      setStatus({ type: 'success', message: 'All automatic monitors stopped.' });
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Failed to stop automatic import: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setAutomaticSaving(false);
    }
  };

  const handleAutomaticScan = async () => {
    setAutomaticScanning(true);
    setStatus(null);
    try {
      await api.storage.reconcile();
      await refreshAutomaticImportStatus();
      setStatus({ type: 'success', message: 'Automatic import scan scheduled.' });
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Failed to schedule scan: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setAutomaticScanning(false);
    }
  };

  const isAutomaticallyMonitored = (prefix: string): boolean => {
    const connection = automaticImportStatus?.connection;
    if (!connection?.enabled) return false;
    if (connection.allowedPrefixes.length === 0) return true;
    return connection.allowedPrefixes.some(
      (allowed) => prefix === allowed || prefix.startsWith(allowed)
    );
  };

  const containsAutomaticallyMonitoredPath = (prefix: string): boolean => {
    const connection = automaticImportStatus?.connection;
    if (!connection?.enabled || connection.allowedPrefixes.length === 0) return false;
    return connection.allowedPrefixes.some((allowed) => allowed.startsWith(prefix));
  };

  /* -----------------------------------------------------------------------
     Render folder tree recursively
     ----------------------------------------------------------------------- */

  const renderFolder = (folder: FolderNode, depth: number = 0) => {
    const isExpanded = expandedPrefixes.has(folder.prefix);
    const isSelected = selectedPrefixes.has(folder.prefix);
    const isLoading = loadingPrefixes.has(folder.prefix);
    const isMonitored = isAutomaticallyMonitored(folder.prefix);
    const containsMonitoredPath = !isMonitored && containsAutomaticallyMonitoredPath(folder.prefix);
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
              {folder.imageCount !== null && (
                <span class="storage-tree-count-total" title="Total images in this folder and its subfolders">
                  {folder.imageCount}
                </span>
              )}
              {folder.missingCount !== null && folder.missingCount > 0 && (
                <span class="storage-tree-count-missing" title="Images not yet imported from this folder and its subfolders">
                  +{folder.missingCount} new
                </span>
              )}
              {folder.missingCount === 0 && folder.imageCount !== null && folder.imageCount > 0 && (
                <span class="storage-tree-count-ok" title="All images imported">
                  all imported
                </span>
              )}
              {folder.imageCount === null && (
                <span class="storage-tree-count-total" title="Counting images in the background">
                  {folder.importedCount > 0 ? `${folder.importedCount} imported · ` : ''}counting…
                </span>
              )}
              {isMonitored && (
                <span class="storage-tree-auto" title="New photos in this folder are imported automatically">
                  automatic
                </span>
              )}
              {containsMonitoredPath && (
                <span class="storage-tree-auto storage-tree-auto--partial" title="A nested folder is imported automatically">
                  automatic inside
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
      <SettingsSidebar activePath={STORAGE_PATH} />

      <main class="main-content">
        <div class="settings-container">
            {/* Automatic import controls */}
            <div class="settings-section">
              <h2 class="settings-section-title">Automatic Import</h2>
              <div class="settings-card">
                <div class="storage-auto-status">
                  <div>
                    <strong>
                      {automaticImportStatus?.connection?.enabled
                        ? automaticImportStatus.connection.allowedPrefixes.length === 0
                          ? '1 monitor active'
                          : `${automaticImportStatus.connection.allowedPrefixes.length} monitor${automaticImportStatus.connection.allowedPrefixes.length === 1 ? '' : 's'} active`
                        : 'No active monitors'}
                    </strong>
                    <p class="storage-import-hint">
                      {automaticImportStatus?.connection?.enabled
                        ? automaticImportStatus.connection.allowedPrefixes.length === 0
                          ? `Watching the entire ${automaticImportStatus.connection.bucket} bucket.`
                          : 'Each path below is an active monitor. Processing and scan settings apply to all monitors.'
                        : 'Select the bucket or one or more folders below, then add them as monitors.'}
                    </p>
                    {automaticImportStatus?.connection?.enabled && (
                      <div class="storage-monitor-list">
                        {(automaticImportStatus.connection.allowedPrefixes.length === 0
                          ? ['']
                          : automaticImportStatus.connection.allowedPrefixes
                        ).map((prefix) => (
                          <div key={prefix || '__bucket__'} class="storage-monitor-item">
                            <span class="storage-monitor-indicator" aria-hidden="true" />
                            <span class="storage-monitor-path">
                              {prefix || `${automaticImportStatus.connection?.bucket ?? 'Bucket'} (entire bucket)`}
                            </span>
                            <button
                              type="button"
                              class="storage-monitor-remove"
                              onClick={() => handleRemoveAutomaticMonitor(prefix)}
                              disabled={automaticSaving || automaticScanning}
                              title={`Remove monitor for ${prefix || 'the entire bucket'}`}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {automaticImportStatus?.connection?.lastError && (
                      <p class="storage-auto-error">Last scan error: {automaticImportStatus.connection.lastError}</p>
                    )}
                    {automaticImportStatus?.connection?.lastReconciledAt && (
                      <p class="storage-import-hint">
                        Last scan: {new Date(automaticImportStatus.connection.lastReconciledAt).toLocaleString()}
                      </p>
                    )}
                    <p class="storage-import-hint">
                      Queue: {automaticImportStatus?.jobs.pending ?? 0} pending, {automaticImportStatus?.jobs.running ?? 0} processing, {automaticImportStatus?.jobs.failed ?? 0} failed, {automaticImportStatus?.jobs.completed ?? 0} completed
                    </p>
                  </div>
                  <div class={`storage-auto-state ${automaticImportStatus?.connection?.enabled ? 'storage-auto-state--active' : ''}`}>
                    {automaticImportStatus?.connection?.enabled ? 'Active' : 'Stopped'}
                  </div>
                </div>

                <div class="storage-auto-options">
                  <label>
                    <span>First scan</span>
                    <select
                      class="setting-text-input"
                      value={automaticInitialMode}
                      onChange={(e) => setAutomaticInitialMode((e.target as HTMLSelectElement).value as 'new_only' | 'all')}
                      disabled={automaticSaving}
                    >
                      <option value="new_only">Only photos added after setup</option>
                      <option value="all">Import existing photos too</option>
                    </select>
                  </label>
                  <label>
                    <span>Processing</span>
                    <select
                      class="setting-text-input"
                      value={automaticGpuMode}
                      onChange={(e) => setAutomaticGpuMode((e.target as HTMLSelectElement).value as GpuMode)}
                      disabled={automaticSaving}
                    >
                      <option value="all">Captions and faces</option>
                      <option value="caption-only">Captions only</option>
                      <option value="faces-only">Faces only</option>
                      <option value="skip">Metadata only</option>
                    </select>
                  </label>
                  <label>
                    <span>Scan every</span>
                    <div class="storage-auto-interval">
                      <input
                        type="number"
                        class="setting-number-input"
                        value={automaticScanInterval}
                        min={1}
                        max={10080}
                        onInput={(e) => setAutomaticScanInterval(Math.min(10080, Math.max(1, parseInt((e.target as HTMLInputElement).value) || 10)))}
                        disabled={automaticSaving}
                      />
                      <span>minutes</span>
                    </div>
                  </label>
                </div>

                <p class="storage-import-hint">
                  Folder checkboxes below are used for both actions. Adding selected monitors keeps all existing monitors active.
                  Selecting the entire bucket replaces path-specific coverage because it already includes every folder.
                </p>
                <div class="storage-import-actions storage-auto-actions">
                  <button
                    class="btn btn-primary"
                    onClick={handleSaveAutomaticImport}
                    disabled={automaticSaving || selectedCount === 0}
                  >
                    {automaticSaving ? 'Saving...' : `Add Selected Monitors (${selectedCount})`}
                  </button>
                  {automaticImportStatus?.connection?.enabled && (
                    <>
                      <button
                        class="btn btn-secondary"
                        onClick={handleSaveAutomaticOptions}
                        disabled={automaticSaving || automaticScanning}
                      >
                        Save Monitor Settings
                      </button>
                      <button
                        class="btn btn-secondary"
                        onClick={handleAutomaticScan}
                        disabled={automaticSaving || automaticScanning}
                      >
                        {automaticScanning ? 'Scheduling...' : 'Scan Now'}
                      </button>
                      <button
                        class="btn btn-secondary storage-auto-stop"
                        onClick={handleDisableAutomaticImport}
                        disabled={automaticSaving || automaticScanning}
                      >
                        Stop All Monitors
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* One-time import controls */}
            <div class="settings-section">
              <h2 class="settings-section-title">One-time Import</h2>
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
                      disabled={importing || selectedCount === 0 || walletEstimate?.sufficient === false}
                    >
                      {importing ? 'Importing...' : `Import Selected Once (${selectedCount})`}
                    </button>
                  </div>
                </div>
                {walletEstimate && (
                  <p class="storage-import-hint">
                    Estimated GPU reservation: {new Intl.NumberFormat(undefined, {
                      style: 'currency',
                      currency: walletEstimate.currency,
                    }).format(Number(walletEstimate.estimatedMicros) / 1_000_000)} via {walletEstimate.provider}
                    {!walletEstimate.sufficient && (
                      <> · insufficient allowance. <a href="/profile">Open your wallet</a>.</>
                    )}
                  </p>
                )}
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
                  onClick={() => refresh(true)}
                  disabled={importing || loading}
                  title="Refresh folder listing"
                >
                  &#8635;
                </button>
              </div>
              <div class="settings-card">
                <p class="storage-import-hint storage-tree-instructions">
                  Select the whole bucket or individual folders, then choose automatic monitoring or a one-time import above.
                </p>
                <label class="storage-root-info storage-root-select">
                  <input
                    type="checkbox"
                    checked={selectedPrefixes.has('')}
                    onChange={() => toggleSelect('')}
                  />
                  <strong>{bucketName || 'Bucket'} (entire bucket)</strong>
                  <span class="storage-tree-counts">
                    {rootImageCount > 0 && <span>{rootImageCount} images at bucket root</span>}
                    {rootImageCount - rootImportedCount > 0 && (
                      <span class="storage-tree-count-missing">
                        {rootImageCount - rootImportedCount} not imported
                      </span>
                    )}
                    {isAutomaticallyMonitored('') && (
                      <span class="storage-tree-auto">automatic</span>
                    )}
                  </span>
                </label>
                <div class="path-tree">
                  {!loading && rootFolders.length === 0 ? (
                    <p class="storage-tree-empty">No folders found in bucket.</p>
                  ) : (
                    rootFolders.map((folder) => renderFolder(folder))
                  )}
                </div>
              </div>
            </div>
          </div>
      </main>
    </div>
  );
}
