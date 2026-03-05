import Router from 'preact-router';
import { SearchBar } from './components/SearchBar';
import { HomePage } from './components/HomePage';
import { FacesPage } from './components/FacesPage';
import { photoSize } from './state/filters';
import { getCurrentUrl } from 'preact-router';
import { useState } from 'preact/hooks';
import './app.css';

export function App() {
  const [currentPath, setCurrentPath] = useState(getCurrentUrl());

  return (
    <div class="app">
      <header class="app-header">
        <h1>NuvoPic</h1>
        <nav class="nav-links">
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
        </nav>
        {currentPath === '/' && (
          <>
            <SearchBar />
            <div class="size-slider">
              <label>Size</label>
              <input
                type="range"
                min="100"
                max="400"
                step="25"
                value={photoSize.value}
                onInput={(e) => {
                  photoSize.value = parseInt((e.target as HTMLInputElement).value);
                }}
              />
            </div>
          </>
        )}
      </header>

      <Router onChange={(e) => setCurrentPath(e.url)}>
        <HomePage path="/" />
        <FacesPage path="/faces" />
      </Router>
    </div>
  );
}
