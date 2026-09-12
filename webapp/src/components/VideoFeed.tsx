import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../api/client';
import { filters } from '../state/filters';

function shuffle(ids: string[]): string[] {
  const result = [...ids];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function FeedPlayer({ id, active, muted, onNext, onReady }: {
  id: string; active: boolean; muted: boolean; onNext: () => void; onReady: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const element = video.current;
    api.photos.getFullImageUrl(id).then((value) => {
      if (!cancelled) setUrl(value);
    }).catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => {
      cancelled = true;
      if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
    };
  }, [id]);

  useEffect(() => {
    const element = video.current;
    if (!active) { element?.pause(); return; }
    if (!url) return;
    if (element && element.readyState >= 3) onReady();
    let cancelled = false;
    element?.play().catch(() => { if (!cancelled) { setPaused(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [url, active, onReady]);

  const togglePlay = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setPaused(true));
    else element.pause();
  };

  return <>
    <video ref={video} src={url || undefined} muted={!active || muted} playsInline preload="auto"
      class={active ? 'video-feed-player' : 'video-feed-preload'}
      aria-label={active ? 'Current video' : 'Next video'} aria-hidden={!active} tabIndex={active ? 0 : -1} controls={active}
      onPlaying={() => { setLoading(false); setPaused(false); if (active) onReady(); }}
      onPause={() => setPaused(true)} onWaiting={() => setLoading(true)}
      onCanPlay={() => { setLoading(false); if (active) onReady(); }} onEnded={() => { if (active) onNext(); }}
      onError={() => { setError(true); setLoading(false); }} />
    {active && loading && !error && <p class="video-feed-message" role="status">Loading video…</p>}
    {active && error && <div class="video-feed-message" role="alert">This video cannot be played.
      <button onClick={onNext}>Skip video</button>
      {url && <a href={url} target="_blank" rel="noopener noreferrer">Open original</a>}
    </div>}
    {active && !error && <button class="video-feed-play" onClick={togglePlay} aria-label={paused ? 'Play video' : 'Pause video'}>
      {paused ? '▶ Play' : 'Ⅱ Pause'}
    </button>}
  </>;
}

export function VideoFeed() {
  const root = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const gestureTime = useRef(0);
  const touchY = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [muted, setMuted] = useState(true);
  const [round, setRound] = useState(0);
  const [readyPlayer, setReadyPlayer] = useState<string | null>(null);
  const nextRound = useMemo(() => {
    const next = shuffle(ids);
    if (next.length > 1 && next[0] === ids[ids.length - 1]) [next[0], next[1]] = [next[1], next[0]];
    return next;
  }, [ids]);
  const currentKey = `${round}:${ids[index]}`;
  const onReady = useCallback(() => setReadyPlayer(currentKey), [currentKey]);
  const upcoming = index + 1 < ids.length
    ? { id: ids[index + 1], key: `${round}:${ids[index + 1]}` }
    : { id: nextRound[0], key: `${round + 1}:${nextRound[0]}` };

  const close = useCallback(() => {
    request.current++;
    setOpen(false);
    setIds([]);
    if (document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => {});
    requestAnimationFrame(() => launcher.current?.focus());
  }, []);

  const move = useCallback((direction: number) => {
    if (!ids.length) return;
    if (direction > 0 && index === ids.length - 1) {
      setIds(nextRound); setIndex(0); setRound((value) => value + 1);
    } else setIndex((value) => Math.max(0, value + direction));
  }, [ids, index, nextRound]);
  const next = useCallback(() => move(1), [move]);

  const start = () => {
    const selection = { ...filters.value };
    const token = ++request.current;
    setOpen(true); setLoading(true); setError(false); setIds([]); setIndex(0); setRound(0); setReadyPlayer(null);
    // Request in the click handler to preserve the browser's user activation.
    void root.current?.requestFullscreen?.().catch(() => {});
    api.photos.videoFeed(selection).then(({ ids: matches }) => {
      if (token !== request.current) return;
      setIds(shuffle(matches)); setLoading(false);
    }).catch(() => { if (token === request.current) { setError(true); setLoading(false); } });
  };

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    let enteredFullscreen = document.fullscreenElement === root.current;
    const fullscreenChanged = () => {
      if (document.fullscreenElement === root.current) enteredFullscreen = true;
      else if (enteredFullscreen) close();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1);
      }
      if (event.key === 'Tab') {
        const buttons = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('fullscreenchange', fullscreenChanged);
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      document.removeEventListener('keydown', keydown);
    };
  }, [open, close, move]);

  const gesture = (direction: number) => {
    if (Date.now() - gestureTime.current < 700) return;
    gestureTime.current = Date.now(); move(direction);
  };

  return <div ref={root} class={open ? 'video-feed video-feed--open' : 'video-feed-launch'}
    role={open ? 'dialog' : undefined} aria-modal={open ? 'true' : undefined} aria-label={open ? 'Video feed' : undefined}>
    {!open ? <button ref={launcher} class="video-feed-start" onClick={start}>▶ Watch videos</button> : <>
      <header class="video-feed-header">
        <div><strong>Video feed</strong><small>Current filters · shuffled{ids.length ? ` · ${index + 1} / ${ids.length}` : ''}</small></div>
        <button ref={closeButton} onClick={close} aria-label="Close video feed">✕ Close</button>
      </header>
      <div class="video-feed-stage" onWheel={(event) => { if (Math.abs(event.deltaY) > 30) gesture(event.deltaY > 0 ? 1 : -1); }}
        onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY ?? null; }}
        onTouchEnd={(event) => {
          if (touchY.current === null) return;
          const delta = touchY.current - (event.changedTouches[0]?.clientY ?? touchY.current);
          touchY.current = null;
          if (Math.abs(delta) > 60) gesture(delta > 0 ? 1 : -1);
        }}>
        {loading ? <p role="status">Finding matching videos…</p> : error ? <div role="alert">Could not load videos. <button onClick={start}>Retry</button></div> : !ids.length ?
          <p>No videos match your current filters.</p> : [
            <FeedPlayer key={currentKey} id={ids[index]} active muted={muted} onNext={next} onReady={onReady} />,
            // Keep the same keyed player when it becomes current, preserving its buffer.
            readyPlayer === currentKey && upcoming.id && <FeedPlayer key={upcoming.key} id={upcoming.id}
              active={false} muted onNext={next} onReady={onReady} />,
          ]}
      </div>
      {!!ids.length && <nav class="video-feed-controls" aria-label="Video navigation">
        <button onClick={() => move(-1)} disabled={index === 0} aria-label="Previous video">↑ Previous</button>
        <button onClick={() => setMuted((value) => !value)} aria-label={muted ? 'Unmute videos' : 'Mute videos'}>{muted ? 'Unmute' : 'Mute'}</button>
        <button onClick={next} aria-label="Next video">Next ↓</button>
        <small>Swipe up or down · Arrow keys · Esc to close</small>
      </nav>}
    </>}
  </div>;
}
