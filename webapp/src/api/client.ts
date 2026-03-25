const API_BASE = '/api/v1';

export interface Photo {
  id: string;
  fullImageUrl: string;
  placeholder: string | null;
  takenAt: string | null;
  description: string | null;
  width: number | null;
  height: number | null;
  faceCount: number;
  tags: string[];
  location: {
    lat: number;
    lng: number;
    name: string | null;
  } | null;
}

export interface PhotoListResponse {
  photos: Photo[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export interface Person {
  id: string;
  name: string;
  faceCount: number;
}

export interface Tag {
  id: string;
  name: string;
}

export interface Face {
  id: string;
  photoId: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface PhotoFilters {
  search?: string;
  tag?: string;
  person?: string;
  smartTag?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface TimelineGroup {
  year: number | null;
  month: number | null;
  count: number;
}

export interface TimelineResponse {
  groups: TimelineGroup[];
  total: number;
}

export type ClusterStrategy = 'first' | 'average';

export interface Cluster {
  id: string;
  faceCount: number;
  personId: string | null;
  personName: string | null;
  representativeFace: {
    faceId: string;
    photoId: string;
    boundingBox: { x: number; y: number; width: number; height: number };
  } | null;
}

export interface ClusterFace {
  id: string;
  photoId: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  photoWidth: number | null;
  photoHeight: number | null;
}

export interface ClusteringResult {
  clustered: number;
  newClusters: number;
}

export interface ReclusterResult {
  totalClusters: number;
  namedPreserved: number;
  newClusters: number;
}

export interface GpuLog {
  id: string;
  parentId: string | null;
  type: string;
  provider: string | null;
  gpuMode: string | null;
  photoId: string | null;
  s3Path: string | null;
  status: 'running' | 'completed' | 'failed';
  photoCount: number | null;
  photosSucceeded: number | null;
  photosFailed: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  childrenCount: number;
}

export interface GpuLogListResponse {
  logs: GpuLog[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export interface GpuLogDetailResponse {
  log: GpuLog;
  children: GpuLog[];
}

export interface GpuLogFilters {
  type?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface SmartTag {
  id: string;
  label: string;
  field: string;
  values: string[];
  rule: string; // 'any' | 'all' | 'none'
  sortOrder: number;
  photoCount: number;
  createdAt: string;
}

export interface PathFacetEntry {
  level1: string;
  level2: string | null;
  level3: string | null;
  count: number;
}

export interface DateFacetEntry {
  year: number;
  month: number | null;
  count: number;
}

export interface TextFacetEntry {
  value: string;
  count: number;
}

export type FacetsResponse =
  | { type: 'path'; facets: PathFacetEntry[] }
  | { type: 'date'; facets: DateFacetEntry[] }
  | { type: 'text'; facets: TextFacetEntry[] };

export interface StorageFolderInfo {
  prefix: string;
  name: string;
  imageCount: number;
  importedCount: number;
  missingCount: number;
}

export interface StorageBrowseResponse {
  bucket: string;
  prefix: string;
  folders: StorageFolderInfo[];
  imageCount: number;
  importedCount: number;
  missingCount: number;
}

export interface ImportOptions {
  prefix: string;
  limit?: number;
  sort?: string;
  gpuMode?: 'all' | 'caption-only' | 'faces-only' | 'skip';
}

export interface ImportResult {
  bucket: string;
  prefix: string;
  totalImages: number;
  alreadyImported: number;
  processed: number;
  failed: number;
  remaining: number;
  elapsedSeconds: number;
  photosPerSecond: number;
}

// ---------------------------------------------------------------------------
// Reprocess stats types
// ---------------------------------------------------------------------------

export interface PipelineStats {
  versions: Record<string, number>;
  latestVersion: string;
  outdated: number;
  changelog: Record<string, string>;
}

export interface ReprocessStatsResponse {
  totalPhotos: number;
  pathPrefix: string | null;
  process: PipelineStats;
  caption: PipelineStats;
  faces: PipelineStats;
  estimates: {
    gpuEnabled: boolean;
    provider: string;
    secsPerPhoto: number;
    costPerHour: number;
  };
}

export interface ReprocessTriggerResponse {
  mode: string;
  currentVersions: {
    process: string;
    caption: string;
    faces: string;
  };
  reprocessed: number;
  failed: number;
  elapsedSeconds: number;
  results: Array<{
    id: string;
    s3Path: string;
    success: boolean;
    error?: string;
  }>;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (response.status === 401) {
    // Session expired or not authenticated - redirect to login
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

export const api = {
  photos: {
    list: (filters: PhotoFilters = {}): Promise<PhotoListResponse> => {
      const params = new URLSearchParams();
      if (filters.search) params.set('q', filters.search);
      if (filters.tag) params.set('tag', filters.tag);
      if (filters.person) params.set('person', filters.person);
      if (filters.smartTag) params.set('smartTag', filters.smartTag);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.page) params.set('page', String(filters.page));
      if (filters.limit) params.set('limit', String(filters.limit));

      const query = params.toString();
      return fetchJson<PhotoListResponse>(`${API_BASE}/photos${query ? `?${query}` : ''}`);
    },

    get: (id: string): Promise<Photo> => {
      return fetchJson<Photo>(`${API_BASE}/photos/${id}`);
    },

    getFaces: (id: string): Promise<{ faces: Face[] }> => {
      return fetchJson<{ faces: Face[] }>(`${API_BASE}/photos/${id}/faces`);
    },

    getFullImageUrl: async (id: string): Promise<string> => {
      const result = await fetchJson<{ url: string }>(`${API_BASE}/photos/${id}/image`);
      return result.url;
    },

    timeline: (filters: Omit<PhotoFilters, 'page' | 'limit'> = {}): Promise<TimelineResponse> => {
      const params = new URLSearchParams();
      if (filters.search) params.set('q', filters.search);
      if (filters.tag) params.set('tag', filters.tag);
      if (filters.person) params.set('person', filters.person);
      if (filters.smartTag) params.set('smartTag', filters.smartTag);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);

      const query = params.toString();
      return fetchJson<TimelineResponse>(`${API_BASE}/photos/timeline${query ? `?${query}` : ''}`);
    },
  },

  persons: {
    list: (): Promise<{ persons: Person[] }> => {
      return fetchJson<{ persons: Person[] }>(`${API_BASE}/persons`);
    },

    get: (id: string): Promise<Person> => {
      return fetchJson<Person>(`${API_BASE}/persons/${id}`);
    },

    getPhotos: (id: string): Promise<{ photos: Photo[] }> => {
      return fetchJson<{ photos: Photo[] }>(`${API_BASE}/persons/${id}/photos`);
    },

    create: (name: string): Promise<{ id: string; name: string }> => {
      return fetchJson<{ id: string; name: string }>(`${API_BASE}/persons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    },

    getUnassignedFaces: (limit = 50): Promise<{ faces: Face[] }> => {
      return fetchJson<{ faces: Face[] }>(`${API_BASE}/persons/unassigned-faces?limit=${limit}`);
    },

    assignFace: (faceId: string, personId: string | null): Promise<void> => {
      return fetchJson<void>(`${API_BASE}/persons/faces/${faceId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId }),
      });
    },
  },

  tags: {
    list: (): Promise<{ tags: Tag[] }> => {
      return fetchJson<{ tags: Tag[] }>(`${API_BASE}/tags`);
    },
  },

  clusters: {
    list: (): Promise<{ clusters: Cluster[] }> => {
      return fetchJson<{ clusters: Cluster[] }>(`${API_BASE}/clusters`);
    },

    getUnassigned: (): Promise<{ faces: ClusterFace[] }> => {
      return fetchJson<{ faces: ClusterFace[] }>(`${API_BASE}/clusters/unassigned`);
    },

    getFaces: (clusterId: string): Promise<{ faces: ClusterFace[] }> => {
      return fetchJson<{ faces: ClusterFace[] }>(`${API_BASE}/clusters/${clusterId}/faces`);
    },

    create: (faceId: string): Promise<{ id: string; faceCount: number }> => {
      return fetchJson<{ id: string; faceCount: number }>(`${API_BASE}/clusters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faceId }),
      });
    },

    run: (opts?: { threshold?: number; strategy?: ClusterStrategy }): Promise<ClusteringResult> => {
      return fetchJson<ClusteringResult>(`${API_BASE}/clusters/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts ?? {}),
      });
    },

    recluster: (opts: { threshold: number; strategy: ClusterStrategy }): Promise<ReclusterResult> => {
      return fetchJson<ReclusterResult>(`${API_BASE}/clusters/recluster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
    },

    name: (clusterId: string, name: string): Promise<{ personId: string }> => {
      return fetchJson<{ personId: string }>(`${API_BASE}/clusters/${clusterId}/name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    },

    rename: (clusterId: string, name: string): Promise<void> => {
      return fetchJson<void>(`${API_BASE}/clusters/${clusterId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    },

    assignFace: (clusterId: string, faceId: string): Promise<void> => {
      return fetchJson<void>(`${API_BASE}/clusters/${clusterId}/faces/${faceId}`, {
        method: 'POST',
      });
    },

    removeFace: (clusterId: string, faceId: string): Promise<void> => {
      return fetchJson<void>(`${API_BASE}/clusters/${clusterId}/faces/${faceId}`, {
        method: 'DELETE',
      });
    },
  },

  settings: {
    get: (): Promise<Record<string, string>> => {
      return fetchJson<Record<string, string>>(`${API_BASE}/settings`);
    },

    update: (settings: Record<string, string>): Promise<Record<string, string>> => {
      return fetchJson<Record<string, string>>(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
    },

    getS3Config: (): Promise<Record<string, { envValue: string | null; effectiveValue: string | null; effectiveSource: 'db' | 'env' | null }>> => {
      return fetchJson<Record<string, { envValue: string | null; effectiveValue: string | null; effectiveSource: 'db' | 'env' | null }>>(`${API_BASE}/settings/s3`);
    },
  },

  gpuLogs: {
    list: (filters: GpuLogFilters = {}): Promise<GpuLogListResponse> => {
      const params = new URLSearchParams();
      if (filters.type) params.set('type', filters.type);
      if (filters.status) params.set('status', filters.status);
      if (filters.page) params.set('page', String(filters.page));
      if (filters.limit) params.set('limit', String(filters.limit));

      const query = params.toString();
      return fetchJson<GpuLogListResponse>(`${API_BASE}/gpu-logs${query ? `?${query}` : ''}`);
    },

    get: (id: string): Promise<GpuLogDetailResponse> => {
      return fetchJson<GpuLogDetailResponse>(`${API_BASE}/gpu-logs/${id}`);
    },

    getChildren: (id: string): Promise<{ children: GpuLog[] }> => {
      return fetchJson<{ children: GpuLog[] }>(`${API_BASE}/gpu-logs/${id}/children`);
    },
  },

  smartTags: {
    list: (): Promise<{ smartTags: SmartTag[] }> => {
      return fetchJson<{ smartTags: SmartTag[] }>(`${API_BASE}/smart-tags`);
    },

    create: (data: { label: string; field: string; values: string[]; rule: string; sortOrder?: number }): Promise<SmartTag> => {
      return fetchJson<SmartTag>(`${API_BASE}/smart-tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    },

    update: (id: string, data: { label?: string; field?: string; values?: string[]; rule?: string; sortOrder?: number }): Promise<SmartTag> => {
      return fetchJson<SmartTag>(`${API_BASE}/smart-tags/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    },

    delete: (id: string): Promise<{ ok: boolean }> => {
      return fetchJson<{ ok: boolean }>(`${API_BASE}/smart-tags/${id}`, {
        method: 'DELETE',
      });
    },

    fields: (): Promise<{ fields: string[] }> => {
      return fetchJson<{ fields: string[] }>(`${API_BASE}/smart-tags/fields`);
    },

    facets: (field: string): Promise<FacetsResponse> => {
      return fetchJson<FacetsResponse>(`${API_BASE}/smart-tags/facets?field=${encodeURIComponent(field)}`);
    },
  },

  storage: {
    browse: (prefix: string = ''): Promise<StorageBrowseResponse> => {
      const params = new URLSearchParams();
      if (prefix) params.set('prefix', prefix);
      const query = params.toString();
      return fetchJson<StorageBrowseResponse>(`${API_BASE}/storage/browse${query ? `?${query}` : ''}`);
    },

    import: (options: ImportOptions): Promise<ImportResult> => {
      return fetchJson<ImportResult>(`${API_BASE}/photos/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
    },

    importPreview: (prefix: string = '', limit: number = 100): Promise<{
      bucket: string;
      prefix: string;
      totalObjects: number;
      totalImages: number;
      alreadyImported: number;
      toImport: number;
      remainingAfterLimit: number;
      estimatedTime: string;
      keys: string[];
    }> => {
      const params = new URLSearchParams();
      if (prefix) params.set('prefix', prefix);
      params.set('limit', String(limit));
      return fetchJson(`${API_BASE}/photos/import?${params.toString()}`);
    },

    reprocess: (options: { mode?: string; force?: boolean; gpuMode?: string; pathPrefix?: string }): Promise<unknown> => {
      return fetchJson(`${API_BASE}/photos/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
    },
  },

  reprocess: {
    getStats: (pathPrefix?: string): Promise<ReprocessStatsResponse> => {
      const params = new URLSearchParams();
      if (pathPrefix) params.set('pathPrefix', pathPrefix);
      const query = params.toString();
      return fetchJson<ReprocessStatsResponse>(`${API_BASE}/photos/reprocess/stats${query ? `?${query}` : ''}`);
    },

    trigger: (options: { mode?: string; force?: boolean; pathPrefix?: string }): Promise<ReprocessTriggerResponse> => {
      return fetchJson<ReprocessTriggerResponse>(`${API_BASE}/photos/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
    },
  },
};
