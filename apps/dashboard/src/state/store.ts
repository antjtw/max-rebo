import { create } from 'zustand';
import type { StateSnapshot, Suggestion, WsServerMessage } from '@cantina/shared';

export interface LogEntry {
  id: number;
  ts: number;
  kind: 'scene' | 'sfx' | 'trigger' | 'suggest' | 'error' | 'game' | 'track' | 'system';
  text: string;
  latencyMs?: number | null;
}

export interface Callout {
  seq: number;
  triggerId: string;
  userId: string | null;
  subject: string | null;
  label: string;
  at: number;
}

export interface TranscriptView {
  utteranceId: string;
  userId: string;
  text: string;
  final: boolean;
  ts: number;
}

export interface MixerLive {
  master: number;
  masterLevel: number;
  limiting: boolean;
  spectrum: number[];
  layers: Record<string, { gain: number; muted: boolean; level: number; duckDb: number }>;
}

interface Store {
  connected: boolean;
  state: StateSnapshot | null;
  mixer: MixerLive | null;
  levels: Record<string, number>;
  speaking: Record<string, boolean>;
  flash: Record<string, number>;
  scores: Record<string, number>;
  log: LogEntry[];
  transcript: TranscriptView[];
  callouts: Callout[];
  sceneFlashAt: number;
  scanProgress: { phase: string; progress: number; message?: string } | null;
  toast: { text: string; kind: 'info' | 'error'; at: number } | null;
  setToast: (text: string, kind?: 'info' | 'error') => void;
  clearTranscript: () => void;
}

export const useStore = create<Store>((set) => ({
  connected: false,
  state: null,
  mixer: null,
  levels: {},
  speaking: {},
  flash: {},
  scores: {},
  log: [],
  transcript: [],
  callouts: [],
  sceneFlashAt: 0,
  scanProgress: null,
  toast: null,
  setToast: (text, kind = 'info') => set({ toast: { text, kind, at: Date.now() } }),
  clearTranscript: () => set({ transcript: [] }),
}));

let logId = 0;
const MAX_LOG = 300;

function pushLog(entry: Omit<LogEntry, 'id'>): void {
  useStore.setState((s) => ({ log: [{ ...entry, id: ++logId }, ...s.log].slice(0, MAX_LOG) }));
}

function nameOf(userId: string | null | undefined): string {
  if (!userId) return 'table';
  const p = useStore.getState().state?.players.find((x) => x.userId === userId || x.id === userId);
  return p ? (p.character ?? p.displayName) : userId;
}

function sceneLabel(id: string | null | undefined): string {
  return useStore.getState().state?.scene.scenes.find((s) => s.id === id)?.label ?? id ?? '—';
}

/** Apply one server event to the store. Exported for tests. */
export function applyEvent(type: string, ts: number, p: Record<string, unknown>): void {
  const st = useStore.getState();
  switch (type) {
    case 'mixer.state':
      useStore.setState({ mixer: p as unknown as MixerLive });
      break;
    case 'voice.level':
      useStore.setState({ levels: { ...st.levels, [p.userId as string]: p.rms as number } });
      break;
    case 'voice.speaking':
      useStore.setState({
        speaking: { ...st.speaking, [p.userId as string]: p.speaking as boolean },
      });
      break;
    case 'scene.scored':
      useStore.setState({ scores: p.scores as Record<string, number> });
      break;
    case 'transcript.partial':
    case 'transcript.final': {
      const line: TranscriptView = {
        utteranceId: p.utteranceId as string,
        userId: p.userId as string,
        text: p.text as string,
        final: type === 'transcript.final',
        ts,
      };
      const lines = st.transcript.filter(
        (l) => l.utteranceId !== line.utteranceId || (l.final && !line.final),
      );
      if (!lines.some((l) => l.utteranceId === line.utteranceId)) lines.push(line);
      // Memory only, and trimmed in the browser too.
      useStore.setState({ transcript: lines.slice(-150) });
      break;
    }
    case 'trigger.matched': {
      const label = `${String(p.triggerId).replace(/-/g, ' ').toUpperCase()}${p.subject ? ` · ${nameOf(p.subject as string).toUpperCase()}` : ''}`;
      const c: Callout = {
        seq: p.seq as number,
        triggerId: p.triggerId as string,
        userId: (p.userId as string) ?? null,
        subject: (p.subject as string) ?? null,
        label,
        at: Date.now(),
      };
      useStore.setState({
        callouts: [...st.callouts.filter((x) => Date.now() - x.at < 6000), c].slice(-6),
        flash: { ...st.flash, [(p.userId as string) ?? '']: Date.now() },
      });
      pushLog({
        ts,
        kind: 'trigger',
        text: `${String(p.triggerId)} · ${nameOf(p.userId as string)} (${Math.round((p.confidence as number) * 100)}%)`,
        latencyMs: p.latencyMs as number | null,
      });
      break;
    }
    case 'trigger.suppressed':
      pushLog({
        ts,
        kind: 'trigger',
        text: `${String(p.triggerId)} suppressed: ${String(p.reason).replace('_', ' ')}`,
      });
      break;
    case 'sfx.fired':
      pushLog({
        ts,
        kind: 'sfx',
        text: `SFX ${String(p.title ?? p.sfxId)}${p.subject ? ` · ${nameOf(p.subject as string)}` : ''}`,
      });
      break;
    case 'scene.changed':
      useStore.setState({ sceneFlashAt: Date.now() });
      pushLog({
        ts,
        kind: 'scene',
        text: `Scene → ${sceneLabel(p.to as string)} (${String(p.cause).replace('_', ' ')})`,
      });
      patchState((s) => ({
        ...s,
        scene: {
          ...s.scene,
          current: p.to as string,
          previous: (p.from as string) ?? null,
          undoUntil: (p.undoUntil as number) ?? null,
        },
      }));
      break;
    case 'scene.suggested':
      pushLog({
        ts,
        kind: 'suggest',
        text: `Suggest ${sceneLabel(p.sceneId as string)} (${Math.round((p.confidence as number) * 100)}%)`,
      });
      patchState((s) => ({ ...s, scene: { ...s.scene, suggestion: p as unknown as Suggestion } }));
      break;
    case 'scene.suggestion_resolved':
      if (p.outcome !== 'expired')
        pushLog({
          ts,
          kind: 'suggest',
          text: `${sceneLabel(p.sceneId as string)} ${String(p.outcome)}`,
        });
      patchState((s) =>
        s.scene.suggestion?.suggestionId === p.suggestionId
          ? { ...s, scene: { ...s.scene, suggestion: null } }
          : s,
      );
      break;
    case 'track.started':
      pushLog({ ts, kind: 'track', text: `${String(p.layer)}: ${String(p.title)}` });
      break;
    case 'game.roll':
      pushLog({
        ts,
        kind: 'game',
        text: `Dyad ${String(p.balance)}/${String(p.despair)} · ${String(p.outcome).replace(/_/g, ' ')}`,
      });
      break;
    case 'game.despair':
      if ((p.delta as number) !== 0)
        pushLog({
          ts,
          kind: 'game',
          text: `Despair ${(p.delta as number) > 0 ? '+' : ''}${String(p.delta)} → ${String(p.pool)}`,
        });
      patchState((s) => ({
        ...s,
        game: { ...s.game, despairPool: p.pool as number },
        scene: { ...s.scene, tensionStep: p.tensionStep as number },
      }));
      break;
    case 'game.focus':
      pushLog({
        ts,
        kind: 'game',
        text: p.holder === 'gm' ? 'The GM takes the Focus' : 'The Focus returns to the Heroes',
      });
      patchState((s) => ({ ...s, game: { ...s.game, focus: p.holder as 'gm' | 'heroes' } }));
      break;
    case 'library.scan':
      useStore.setState({
        scanProgress:
          p.phase === 'done'
            ? null
            : {
                phase: p.phase as string,
                progress: p.progress as number,
                message: p.message as string | undefined,
              },
      });
      if (p.phase === 'done' && p.message) pushLog({ ts, kind: 'system', text: String(p.message) });
      break;
    case 'library.gap':
      pushLog({ ts, kind: 'system', text: `Library gap: ${String(p.message)}` });
      break;
    case 'log.error':
      pushLog({ ts, kind: 'error', text: String(p.message) });
      break;
    case 'system.health':
      patchState((s) => ({
        ...s,
        health: {
          ...s.health,
          [p.component as string]: { status: p.status, message: p.message },
        } as StateSnapshot['health'],
      }));
      break;
    case 'automation.state':
      patchState((s) => ({
        ...s,
        automation: {
          mode: p.mode as StateSnapshot['automation']['mode'],
          locked: p.locked as boolean,
        },
      }));
      break;
    case 'listening.state':
      patchState((s) => ({
        ...s,
        listening: {
          enabled: p.enabled as boolean,
          excludedUserIds: p.excludedUserIds as string[],
        },
      }));
      break;
  }
}

function patchState(fn: (s: StateSnapshot) => StateSnapshot): void {
  const s = useStore.getState().state;
  if (s) useStore.setState({ state: fn(s) });
}

export function applyMessage(msg: WsServerMessage): void {
  if (msg.kind === 'snapshot') useStore.setState({ state: msg.state });
  else applyEvent(msg.type, msg.ts, (msg.payload ?? {}) as Record<string, unknown>);
}

/** Connect and keep reconnecting (SPEC §4.1: the dashboard is stateless). */
export function connect(): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 500;
  const open = () => {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      delay = 500;
      useStore.setState({ connected: true });
    };
    ws.onmessage = (e) => {
      try {
        applyMessage(JSON.parse(e.data as string) as WsServerMessage);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      useStore.setState({ connected: false });
      if (!stopped) setTimeout(open, (delay = Math.min(5000, delay * 1.6)));
    };
  };
  open();
  return () => {
    stopped = true;
    ws?.close();
  };
}
