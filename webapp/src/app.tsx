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

        if (!sessionInfo.storageConfigured && getCurrentUrl() !== sessionInfo.storageSetupPath) {
          route(sessionInfo.storageSetupPath, true);
        } else if (sessionInfo.storageConfigured && getCurrentUrl() === sessionInfo.storageSetupPath) {
          route('/', true);
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
    route('/', true);
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
                href="/"
                class={`nav-link ${currentPath === '/' ? 'nav-link--active' : ''}`}
              >
                Photos
              </a>
              <a
                href="/faces"
                class={`nav-link ${currentPath === '/faces' ? 'nav-link--active' : ''}`}
              >
                Faces
              </a>
            </>
          )}
          <a
            href={storageConfigured ? '/settings' : (session?.storageSetupPath ?? '/setup/storage')}
            class={`nav-link ${currentPath.startsWith('/settings') || currentPath.startsWith('/setup') ? 'nav-link--active' : ''}`}
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
        {currentPath === '/' && storageConfigured && (
          <div class="desktop-header-controls">
            <SearchBar />
            <SizeSlider />
          </div>
        )}
      </header>

      <Router onChange={(e) => setCurrentPath(e.url)}>
        <HomePage path="/" />
        <FacesPage path="/faces" />
        <SettingsPage path="/settings" session={session} />
        <SettingsPage
          path="/setup/storage"
          onboarding
          session={session}
          onStorageConfigured={handleStorageConfigured}
        />
        <GpuLogsPage path="/settings/gpu-logs" />
        <SmartTagsSettingsPage path="/settings/smart-tags" />
        <StorageBrowserPage path="/settings/storage" />
        <ReprocessPage path="/settings/reprocess" />
      </Router>
    </div>
  );
}
