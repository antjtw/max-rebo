import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration } from '@cantina/shared';
import { api } from '../state/api.ts';
import { useStore, type Callout } from '../state/store.ts';
import { usePrefs } from '../state/prefs.ts';

/**
 * The Scope (SPEC §12.5): an SVG wireframe frame with a Canvas layer for everything that moves.
 * Coordinates live in a 1000 × 560 design space shared by the SVG viewBox, the canvas and the
 * HTML overlay, so all three line up at any size.
 */
const W = 1000;
const H = 560;
const CX = 500;
const CY = 282;
const RINGS = [
  { rx: 190, ry: 62, layer: 'sfx' },
  { rx: 290, ry: 96, layer: 'ambience' },
  { rx: 395, ry: 132, layer: 'music' },
] as const;

const FRAME = [
  [70, 40],
  [430, 40],
  [452, 66],
  [548, 66],
  [570, 40],
  [930, 40],
  [988, 282],
  [930, 524],
  [70, 524],
  [12, 282],
] as const;

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function Scope() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: W, h: H });
  const state = useStore((s) => s.state);
  const prefs = usePrefs();
  const tension = state
    ? Math.min(
        1,
        (state.scene.tensionStep + (state.game.despairPool > 0 ? 0.5 : 0)) / 2.5 +
          currentPriority(state) / 250,
      )
    : 0;

  // Fit the 1000×560 stage inside the available space.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const scale = Math.min(r.width / W, r.height / H);
      setSize({ w: Math.max(200, W * scale), h: Math.max(112, H * scale) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Animation loop: Canvas 2D, ≤ 60 fps when visible, 4 fps when hidden (SPEC §12.6).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = performance.now();
    const phases = [0, 0, 0];
    const colours = {
      line: css('--line') || '#ededed',
      dim: css('--line-mid') || '#a3a3a9',
      signal: css('--signal') || '#ff3b1f',
      faint: css('--line-faint') || '#2a2a2e',
    };

    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(size.w * dpr);
      const ch = Math.round(size.h * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      const s = cw / W;
      ctx.setTransform(s, 0, 0, s, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const st = useStore.getState();
      const snap = st.state;
      const mixer = st.mixer;
      const p = usePrefs.getState();
      const intensity = snap ? 1 + currentPriority(snap) / 25 + snap.scene.tensionStep : 1;
      ctx.lineWidth = 1;

      // Orbit rings: brightness follows each layer's level; chevrons travel with intensity.
      RINGS.forEach((ring, i) => {
        const level = mixer?.layers[ring.layer]?.level ?? 0;
        const muted = mixer?.layers[ring.layer]?.muted ?? false;
        const a = muted ? 0.12 : 0.22 + 0.78 * Math.min(1, level * 7);
        ctx.save();
        ctx.strokeStyle = colours.signal;
        ctx.globalAlpha = a;
        if (p.bloom) {
          ctx.shadowColor = colours.signal;
          ctx.shadowBlur = 8 * a;
        }
        ctx.beginPath();
        ctx.ellipse(CX, CY, ring.rx, ring.ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        if (!p.reducedMotion)
          phases[i] =
            (phases[i]! + ((dt * 2 * Math.PI) / 40) * intensity * (i % 2 ? -1 : 1)) % (Math.PI * 2);
        for (let k = 0; k < 3; k++) {
          const t = phases[i]! + (k * Math.PI * 2) / 3 + i;
          drawChevron(
            ctx,
            CX + ring.rx * Math.cos(t),
            CY + ring.ry * Math.sin(t),
            t,
            colours.signal,
            a,
          );
        }
      });

      // Centre circle: flashes solid red on a scene change.
      const flash = Math.max(0, 1 - (Date.now() - st.sceneFlashAt) / 1200);
      ctx.save();
      ctx.strokeStyle = colours.signal;
      ctx.lineWidth = 1.5 + flash * 3;
      if (p.bloom) {
        ctx.shadowColor = colours.signal;
        ctx.shadowBlur = 6 + flash * 18;
      }
      ctx.beginPath();
      ctx.arc(CX, CY, 108, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Player blips around the outer ring.
      const blips = blipPositions(snap);
      for (const b of blips) {
        const level = st.levels[b.userId ?? ''] ?? 0;
        const speaking = !!st.speaking[b.userId ?? ''] || level > 0.02;
        const flashAge = Date.now() - (st.flash[b.userId ?? ''] ?? 0);
        const hot = flashAge < 1200;
        ctx.save();
        const r = 7 + (speaking ? Math.min(6, level * 60) : 0);
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        if (hot) {
          ctx.fillStyle = colours.signal;
          if (p.bloom) {
            ctx.shadowColor = colours.signal;
            ctx.shadowBlur = 16;
          }
          ctx.fill();
        } else if (!b.listening) {
          ctx.strokeStyle = colours.dim;
          ctx.setLineDash([2, 3]);
          ctx.stroke();
        } else if (speaking) {
          ctx.fillStyle = colours.line;
          if (p.bloom) {
            ctx.shadowColor = '#ffffff';
            ctx.shadowBlur = 14;
          }
          ctx.fill();
        } else {
          ctx.strokeStyle = b.inVoice ? colours.line : colours.dim;
          ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = b.inVoice ? colours.line : colours.dim;
        ctx.font = '600 12px Oxanium, sans-serif';
        ctx.textAlign = b.x < CX ? 'right' : 'left';
        ctx.fillText(b.label.toUpperCase(), b.x + (b.x < CX ? -14 : 14), b.y + 4);
      }

      // Callouts: corner brackets on the blip and a numbered leader-line label (fade after 6 s).
      for (const c of st.callouts) drawCallout(ctx, c, blips, colours, p.reducedMotion);

      // Bottom tick row: master level meter from the spectrum, red while the limiter works.
      const spec = mixer?.spectrum ?? [];
      const blocks = 32;
      const x0 = 250;
      const bw = 500 / blocks;
      for (let i = 0; i < blocks; i++) {
        const v = spec.length ? (spec[Math.floor((i / blocks) * spec.length)] ?? 0) : 0;
        const hgt = 3 + v * 22;
        ctx.globalAlpha = 0.25 + v * 0.75;
        ctx.fillStyle = mixer?.limiting && v > 0.6 ? colours.signal : colours.line;
        ctx.fillRect(x0 + i * bw + 1.5, 500 - hgt, bw - 3, hgt);
      }
      ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      draw(now);
      if (document.hidden) timer = setTimeout(() => loop(performance.now()), 250);
      else raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onVis = () => {
      if (!document.hidden && timer) {
        clearTimeout(timer);
        timer = null;
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [size]);

  const scene = state?.scene.scenes.find((s) => s.id === state.scene.current);
  const np = state?.nowPlaying.music;
  const suggestion = state?.scene.suggestion ?? null;
  const suggestedScene = state?.scene.scenes.find((s) => s.id === suggestion?.sceneId);
  const undo = state?.scene.undoUntil && state.scene.undoUntil > Date.now();
  const markerX = 452 + 96 * tension;

  return (
    <div
      className="scope-wrap"
      ref={wrapRef}
      role="img"
      aria-label={`Scope: scene ${scene?.label ?? 'none'}, ${np ? `playing ${np.title}` : 'no music'}`}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: size.w,
          height: size.h,
          transform: 'translate(-50%, -50%)',
        }}
      >
        <svg className="frame" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <defs>
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation={prefs.bloom ? 1.6 : 0} result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {/* perspective lines, faint */}
          {[
            [70, 40],
            [930, 40],
            [930, 524],
            [70, 524],
          ].map(([x, y], i) => (
            <line
              key={i}
              x1={x}
              y1={y}
              x2={CX + (x! - CX) * 0.2}
              y2={CY + (y! - CY) * 0.36}
              stroke="var(--line-faint)"
            />
          ))}
          <polygon
            points={FRAME.map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke="var(--line)"
            strokeWidth={1.2}
            filter="url(#glow)"
          />
          <polygon
            points={FRAME.map(([x, y]) => `${CX + (x - CX) * 0.985},${CY + (y - CY) * 0.965}`).join(
              ' ',
            )}
            fill="none"
            stroke="var(--line-faint)"
          />
          {/* notch tick scale = tension gauge */}
          {Array.from({ length: 17 }, (_, i) => (
            <line
              key={i}
              x1={456 + i * 5.5}
              y1={66}
              x2={456 + i * 5.5}
              y2={i % 4 === 0 ? 56 : 60}
              stroke="var(--line-dim)"
            />
          ))}
          <polygon
            points={`${markerX},70 ${markerX + 6},76 ${markerX},82 ${markerX - 6},76`}
            fill="var(--signal)"
            style={{ transition: prefs.reducedMotion ? 'none' : 'all 0.6s' }}
          />
          {/* side tick scales: layer gain readouts */}
          {(['music', 'ambience', 'sfx'] as const).map((layer, li) => {
            const gain = state?.mixer.layers[layer].gain ?? 0;
            return (
              <g key={layer}>
                {Array.from({ length: 11 }, (_, i) => {
                  const y = 150 + li * 92 + (10 - i) * 6.4;
                  const on = i <= Math.round(gain / 10);
                  return (
                    <g key={i}>
                      <line
                        x1={44}
                        x2={on ? 58 : 52}
                        y1={y}
                        y2={y}
                        stroke={on ? 'var(--line)' : 'var(--line-faint)'}
                      />
                      <line
                        x1={956}
                        x2={on ? 942 : 948}
                        y1={y}
                        y2={y}
                        stroke={on ? 'var(--line)' : 'var(--line-faint)'}
                      />
                    </g>
                  );
                })}
                <text
                  x={64}
                  y={150 + li * 92 + 38}
                  fill="var(--line-mid)"
                  fontSize={12}
                  fontFamily="JetBrains Mono"
                  letterSpacing="0.08em"
                >
                  {layer.slice(0, 3).toUpperCase()} {gain}
                </text>
              </g>
            );
          })}
          {/* bottom status strip with a red progress bar */}
          <line x1={250} x2={750} y1={512} y2={512} stroke="var(--line-faint)" />
          <rect
            x={250}
            y={510}
            height={4}
            width={np && np.durationS ? 500 * Math.min(1, np.positionS / np.durationS) : 0}
            fill="var(--signal)"
          />
        </svg>
        <canvas ref={canvasRef} aria-hidden="true" />
        <div className="overlay">
          <div className="scope-microtext tl">
            <div className="signal">VANTARI · AC-7</div>
            <div>
              {state?.voice.channelName ? `CH ${state.voice.channelName}` : 'NO VOICE LINK'}
            </div>
            <div>
              MODE {state?.automation.mode.toUpperCase() ?? '—'}
              {state?.automation.locked ? ' · LOCK' : ''}
            </div>
          </div>
          <MicroTR />
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50.4%',
              transform: 'translate(-50%, -50%)',
              textAlign: 'center',
              width: '20%',
            }}
          >
            <div
              className="label"
              style={{ fontSize: Math.max(14, size.w / 34), letterSpacing: '0.18em' }}
            >
              {scene?.label ?? 'STANDBY'}
            </div>
            <div
              className="micro"
              style={{
                marginTop: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {np ? np.title : 'no music'}
            </div>
            {np ? (
              <div className="micro" style={{ marginTop: 2 }}>
                {formatDuration(np.positionS)} / {formatDuration(np.durationS)}
              </div>
            ) : null}
          </div>
          {suggestion && suggestedScene ? (
            <div
              className="suggest-callout"
              role="alertdialog"
              aria-label={`Suggestion: switch to ${suggestedScene.label}`}
            >
              <div className="label signal" style={{ whiteSpace: 'nowrap' }}>
                SUGGEST · {suggestedScene.label} · {Math.round(suggestion.confidence * 100)}%
              </div>
              <ul className="reasons">
                {suggestion.reasons.slice(0, 2).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <div className="row" style={{ flex: 'none' }}>
                <button
                  className="btn primary small"
                  onClick={() => void api.post(`/api/suggestion/${suggestion.suggestionId}/accept`)}
                >
                  Accept ⏎
                </button>
                <button
                  className="btn small"
                  onClick={() =>
                    void api.post(`/api/suggestion/${suggestion.suggestionId}/dismiss`)
                  }
                >
                  Dismiss Esc
                </button>
              </div>
            </div>
          ) : null}
          {undo ? (
            <div className="undo-callout">
              <button
                className="btn danger small"
                onClick={() => void api.post('/api/scene/revert')}
              >
                Revert to previous scene
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {suggestion && suggestedScene
          ? `Suggestion: ${suggestedScene.label}. Press Enter to accept or Escape to dismiss.`
          : ''}
      </span>
    </div>
  );
}

function MicroTR() {
  const state = useStore((s) => s.state);
  const log = useStore((s) => s.log);
  const lastLatency = useMemo(() => log.find((l) => l.latencyMs != null)?.latencyMs ?? null, [log]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const up = state ? formatDuration((now - state.startedAt) / 1000) : '--:--';
  const ears = state?.health.ears;
  return (
    <div className="scope-microtext tr">
      <div>LAT {lastLatency != null ? `${Math.round(lastLatency)} MS` : '— MS'}</div>
      <div>EARS {ears?.status === 'ok' ? 'LOCAL' : (ears?.status ?? '—').toUpperCase()}</div>
      <div>MIX 48K · 20MS</div>
      <div>UP {up}</div>
    </div>
  );
}

function currentPriority(s: NonNullable<ReturnType<typeof useStore.getState>['state']>): number {
  return s.scene.scenes.find((x) => x.id === s.scene.current)?.priority ?? 0;
}

interface Blip {
  x: number;
  y: number;
  userId: string | null;
  id: string;
  label: string;
  inVoice: boolean;
  listening: boolean;
}

function blipPositions(s: ReturnType<typeof useStore.getState>['state']): Blip[] {
  if (!s) return [];
  const inVoice = s.players.filter((p) => p.inVoice);
  const list = inVoice.length ? inVoice : s.players;
  const ring = RINGS[2];
  return list.map((p, i) => {
    const t =
      -Math.PI / 2 +
      (i * Math.PI * 2) / Math.max(1, list.length) +
      Math.PI / Math.max(2, list.length);
    return {
      x: CX + ring.rx * Math.cos(t),
      y: CY + ring.ry * Math.sin(t),
      userId: p.userId,
      id: p.id,
      label: p.character ?? p.displayName,
      inVoice: p.inVoice,
      listening: p.listening,
    };
  });
}

function drawChevron(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  t: number,
  colour: string,
  alpha: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t + Math.PI / 2);
  ctx.strokeStyle = colour;
  ctx.globalAlpha = Math.min(1, alpha + 0.2);
  ctx.beginPath();
  ctx.moveTo(-4, -3);
  ctx.lineTo(0, 2);
  ctx.lineTo(4, -3);
  ctx.stroke();
  ctx.restore();
}

function drawCallout(
  ctx: CanvasRenderingContext2D,
  c: Callout,
  blips: Blip[],
  colours: { line: string; signal: string },
  reduced: boolean,
): void {
  const age = Date.now() - c.at;
  if (age > 6000) return;
  const blip = blips.find(
    (b) => (c.subject && b.id === c.subject) || (c.userId && b.userId === c.userId),
  ) ?? { x: CX, y: CY - 108 };
  const alpha = age > 5000 ? (6000 - age) / 1000 : 1;
  const draw = reduced ? 1 : Math.min(1, age / 200);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = colours.signal;
  ctx.lineWidth = 1.5;
  // Corner brackets (lock-on marks).
  const r = 16;
  const k = 6;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(blip.x + sx * r, blip.y + sy * (r - k));
    ctx.lineTo(blip.x + sx * r, blip.y + sy * r);
    ctx.lineTo(blip.x + sx * (r - k), blip.y + sy * r);
    ctx.stroke();
  }
  // Leader line outwards, drawn over 200 ms.
  const dir = blip.x < CX ? -1 : 1;
  const ex = blip.x + dir * 70;
  const ey = blip.y - 44;
  ctx.beginPath();
  ctx.moveTo(blip.x + dir * r, blip.y - r);
  ctx.lineTo(
    blip.x + dir * r + (ex - blip.x - dir * r) * draw,
    blip.y - r + (ey - blip.y + r) * draw,
  );
  ctx.stroke();
  if (draw >= 1) {
    const text = `${String(c.seq).padStart(2, '0')} · ${c.label}`;
    ctx.font = '600 12px Oxanium, sans-serif';
    const w = ctx.measureText(text).width + 14;
    const bx = dir < 0 ? ex - w : ex;
    ctx.fillStyle = 'rgba(5,5,6,0.9)';
    ctx.fillRect(bx, ey - 11, w, 20);
    ctx.strokeRect(bx, ey - 11, w, 20);
    ctx.fillStyle = colours.line;
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + 7, ey + 4);
  }
  ctx.restore();
}
