import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, type RuntimeSession } from '../api/client';
import { SettingsSidebar } from './SettingsSidebar';
import type { RoutableProps } from 'preact-router';
import { SETTINGS_PATH } from '../routes';

const MASKED_VALUE = '__MASKED__';
const SECRET_KEYS = new Set(['s3_secret_access_key']);
const STORAGE_SECTION = 'S3 Storage';

type SettingDef = {
  label: string;
  description: string;
  section: string;
  type: 'range' | 'number' | 'text' | 'password' | 'boolean';
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
};

const SETTING_DEFS: Record<string, SettingDef> = {
  s3_bucket: {
    label: 'S3 Bucket',
    description: 'The bucket name NuvoPic should read and process in place.',
    section: STORAGE_SECTION,
    type: 'text',
    placeholder: 'e.g. my-photos',
  },
  s3_region: {
    label: 'S3 Region',
    description: 'AWS region or the equivalent provider region.',
    section: STORAGE_SECTION,
    type: 'text',
    placeholder: 'e.g. us-east-1',
  },
  s3_endpoint: {
    label: 'S3 Endpoint',
    description: 'Optional custom endpoint for MinIO, R2, B2, Scaleway, and other S3-compatible providers.',
    section: STORAGE_SECTION,
    type: 'text',
    placeholder: 'e.g. https://s3.provider.com',
  },
  s3_access_key_id: {
    label: 'Access Key ID',
    description: 'Access key ID with read/list permissions on the bucket.',
    section: STORAGE_SECTION,
    type: 'text',
    placeholder: 'e.g. AKIAIOSFODNN7EXAMPLE',
  },
  s3_secret_access_key: {
    label: 'Secret Access Key',
    description: 'Secret access key. Stored encrypted at rest in the workspace database.',
    section: STORAGE_SECTION,
    type: 'password',
    placeholder: 'Enter new secret key',
  },
  s3_force_path_style: {
    label: 'Force Path Style',
    description: 'Enable this for providers such as MinIO that require path-style URLs.',
    section: STORAGE_SECTION,
    type: 'boolean',
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
    label: 'Minimum face size (px²)',
    description: 'Minimum bounding box area in pixels. A 50×50 face = 2500.',
    section: 'Face Quality',
    type: 'number',
    min: 0,
    max: 50000,
    step: 100,
  },
};

function groupBySection(keys: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const key of keys) {
    const section = SETTING_DEFS[key]?.section ?? 'Other';
    if (!groups[section]) groups[section] = [];
    groups[section].push(key);
  }
  return groups;
}

interface SettingsPageProps extends RoutableProps {
  onboarding?: boolean;
  session?: RuntimeSession | null;
  onStorageConfigured?: () => void | Promise<void>;
}

export function SettingsPage(props: SettingsPageProps) {
  const onboarding = props.onboarding === true;
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

      const draftData = { ...data };
      for (const key of SECRET_KEYS) {
        if (draftData[key] === MASKED_VALUE) {
          draftData[key] = '';
        }
      }
      setDraft(draftData);
      setS3Config(s3);
    } catch (err) {
      setStatus({
        type: 'error',
        message: `Failed to load settings: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
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

  const hasChanges = Object.keys(draft).some((key) => {
    if (SECRET_KEYS.has(key)) {
      return draft[key] !== '' && draft[key] !== MASKED_VALUE;
    }
    return draft[key] !== settings[key];
  });

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);

    try {
      const changed: Record<string, string> = {};
      for (const [key, value] of Object.entries(draft)) {
        if (SECRET_KEYS.has(key)) {
          if (value && value !== MASKED_VALUE) {
            changed[key] = value;
          }
        } else if (value !== settings[key]) {
          changed[key] = value;
        }
      }

      if (Object.keys(changed).length === 0) {
        setStatus({ type: 'success', message: onboarding ? 'Storage is already configured' : 'No changes to save' });
        return;
      }

      const updated = await api.settings.update(changed);
      const nextS3 = await api.settings.getS3Config();
      const nextDraft = { ...updated };
      for (const key of SECRET_KEYS) {
        if (nextDraft[key] === MASKED_VALUE) {
          nextDraft[key] = '';
        }
      }

      setSettings(updated);
      setDraft(nextDraft);
      setS3Config(nextS3);
      setStatus({
        type: 'success',
        message: onboarding ? 'Storage connected' : 'Settings saved',
      });

      if (onboarding && props.onStorageConfigured) {
        await props.onStorageConfigured();
      }
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
    const nextDraft = { ...settings };
    for (const key of SECRET_KEYS) {
      if (nextDraft[key] === MASKED_VALUE) {
        nextDraft[key] = '';
      }
    }
    setDraft(nextDraft);
    setStatus(null);
  };

  const allKeys = Array.from(new Set([...Object.keys(SETTING_DEFS), ...Object.keys(draft)]));
  const groupedSections = groupBySection(allKeys);
  const sections = onboarding
    ? Object.entries(groupedSections).filter(([section]) => section === STORAGE_SECTION)
    : Object.entries(groupedSections);
  const storageConfigured = Boolean(s3Config.s3_bucket?.effectiveValue);

  return (
    <div class="app-content">
      {!onboarding && <SettingsSidebar activePath={SETTINGS_PATH} />}

      <main class="main-content">
        {loading ? (
          <div class="loading">Loading settings...</div>
        ) : (
          <div class="settings-container">
            {onboarding && (
              <div class="settings-section">
                <h2 class="settings-section-title">Connect Your Bucket</h2>
                <div class="settings-card">
                  <p>
                    NuvoPic is ready, but it needs access to your S3-compatible bucket before it can
                    browse or process photos.
                  </p>
                  <p>
                    Provide bucket credentials with read/list access. NuvoPic validates them before saving.
                  </p>
                </div>
              </div>
            )}

            {sections.map(([section, keys]) => (
              <div key={section} class="settings-section" id={`settings-${section.toLowerCase().replace(/\s+/g, '-')}`}>
                <h2 class="settings-section-title">{section}</h2>
                <div class="settings-card">
                  {keys.map((key) => {
                    const def = SETTING_DEFS[key];
                    const value = draft[key] ?? '';

                    if (!def) {
                      return (
                        <div key={key} class="setting-row">
                          <div class="setting-info">
                            <label class="setting-label" htmlFor={`setting-${key}`}>{key}</label>
                          </div>
                          <div class="setting-control">
                            <input
                              type="text"
                              id={`setting-${key}`}
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
                          <label class="setting-label" htmlFor={`setting-${key}`}>{def.label}</label>
                          <p class="setting-description">{def.description}</p>
                          {key === 's3_secret_access_key' && s3Config[key]?.effectiveValue && (
                            <p class="setting-hint">Current secret: <strong>{s3Config[key].effectiveValue}</strong></p>
                          )}
                        </div>
                        <div class="setting-control">
                          {def.type === 'range' ? (
                            <div class="control-with-value">
                              <input
                                type="range"
                                id={`setting-${key}`}
                                min={def.min}
                                max={def.max}
                                step={def.step}
                                value={parseFloat(value) || 0}
                                onInput={(e) => handleChange(key, (e.target as HTMLInputElement).value)}
                              />
                              <span class="control-value">{parseFloat(value || '0').toFixed(2)}</span>
                            </div>
                          ) : def.type === 'text' ? (
                            <input
                              type="text"
                              id={`setting-${key}`}
                              value={value}
                              placeholder={def.placeholder}
                              onInput={(e) => handleChange(key, (e.target as HTMLInputElement).value)}
                              class="setting-text-input"
                            />
                          ) : def.type === 'password' ? (
                            <input
                              type="password"
                              id={`setting-${key}`}
                              value={value}
                              placeholder={settings[key] === MASKED_VALUE ? 'Secret is set (enter to change)' : def.placeholder}
                              onInput={(e) => handleChange(key, (e.target as HTMLInputElement).value)}
                              class="setting-text-input"
                              autoComplete="off"
                            />
                          ) : def.type === 'boolean' ? (
                            <label class="setting-toggle" htmlFor={`setting-${key}`}>
                              <input
                                type="checkbox"
                                id={`setting-${key}`}
                                checked={value === 'true'}
                                onChange={(e) => handleChange(key, (e.target as HTMLInputElement).checked ? 'true' : 'false')}
                              />
                              <span class="setting-toggle-label">{value === 'true' ? 'Enabled' : 'Disabled'}</span>
                            </label>
                          ) : (
                            <input
                              type="number"
                              id={`setting-${key}`}
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

            {!onboarding && !storageConfigured && (
              <div class="settings-section">
                <div class="settings-card">
                  <p>Storage is not configured yet. Complete the S3 section before using import and browsing features.</p>
                </div>
              </div>
            )}

            {props.session?.deployMode === 'managed' && onboarding && (
              <div class="settings-section">
                <div class="settings-card">
                  <p>Your bucket credentials stay inside NuvoPic and are stored only in the workspace database.</p>
                </div>
              </div>
            )}

            <div class="settings-actions">
              <button
                class="btn btn-primary"
                onClick={handleSave}
                disabled={saving || !hasChanges}
              >
                {saving ? 'Saving...' : onboarding ? 'Connect Bucket' : 'Save Settings'}
              </button>
              {!onboarding && (
                <button
                  class="btn btn-secondary"
                  onClick={handleReset}
                  disabled={saving || !hasChanges}
                >
                  Reset
                </button>
              )}
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
