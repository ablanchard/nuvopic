const API_BASE = '/api/v1';

export interface Photo {
  id: string;
  thumbnailUrl: string;
  fullImageUrl: string;
  takenAt: string | null;
  description: string | null;
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
  thumbnailUrl: string;
}

export interface PhotoFilters {
  search?: string;
  tag?: string;
  person?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
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
};
