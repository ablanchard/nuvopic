import Router, { getCurrentUrl, route } from 'preact-router';
import { SearchBar } from './components/SearchBar';
import { SizeSlider } from './components/SizeSlider';
import { HomePage } from './components/HomePage';
import { FacesPage } from './components/FacesPage';
import { SettingsPage } from './components/SettingsPage';
import { GpuLogsPage } from './components/GpuLogsPage';
import { SmartTagsSettingsPage } from './components/SmartTagsSettingsPage';
import { StorageBrowserPage } from './components/StorageBrowserPage';
import { ReprocessPage } from './components/ReprocessPage';
import { useEffect, useState } from 'preact/hooks';
import { api, configureApiRuntime, type RuntimeConfig, type RuntimeSession } from './api/client';
import {
  APP_PATH,
  FACES_PATH,
  LEGACY_GPU_LOGS_PATH,
  LOGS_PATH,
  PHOTOS_PATH,
  REPROCESS_PATH,
  SETTINGS_PATH,
  SMART_TAGS_PATH,
  STORAGE_PATH,
  STORAGE_SETUP_PATH,
} from './routes';
import './app.css';

export function App() {
  const [currentPath, setCurrentPath] = useState(getCurrentUrl());
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [session, setSession] = useState<RuntimeSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const storageConfigured = session?.storageConfigured ?? false;

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const publicConfig = await api.runtime.getPublicConfig();
        if (cancelled) return;

        configureApiRuntime(publicConfig);
        setRuntime(publicConfig);

        const sessionInfo = await api.runtime.getSession();
        if (cancelled) return;

        setSession(sessionInfo);

        const currentUrl = getCurrentUrl();
        if (!sessionInfo.storageConfigured && currentUrl !== sessionInfo.storageSetupPath) {
          window.history.replaceState(null, '', sessionInfo.storageSetupPath);
          setCurrentPath(sessionInfo.storageSetupPath);
        } else if (
          sessionInfo.storageConfigured &&
          (currentUrl === sessionInfo.storageSetupPath || currentUrl === '/' || currentUrl === APP_PATH)
        ) {
          window.history.replaceState(null, '', PHOTOS_PATH);
          setCurrentPath(PHOTOS_PATH);
        }
      } catch (error) {
        if (!cancelled) {
          setBootstrapError(error instanceof Error ? error.message : 'Failed to load NuvoPic');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loading) return;

    const header = document.querySelector<HTMLElement>('.app-header');
    if (!header) return;

    const updateHeaderHeight = () => {
      document.documentElement.style.setProperty('--app-header-height', `${header.offsetHeight}px`);
    };

    updateHeaderHeight();

    const resizeObserver = new ResizeObserver(updateHeaderHeight);
    resizeObserver.observe(header);
    window.addEventListener('resize', updateHeaderHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateHeaderHeight);
    };
  }, [loading, currentPath, session?.storageConfigured]);

  const handleStorageConfigured = async () => {
    const sessionInfo = await api.runtime.getSession();
    setSession(sessionInfo);
    route(PHOTOS_PATH, true);
  };

  if (loading) {
    return <div class="loading">Starting NuvoPic...</div>;
  }

  if (bootstrapError) {
    return (
      <div class="app-content">
        <main class="main-content">
          <div class="settings-container">
            <div class="settings-section">
              <h2 class="settings-section-title">Unable to start NuvoPic</h2>
              <div class="settings-card">
                <p>{bootstrapError}</p>
                {runtime?.deployMode === 'managed' && runtime.profilePath && (
                  <p>
                    Continue from <a href={runtime.profilePath}>your profile</a>.
                  </p>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div class="app">
      <header class="app-header">
        <h1>NuvoPic</h1>
        <nav class="nav-links">
          {storageConfigured && (
            <>
              <a
                href={PHOTOS_PATH}
                class={`nav-link ${currentPath === PHOTOS_PATH ? 'nav-link--active' : ''}`}
              >
                Photos
              </a>
              <a
                href={FACES_PATH}
                class={`nav-link ${currentPath === FACES_PATH ? 'nav-link--active' : ''}`}
              >
                Faces
              </a>
            </>
          )}
          <a
            href={storageConfigured ? SETTINGS_PATH : (session?.storageSetupPath ?? STORAGE_SETUP_PATH)}
            class={`nav-link ${currentPath.startsWith(SETTINGS_PATH) || currentPath.startsWith(`${APP_PATH}/setup`) ? 'nav-link--active' : ''}`}
          >
            {storageConfigured ? 'Settings' : 'Setup'}
          </a>
          {runtime?.deployMode === 'managed' && runtime.profilePath && (
            <a href={runtime.profilePath} class="nav-link">
              Profile
            </a>
          )}
          {runtime?.deployMode === 'managed' && runtime.adminPath && session?.role === 'admin' && (
            <a href={runtime.adminPath} class="nav-link">
              Admin
            </a>
          )}
        </nav>
        {currentPath === PHOTOS_PATH && storageConfigured && (
          <div class="desktop-header-controls">
            <SearchBar />
            <SizeSlider />
          </div>
        )}
      </header>

      <Router onChange={(e) => setCurrentPath(e.url)}>
        <HomePage path={PHOTOS_PATH} />
        <FacesPage path={FACES_PATH} />
        <SettingsPage path={SETTINGS_PATH} session={session} />
        <SettingsPage
          path={STORAGE_SETUP_PATH}
          onboarding
          session={session}
          onStorageConfigured={handleStorageConfigured}
        />
        <GpuLogsPage path={LOGS_PATH} />
        <GpuLogsPage path={LEGACY_GPU_LOGS_PATH} />
        <SmartTagsSettingsPage path={SMART_TAGS_PATH} />
        <StorageBrowserPage path={STORAGE_PATH} />
        <ReprocessPage path={REPROCESS_PATH} />
      </Router>
    </div>
  );
}
