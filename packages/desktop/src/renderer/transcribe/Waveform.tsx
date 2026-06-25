import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from './util';

function fmtClock(sec: number): string {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Interactive waveform + player ({波纹音轨}) for the source audio/video. Plays
 * the file through the same `lynlens-media` ranged protocol the other pages use,
 * draws a peak envelope with a movable playhead, and supports click + drag to
 * seek — matching the seek behaviour elsewhere in the app.
 */
export function Waveform({
  sourcePath,
  onTime,
}: {
  sourcePath: string | null;
  /** Throttled (~8/s) playback time, for cue highlighting in the tabs. */
  onTime?: (sec: number) => void;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peakRef = useRef<number[] | null>(null);
  const draggingRef = useRef(false);
  const lastEmitRef = useRef(0);

  const [peak, setPeak] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);

  // Fetch the envelope when the source changes.
  useEffect(() => {
    peakRef.current = null;
    setPeak(null);
    setCurrent(0);
    setPlaying(false);
    if (!sourcePath) return;
    let cancelled = false;
    setLoading(true);
    void window.lynlens
      .lynscripeWaveform(sourcePath)
      .then((d) => {
        if (cancelled) return;
        peakRef.current = d.peak;
        setPeak(d.peak);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  // Draw envelope + played overlay + playhead.
  function draw(): void {
    const canvas = canvasRef.current;
    const peaks = peakRef.current;
    if (!canvas || !peaks) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * dpr)) canvas.width = Math.round(rect.width * dpr);
    if (canvas.height !== Math.round(rect.height * dpr)) canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const dur = audioRef.current?.duration || duration || 0;
    const cur = audioRef.current?.currentTime ?? current;
    const playedX = dur > 0 ? (cur / dur) * rect.width : 0;
    const n = peaks.length;
    const mid = rect.height / 2;
    const bw = rect.width / n;
    for (let i = 0; i < n; i++) {
      const x = i * bw;
      const h = Math.max(0.5, peaks[i] * mid * 0.96);
      ctx.fillStyle = x <= playedX ? '#5b8def' : '#3a3a46';
      ctx.fillRect(x, mid - h, Math.max(0.4, bw * 0.7), h * 2);
    }
    // Playhead line
    ctx.fillStyle = '#ff5f8a';
    ctx.fillRect(playedX - 0.5, 0, 1.5, rect.height);
  }

  // Redraw on peak/duration/current changes, and via RAF while playing.
  useEffect(() => {
    draw();
    const ro = new ResizeObserver(draw);
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peak]);

  useEffect(() => {
    if (!playing) {
      draw();
      return;
    }
    let raf = 0;
    const tick = (): void => {
      const a = audioRef.current;
      if (a) {
        setCurrent(a.currentTime);
        const now = performance.now();
        if (onTime && now - lastEmitRef.current > 110) {
          lastEmitRef.current = now;
          onTime(a.currentTime);
        }
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // redraw when current/duration change while paused
  useEffect(() => {
    if (!playing) draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, duration]);

  function seekToClientX(clientX: number): void {
    const canvas = canvasRef.current;
    const a = audioRef.current;
    if (!canvas || !a) return;
    const rect = canvas.getBoundingClientRect();
    const dur = a.duration || duration || 0;
    if (dur <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const t = ratio * dur;
    a.currentTime = t;
    setCurrent(t);
    onTime?.(t); // keep cue highlight in sync while scrubbing/paused
  }

  function onPointerDown(e: React.MouseEvent): void {
    draggingRef.current = true;
    seekToClientX(e.clientX);
    const move = (ev: MouseEvent): void => {
      if (draggingRef.current) seekToClientX(ev.clientX);
    };
    const up = (): void => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function togglePlay(): void {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }

  return (
    <div className="transcribe-wave">
      {sourcePath && (
        <audio
          ref={audioRef}
          src={mediaUrl(sourcePath)}
          preload="metadata"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
      <button
        className="transcribe-wave-play"
        onClick={togglePlay}
        disabled={!sourcePath}
        title={playing ? '暂停' : '播放'}
      >
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <rect x="2" y="1.5" width="3" height="9" rx="1" />
            <rect x="7" y="1.5" width="3" height="9" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <path d="M3 1.5 L10 6 L3 10.5 Z" />
          </svg>
        )}
      </button>
      <div className="transcribe-wave-body">
        {loading && <span className="transcribe-wave-hint">读取波形…</span>}
        {!loading && !sourcePath && <span className="transcribe-wave-hint">选文件后显示波形</span>}
        {peak && <canvas ref={canvasRef} className="transcribe-wave-canvas" onMouseDown={onPointerDown} />}
      </div>
      <span className="transcribe-wave-time">
        {fmtClock(current)} / {fmtClock(duration)}
      </span>
    </div>
  );
}
