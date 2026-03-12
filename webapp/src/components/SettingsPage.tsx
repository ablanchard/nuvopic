import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api/client';
import type { RoutableProps } from 'preact-router';

/** Sentinel value the backend uses for masked secrets. */
const MASKED_VALUE = '__MASKED__';

/** Keys whose values are secrets (password fields). */
const SECRET_KEYS = new Set(['s3_secret_access_key']);

/** Known setting keys with display metadata. */
const SETTING_DEFS: Record<string, {
  label: string;
  description: string;
  section: string;
  type: 'range' | 'number' | 'text' | 'password' | 'boolean';
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  envVar?: string;
}> = {
  s3_bucket: {
    label: 'S3 Bucket',
    description: 'The S3 bucket name to use for photo storage.',
    section: 'S3 Storage',
    type: 'text',
    placeholder: 'e.g. my-photos',
    envVar: 'S3_BUCKET',
  },
  s3_region: {
    label: 'S3 Region',
    description: 'AWS region or provider region.',
    section: 'S3 Storage',
    type: 'text',
    placeholder: 'e.g. us-east-1',
    envVar: 'S3_REGION',
  },
  s3_endpoint: {
    label: 'S3 Endpoint',
    description: 'Custom endpoint for non-AWS providers (MinIO, Scaleway, R2, etc.). Leave empty for AWS.',
    section: 'S3 Storage',
    type: 'text',
    placeholder: 'e.g. https://s3.provider.com',
    envVar: 'S3_ENDPOINT',
  },
  s3_access_key_id: {
    label: 'Access Key ID',
    description: 'S3 access key ID.',
    section: 'S3 Storage',
    type: 'text',
    placeholder: 'e.g. AKIAIOSFODNN7EXAMPLE',
    envVar: 'S3_ACCESS_KEY_ID',
  },
  s3_secret_access_key: {
    label: 'Secret Access Key',
    description: 'S3 secret access key. Stored encrypted-at-rest in the database.',
    section: 'S3 Storage',
    type: 'password',
    placeholder: 'Enter new secret key',
    envVar: 'S3_SECRET_ACCESS_KEY',
  },
  s3_force_path_style: {
    label: 'Force Path Style',
    description: 'Use path-style URLs (required for MinIO and some S3-compatible providers).',
    section: 'S3 Storage',
    type: 'boolean',
    envVar: 'S3_FORCE_PATH_STYLE',
  },
  face_min_confidence: {
    label: 'Minimum confidence',
    description: 'InsightFace detection score threshold (0-1). Faces below this score are hidden everywhere.',
    section: 'Face Quality',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.05,
  },
  face_min_size: {
    label: 'Minimum face size (px\u00B2)',
    description: 'Minimum bounding box area in pixels. A 50\u00D750 face = 2500. Smaller faces are hidden.',
    section: 'Face Quality',
    type: 'number',
    min: 0,
    max: 50000,
    step: 100,
  },
};

/** Group settings by section. */
function groupBySection(keys: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const key of keys) {
    const section = SETTING_DEFS[key]?.section ?? 'Other';
    if (!groups[section]) groups[section] = [];
    groups[section].push(key);
  }
  return groups;
}

export function SettingsPage(_props: RoutableProps) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [s3Config, setS3Config] = useState<Record<string, { envValue: string | null; effectiveValue: string | null; effectiveSource: 'db' | 'env' | null }>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [data, s3] = await Promise.all([
        api.settings.get(),
        api.settings.getS3Config(),
      ]);
      setSettings(data);
      // For password/secret fields, clear the masked sentinel from the draft
      // so the input shows empty (with a placeholder) instead of "__MASKED__"
      const draftData = { ...data };
      for (const key of SECRET_KEYS) {
        if (draftData[key] === MASKED_VALUE) {
          draftData[key] = '';
        }
      }
      setDraft(draftData);
      setS3Config(s3);
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleChange = (key: string, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setStatus(null);
  };

  const hasChanges = Object.keys(draft).some((k) => {
    // For secret fields: only "changed" if user typed a non-empty value
    if (SECRET_KEYS.has(k)) {
      return draft[k] !== '' && draft[k] !== MASKED_VALUE;
    }
    return draft[k] !== settings[k];
  });

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      // Only send changed values; skip empty secret fields (means "no change")
      const changed: Record<string, string> = {};
      for (const [key, value] of Object.entries(draft)) {
        if (SECRET_KEYS.has(key)) {
          // Only send if the user typed a non-empty new value
          if (value && value !== MASKED_VALUE) {
            changed[key] = value;
          }
        } else if (value !== settings[key]) {
          changed[key] = value;
        }
      }

      if (Object.keys(changed).length === 0) {
        setStatus({ type: 'success', message: 'No changes to save' });
        setSaving(false);
        return;
      }

      const updated = await api.settings.update(changed);
      const s3 = await api.settings.getS3Config();
      setSettings(updated);
      // Clear secret fields from draft
      const draftData = { ...updated };
      for (const key of SECRET_KEYS) {
        if (draftData[key] === MASKED_VALUE) {
          draftData[key] = '';
        }
      }
      setDraft(draftData);
      setS3Config(s3);
      setStatus({ type: 'success', message: 'Settings saved' });
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    const draftData = { ...settings };
    for (const key of SECRET_KEYS) {
      if (draftData[key] === MASKED_VALUE) {
        draftData[key] = '';
      }
    }
    setDraft(draftData);
    setStatus(null);
  };

  // Compute sections from known keys present in settings + any unknown keys
  const allKeys = Array.from(new Set([...Object.keys(SETTING_DEFS), ...Object.keys(draft)]));
  const sections = groupBySection(allKeys);

  return (
    <div class="app-content">
      <aside class="sidebar">
        <h3 class="sidebar-heading">Settings</h3>
        <nav class="settings-nav">
          {Object.keys(sections).map((section) => (
            <a key={section} href={`#settings-${section.toLowerCase().replace(/\s+/g, '-')}`} class="settings-nav-link">
              {section}
            </a>
          ))}
        </nav>
      </aside>

      <main class="main-content">
        {loading ? (
          <div class="loading">Loading settings...</div>
        ) : (
          <div class="settings-container">
            {Object.entries(sections).map(([section, keys]) => (
              <div key={section} class="settings-section" id={`settings-${section.toLowerCase().replace(/\s+/g, '-')}`}>
                <h2 class="settings-section-title">{section}</h2>
                <div class="settings-card">
                  {keys.map((key) => {
                    const def = SETTING_DEFS[key];
                    const value = draft[key] ?? '';

                    if (!def) {
                      // Unknown setting — render as simple text input
                      return (
                        <div key={key} class="setting-row">
                          <div class="setting-info">
                            <label class="setting-label">{key}</label>
                          </div>
                          <div class="setting-control">
                            <input
                              type="text"
                              value={value}
                              onInput={(e) => handleChange(key, (e.target as HTMLInputElement).value)}
                            />
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={key} class="setting-row">
                        <div class="setting-info">
                          <label class="setting-label">{def.label}</label>
                          <p class="setting-description">{def.description}</p>
                          {def.envVar && s3Config[key]?.envValue && (
                            <p class="setting-hint">
                              Env var <code>{def.envVar}</code>:{' '}
                              <strong>{def.type === 'password' ? '••••' + s3Config[key].envValue!.slice(-4) : s3Config[key].envValue}</strong>
                              {s3Config[key].effectiveSource === 'db' ? ' (overridden by setting below)' : ' (active)'}
                            </p>
                          )}
                        </div>
                        <div class="setting-control">
                          {def.type === 'range' ? (
                            <div class="control-with-value">
                              <input
                                type="range"
                                min={def.min}
                                max={def.max}
                                step={def.step}
                                value={parseFloat(value) || 0}
                                onInput={(e) => handleChange(key, (e.target as HTMLInputElement).value)}
                              />
                              <span class="control-value">{parseFloat(value).toFixed(2)}</span>
                            </div>
                          ) : def.type === 'text' ? (
                            <input
                              type="text"
                              value={value}
                              placeholder={def.placeholder}
                              onInput={(e) => handleChange(key, (e.target as HTMLInputElement).value)}
                              class="setting-text-input"
                            />
                          ) : def.type === 'password' ? (
                            <input
                              type="password"
                              value={value}
                              placeholder={settings[key] === MASKED_VALUE ? 'Secret is set (enter to change)' : def.placeholder}
                              onInput={(e) => handleChange(key, (e.target as HTMLInputElement).value)}
                              class="setting-text-input"
                              autoComplete="off"
                            />
                          ) : def.type === 'boolean' ? (
                            <label class="setting-toggle">
                              <input
                                type="checkbox"
                                checked={value === 'true'}
                                onChange={(e) => handleChange(key, (e.target as HTMLInputElement).checked ? 'true' : 'false')}
                              />
                              <span class="setting-toggle-label">{value === 'true' ? 'Enabled' : 'Disabled'}</span>
                            </label>
                          ) : (
                            <input
                              type="number"
                              min={def.min}
                              max={def.max}
                              step={def.step}
                              value={value}
                              onInput={(e) => handleChange(key, (e.target as HTMLInputElement).value)}
                              class="setting-number-input"
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <div class="settings-actions">
              <button
                class="btn btn-primary"
                onClick={handleSave}
                disabled={saving || !hasChanges}
              >
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
              <button
                class="btn btn-secondary"
                onClick={handleReset}
                disabled={saving || !hasChanges}
              >
                Reset
              </button>
            </div>

            {status && (
              <div class={`settings-status settings-status--${status.type}`}>
                {status.message}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
