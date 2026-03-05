import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api/client';
import type { RoutableProps } from 'preact-router';

/** Known setting keys with display metadata. */
const SETTING_DEFS: Record<string, {
  label: string;
  description: string;
  section: string;
  type: 'range' | 'number';
  min?: number;
  max?: number;
  step?: number;
}> = {
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.settings.get();
      setSettings(data);
      setDraft(data);
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

  const hasChanges = Object.keys(draft).some((k) => draft[k] !== settings[k]);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      // Only send changed values
      const changed: Record<string, string> = {};
      for (const [key, value] of Object.entries(draft)) {
        if (value !== settings[key]) {
          changed[key] = value;
        }
      }

      if (Object.keys(changed).length === 0) {
        setStatus({ type: 'success', message: 'No changes to save' });
        setSaving(false);
        return;
      }

      const updated = await api.settings.update(changed);
      setSettings(updated);
      setDraft(updated);
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
    setDraft(settings);
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
