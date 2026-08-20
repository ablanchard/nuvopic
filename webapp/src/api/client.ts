const API_BASE = '/api/v1';

export type DeployMode = 'standalone' | 'managed';

export interface RuntimeConfig {
  deployMode: DeployMode;
  managedTokenEndpoint: string | null;
  profilePath: string | null;
  adminPath: string | null;
  storageSetupPath: string;
}

export interface RuntimeSession {
  deployMode: DeployMode;
  role: string;
  subject: string;
  workspaceId: string | null;
  storageConfigured: boolean;
  storageSetupPath: string;
  profilePath: string | null;
  adminPath: string | null;
}

export interface Photo {
  id: string;
  fullImageUrl: string;
  thumbnailUrl: string;
  placeholder: string | null;
  takenAt: string | null;
  dateUnknown: boolean;
  datePrecision: 'exact' | 'day' | 'month' | 'year' | 'unknown';
  dateSource: 'exif' | 'filename' | 'path' | 'manual' | 'legacy' | 'unknown';
  description: string | null;
  width: number | null;
  height: number | null;
  faceCount: number;
  tags: string[];
  location: {
    lat: number;
    lng: number;
    name: string | null;
    region: string | null;
    country: string | null;
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
  dateUnknown?: boolean;
  city?: string;
  region?: string;
  country?: string;
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

export interface LocationFacet {
  city: string;
  region: string | null;
  country: string;
  count: number;
}

export interface LocationFacetsResponse {
  facets: LocationFacet[];
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
  confidence: number | null;
  area: number;
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
  status: 'running' | 'completed' | 'failed' | 'queued' | 'duplicate' | 'baseline' | 'unsupported';
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
  rule: string;
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
  imageCount: number | null;
  importedCount: number;
  missingCount: number | null;
}

export interface StorageBrowseResponse {
  bucket: string;
  prefix: string;
  folders: StorageFolderInfo[];
  imageCount: number;
  importedCount: number;
  missingCount: number;
}

export interface StorageBrowseCountsResponse {
  prefix: string;
  imageCount: number;
  folders: Array<{
    prefix: string;
    imageCount: number;
  }>;
}

export interface AutomaticImportStatus {
  connection: {
    provider: string;
    bucket: string;
    allowedPrefixes: string[];
    enabled: boolean;
    initialImportMode: 'new_only' | 'all';
    gpuMode: 'all' | 'caption-only' | 'faces-only' | 'skip';
    scanIntervalMinutes: number;
    baselineCompleted: boolean;
    lastReconciledAt: string | null;
    nextReconciliationAt: string | null;
    lastError: string | null;
  } | null;
  jobs: Partial<Record<'pending' | 'running' | 'completed' | 'failed', number>>;
  lastRun: {
    id: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: string;
    completedAt: string | null;
    objectCount: number;
    queuedCount: number;
    error: string | null;
  } | null;
}

export interface ImportOptions {
  prefix: string;
  limit?: number;
  sort?: string;
  gpuMode?: 'all' | 'caption-only' | 'faces-only' | 'skip';
}

export interface ImportResult {
  jobId: string | null;
  logId: string | null;
  status: 'queued' | 'completed';
  provider: string;
  bucket: string;
  prefix: string;
  totalImages: number;
  alreadyImported: number;
  photoCount: number;
  processed: number;
  failed: number;
  remaining: number;
  elapsedSeconds: number;
  photosPerSecond: number;
}

export interface ManualImportJobResponse {
  id: string;
  logId: string | null;
  bucket: string;
  prefix: string;
  sort: 'recent' | 'oldest';
  gpuMode: 'all' | 'caption-only' | 'faces-only' | 'skip';
  provider: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  totalImages: number;
  alreadyImported: number;
  photoCount: number;
  photosSucceeded: number;
  photosFailed: number;
  remaining: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PipelineStats {
  versions: Record<string, number>;
  latestVersion: string;
  outdated: number;
  changelog: Record<string, string>;
}

export interface GpuWalletEstimate {
  currency: string;
  provider: 'modal' | 'vastai';
  priceCatalogVersion: string;
  estimatedMicros: string;
  availableMicros: string;
  sufficient: boolean;
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
    wallet: {
      all: GpuWalletEstimate | null;
      caption: GpuWalletEstimate | null;
      faces: GpuWalletEstimate | null;
    };
  };
}

export interface ReprocessTriggerResponse {
  jobId: string | null;
  logId: string | null;
  status: 'queued' | 'completed';
  mode: string;
  gpuMode: string;
  provider?: string;
  photoCount: number;
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

export interface ReprocessJobResponse {
  id: string;
  logId: string | null;
  mode: string;
  gpuMode: string;
  provider: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  photoCount: number;
  photosSucceeded: number;
  photosFailed: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

type S3ConfigResponse = Record<
  string,
  { envValue: string | null; effectiveValue: string | null; effectiveSource: 'db' | 'env' | null }
>;

interface ManagedTokenResponse {
  token?: string;
  accessToken?: string;
}

let runtimeConfig: RuntimeConfig = {
  deployMode: 'standalone',
  managedTokenEndpoint: null,
  profilePath: null,
  adminPath: null,
  storageSetupPath: '/app/setup/storage',
};
let managedToken: string | null = null;
let managedTokenPromise: Promise<string> | null = null;

export function configureApiRuntime(config: RuntimeConfig) {
  runtimeConfig = config;
  managedToken = null;
  managedTokenPromise = null;
}

function redirectToAuthSurface() {
  window.location.href =
    runtimeConfig.deployMode === 'managed'
      ? (runtimeConfig.profilePath ?? '/profile')
      : '/login';
}

async function parseError(response: Response): Promise<Error> {
  const error = await response.json().catch(() => ({ error: 'Request failed' }));
  return new Error(error.message || error.error || 'Request failed');
}

async function fetchPublicJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (response.status === 401) {
    redirectToAuthSurface();
    throw new Error('Unauthorized');
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  return response.json();
}

async function getManagedToken(forceRefresh = false): Promise<string> {
  if (runtimeConfig.deployMode !== 'managed' || !runtimeConfig.managedTokenEndpoint) {
    throw new Error('Managed token endpoint is not configured');
  }

  if (!forceRefresh && managedToken) {
    return managedToken;
  }

  if (!forceRefresh && managedTokenPromise) {
    return managedTokenPromise;
  }

  managedTokenPromise = (async () => {
    const response = await fetch(runtimeConfig.managedTokenEndpoint!, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw await parseError(response);
    }

    const payload = (await response.json()) as ManagedTokenResponse;
    const token = payload.token ?? payload.accessToken;
    if (!token) {
      throw new Error('Managed session token missing from response');
    }

    managedToken = token;
    return token;
  })();

  try {
    return await managedTokenPromise;
  } finally {
    managedTokenPromise = null;
  }
}

async function fetchApiJson<T>(
  url: string,
  options?: RequestInit,
  attempt = 0
): Promise<T> {
  const headers = new Headers(options?.headers);

  if (runtimeConfig.deployMode === 'managed') {
    const token = await getManagedToken(attempt > 0);
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: runtimeConfig.deployMode === 'managed'
      ? 'include'
      : options?.credentials,
  });

  if (response.status === 401 && runtimeConfig.deployMode === 'managed' && attempt === 0) {
    managedToken = null;
    return fetchApiJson<T>(url, options, 1);
  }

  if (response.status === 401) {
    redirectToAuthSurface();
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  return response.json();
}

async function fetchApiBlob(
  url: string,
  options?: RequestInit,
  attempt = 0
): Promise<Blob> {
  const headers = new Headers(options?.headers);

  if (runtimeConfig.deployMode === 'managed') {
    const token = await getManagedToken(attempt > 0);
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: runtimeConfig.deployMode === 'managed'
      ? 'include'
      : options?.credentials,
  });

  if (response.status === 401 && runtimeConfig.deployMode === 'managed' && attempt === 0) {
    managedToken = null;
    return fetchApiBlob(url, options, 1);
  }

  if (response.status === 401) {
    redirectToAuthSurface();
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  return response.blob();
}

export const api = {
  runtime: {
    getPublicConfig: (): Promise<RuntimeConfig> => {
      return fetchPublicJson<RuntimeConfig>(`${API_BASE}/runtime`);
    },

    getSession: (): Promise<RuntimeSession> => {
      return fetchApiJson<RuntimeSession>(`${API_BASE}/runtime/session`);
    },
  },

  photos: {
    list: (filters: PhotoFilters = {}): Promise<PhotoListResponse> => {
      const params = new URLSearchParams();
      if (filters.search) params.set('q', filters.search);
      if (filters.tag) params.set('tag', filters.tag);
      if (filters.person) params.set('person', filters.person);
      if (filters.smartTag) params.set('smartTag', filters.smartTag);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.dateUnknown) params.set('dateUnknown', 'true');
      if (filters.city) params.set('city', filters.city);
      if (filters.region) params.set('region', filters.region);
      if (filters.country) params.set('country', filters.country);
      if (filters.page) params.set('page', String(filters.page));
      if (filters.limit) params.set('limit', String(filters.limit));

      const query = params.toString();
      return fetchApiJson<PhotoListResponse>(`${API_BASE}/photos${query ? `?${query}` : ''}`);
    },

    get: (id: string): Promise<Photo> => {
      return fetchApiJson<Photo>(`${API_BASE}/photos/${id}`);
    },

    getFaces: (id: string): Promise<{ faces: Face[] }> => {
      return fetchApiJson<{ faces: Face[] }>(`${API_BASE}/photos/${id}/faces`);
    },

    getFullImageUrl: async (id: string): Promise<string> => {
      const result = await fetchApiJson<{ url: string }>(`${API_BASE}/photos/${id}/image`);
      return result.url;
    },

    getThumbnail: (id: string, size = 512): Promise<Blob> => {
      return fetchApiBlob(`${API_BASE}/photos/${id}/thumbnail?size=${size}`);
    },

    getFaceThumbnail: (
      photoId: string,
      faceId: string,
      size = 96,
      signal?: AbortSignal,
    ): Promise<Blob> => {
      return fetchApiBlob(
        `${API_BASE}/photos/${photoId}/faces/${faceId}/thumbnail?size=${size}`,
        { signal },
      );
    },

    timeline: (filters: Omit<PhotoFilters, 'page' | 'limit'> = {}): Promise<TimelineResponse> => {
      const params = new URLSearchParams();
      if (filters.search) params.set('q', filters.search);
      if (filters.tag) params.set('tag', filters.tag);
      if (filters.person) params.set('person', filters.person);
      if (filters.smartTag) params.set('smartTag', filters.smartTag);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.dateUnknown) params.set('dateUnknown', 'true');
      if (filters.city) params.set('city', filters.city);
      if (filters.region) params.set('region', filters.region);
      if (filters.country) params.set('country', filters.country);

      const query = params.toString();
      return fetchApiJson<TimelineResponse>(`${API_BASE}/photos/timeline${query ? `?${query}` : ''}`);
    },

    locationFacets: (
      filters: Omit<PhotoFilters, 'page' | 'limit' | 'city' | 'region' | 'country'> = {},
    ): Promise<LocationFacetsResponse> => {
      const params = new URLSearchParams();
      if (filters.search) params.set('q', filters.search);
      if (filters.tag) params.set('tag', filters.tag);
      if (filters.person) params.set('person', filters.person);
      if (filters.smartTag) params.set('smartTag', filters.smartTag);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.dateUnknown) params.set('dateUnknown', 'true');

      const query = params.toString();
      return fetchApiJson<LocationFacetsResponse>(
        `${API_BASE}/photos/location-facets${query ? `?${query}` : ''}`,
      );
    },
  },

  persons: {
    list: (): Promise<{ persons: Person[] }> => {
      return fetchApiJson<{ persons: Person[] }>(`${API_BASE}/persons`);
    },

    get: (id: string): Promise<Person> => {
      return fetchApiJson<Person>(`${API_BASE}/persons/${id}`);
    },

    getPhotos: (id: string): Promise<{ photos: Photo[] }> => {
      return fetchApiJson<{ photos: Photo[] }>(`${API_BASE}/persons/${id}/photos`);
    },

    create: (name: string): Promise<{ id: string; name: string }> => {
      return fetchApiJson<{ id: string; name: string }>(`${API_BASE}/persons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    },

    getUnassignedFaces: (limit = 50): Promise<{ faces: Face[] }> => {
      return fetchApiJson<{ faces: Face[] }>(`${API_BASE}/persons/unassigned-faces?limit=${limit}`);
    },

    assignFace: (faceId: string, personId: string | null): Promise<void> => {
      return fetchApiJson<void>(`${API_BASE}/persons/faces/${faceId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId }),
      });
    },
  },

  tags: {
    list: (): Promise<{ tags: Tag[] }> => {
      return fetchApiJson<{ tags: Tag[] }>(`${API_BASE}/tags`);
    },
  },

  clusters: {
    list: (): Promise<{ clusters: Cluster[] }> => {
      return fetchApiJson<{ clusters: Cluster[] }>(`${API_BASE}/clusters`);
    },

    getUnassigned: (): Promise<{ faces: ClusterFace[] }> => {
      return fetchApiJson<{ faces: ClusterFace[] }>(`${API_BASE}/clusters/unassigned`);
    },

    getFilteredOut: (): Promise<{ faces: ClusterFace[]; total: number }> => {
      return fetchApiJson<{ faces: ClusterFace[]; total: number }>(`${API_BASE}/clusters/filtered-out`);
    },

    getWontAssign: (): Promise<{ faces: ClusterFace[]; total: number }> => {
      return fetchApiJson<{ faces: ClusterFace[]; total: number }>(`${API_BASE}/clusters/wont-assign`);
    },

    markWontAssign: (faceId: string): Promise<void> => {
      return fetchApiJson<void>(`${API_BASE}/clusters/wont-assign/${faceId}`, {
        method: 'POST',
      });
    },

    restoreAssignment: (faceId: string): Promise<void> => {
      return fetchApiJson<void>(`${API_BASE}/clusters/wont-assign/${faceId}`, {
        method: 'DELETE',
      });
    },

    getFaces: (clusterId: string): Promise<{ faces: ClusterFace[] }> => {
      return fetchApiJson<{ faces: ClusterFace[] }>(`${API_BASE}/clusters/${clusterId}/faces`);
    },

    create: (faceId: string): Promise<{ id: string; faceCount: number }> => {
      return fetchApiJson<{ id: string; faceCount: number }>(`${API_BASE}/clusters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faceId }),
      });
    },

    run: (opts?: { threshold?: number; strategy?: ClusterStrategy }): Promise<ClusteringResult> => {
      return fetchApiJson<ClusteringResult>(`${API_BASE}/clusters/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts ?? {}),
      });
    },

    recluster: (opts: { threshold: number; strategy: ClusterStrategy }): Promise<ReclusterResult> => {
      return fetchApiJson<ReclusterResult>(`${API_BASE}/clusters/recluster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
    },

    name: (clusterId: string, name: string): Promise<{ personId: string }> => {
      return fetchApiJson<{ personId: string }>(`${API_BASE}/clusters/${clusterId}/name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    },

    rename: (clusterId: string, name: string): Promise<void> => {
      return fetchApiJson<void>(`${API_BASE}/clusters/${clusterId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    },

    assignFace: (clusterId: string, faceId: string): Promise<void> => {
      return fetchApiJson<void>(`${API_BASE}/clusters/${clusterId}/faces/${faceId}`, {
        method: 'POST',
      });
    },

    merge: (
      sourceClusterId: string,
      targetClusterId: string,
    ): Promise<{ targetClusterId: string; faceCount: number; personId: string | null }> => {
      return fetchApiJson<{ targetClusterId: string; faceCount: number; personId: string | null }>(
        `${API_BASE}/clusters/${sourceClusterId}/merge`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetClusterId }),
        },
      );
    },

    removeFace: (clusterId: string, faceId: string): Promise<void> => {
      return fetchApiJson<void>(`${API_BASE}/clusters/${clusterId}/faces/${faceId}`, {
        method: 'DELETE',
      });
    },
  },

  settings: {
    get: (): Promise<Record<string, string>> => {
      return fetchApiJson<Record<string, string>>(`${API_BASE}/settings`);
    },

    update: (settings: Record<string, string>): Promise<Record<string, string>> => {
      return fetchApiJson<Record<string, string>>(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
    },

    getS3Config: (): Promise<S3ConfigResponse> => {
      return fetchApiJson<S3ConfigResponse>(`${API_BASE}/settings/s3`);
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
      return fetchApiJson<GpuLogListResponse>(`${API_BASE}/logs${query ? `?${query}` : ''}`);
    },

    get: (id: string): Promise<GpuLogDetailResponse> => {
      return fetchApiJson<GpuLogDetailResponse>(`${API_BASE}/logs/${id}`);
    },

    getChildren: (id: string): Promise<{ children: GpuLog[] }> => {
      return fetchApiJson<{ children: GpuLog[] }>(`${API_BASE}/logs/${id}/children`);
    },
  },

  smartTags: {
    list: (): Promise<{ smartTags: SmartTag[] }> => {
      return fetchApiJson<{ smartTags: SmartTag[] }>(`${API_BASE}/smart-tags`);
    },

    create: (data: { label: string; field: string; values: string[]; rule: string; sortOrder?: number }): Promise<SmartTag> => {
      return fetchApiJson<SmartTag>(`${API_BASE}/smart-tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    },

    update: (id: string, data: { label?: string; field?: string; values?: string[]; rule?: string; sortOrder?: number }): Promise<SmartTag> => {
      return fetchApiJson<SmartTag>(`${API_BASE}/smart-tags/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    },

    delete: (id: string): Promise<{ ok: boolean }> => {
      return fetchApiJson<{ ok: boolean }>(`${API_BASE}/smart-tags/${id}`, {
        method: 'DELETE',
      });
    },

    fields: (): Promise<{ fields: string[] }> => {
      return fetchApiJson<{ fields: string[] }>(`${API_BASE}/smart-tags/fields`);
    },

    facets: (field: string): Promise<FacetsResponse> => {
      return fetchApiJson<FacetsResponse>(`${API_BASE}/smart-tags/facets?field=${encodeURIComponent(field)}`);
    },
  },

  storage: {
    automaticImportStatus: (): Promise<AutomaticImportStatus> => {
      return fetchApiJson<AutomaticImportStatus>(`${API_BASE}/storage/automatic-import`);
    },

    reconcile: (): Promise<{ status: string }> => {
      return fetchApiJson<{ status: string }>(`${API_BASE}/storage/automatic-import/reconcile`, {
        method: 'POST',
      });
    },

    browse: (prefix: string = ''): Promise<StorageBrowseResponse> => {
      const params = new URLSearchParams();
      if (prefix) params.set('prefix', prefix);
      const query = params.toString();
      return fetchApiJson<StorageBrowseResponse>(`${API_BASE}/storage/browse${query ? `?${query}` : ''}`);
    },

    browseCounts: (prefix: string = '', refresh: boolean = false): Promise<StorageBrowseCountsResponse> => {
      const params = new URLSearchParams();
      if (prefix) params.set('prefix', prefix);
      if (refresh) params.set('refresh', '1');
      const query = params.toString();
      return fetchApiJson<StorageBrowseCountsResponse>(`${API_BASE}/storage/browse-counts${query ? `?${query}` : ''}`);
    },

    import: (options: ImportOptions): Promise<ImportResult> => {
      return fetchApiJson<ImportResult>(`${API_BASE}/photos/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
    },

    getImportJob: (jobId: string): Promise<ManualImportJobResponse> => {
      return fetchApiJson<ManualImportJobResponse>(`${API_BASE}/photos/import/jobs/${jobId}`);
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
      walletEstimate: GpuWalletEstimate | null;
      keys: string[];
    }> => {
      const params = new URLSearchParams();
      if (prefix) params.set('prefix', prefix);
      params.set('limit', String(limit));
      return fetchApiJson(`${API_BASE}/photos/import?${params.toString()}`);
    },

    reprocess: (options: { mode?: string; force?: boolean; gpuMode?: string; pathPrefix?: string }): Promise<unknown> => {
      return fetchApiJson(`${API_BASE}/photos/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
    },
  },

  gpu: {
    estimate: (photoCount: number, gpuMode: string): Promise<{
      provider: string;
      gpuMode: string;
      photoCount: number;
      estimate: GpuWalletEstimate | null;
    }> => {
      const params = new URLSearchParams({
        photoCount: String(photoCount),
        gpuMode,
      });
      return fetchApiJson(`${API_BASE}/photos/gpu-estimate?${params.toString()}`);
    },
  },

  reprocess: {
    getStats: (pathPrefix?: string): Promise<ReprocessStatsResponse> => {
      const params = new URLSearchParams();
      if (pathPrefix) params.set('pathPrefix', pathPrefix);
      const query = params.toString();
      return fetchApiJson<ReprocessStatsResponse>(`${API_BASE}/photos/reprocess/stats${query ? `?${query}` : ''}`);
    },

    trigger: (options: {
      mode?: string;
      force?: boolean;
      skipModal?: boolean;
      pathPrefix?: string;
      filters?: Omit<PhotoFilters, 'page' | 'limit'>;
    }): Promise<ReprocessTriggerResponse> => {
      return fetchApiJson<ReprocessTriggerResponse>(`${API_BASE}/photos/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
    },

    getJob: (jobId: string): Promise<ReprocessJobResponse> => {
      return fetchApiJson<ReprocessJobResponse>(`${API_BASE}/photos/reprocess/jobs/${jobId}`);
    },
  },
};
