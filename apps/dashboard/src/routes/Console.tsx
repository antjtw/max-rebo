import { EventLog } from '../panels/EventLog.tsx';
import { GamePanel } from '../panels/Game.tsx';
import { LayersPanel } from '../panels/Layers.tsx';
import { NowPlaying } from '../panels/NowPlaying.tsx';
import { ScenesPanel } from '../panels/Scenes.tsx';
import { Soundboard } from '../panels/Soundboard.tsx';
import { TranscriptPanel } from '../panels/Transcript.tsx';
import { Scope } from '../scope/Scope.tsx';

export function ConsoleRoute() {
  return (
    <main className="console" aria-label="Console">
      <div className="col col-left">
        <ScenesPanel />
        <LayersPanel />
      </div>
      <div className="col col-centre">
        <section className="panel" style={{ padding: 0 }} aria-label="The Scope">
          <Scope />
        </section>
        <div
          className="centre-bottom"
          style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 'var(--gap)' }}
        >
          <NowPlaying />
          <GamePanel />
        </div>
      </div>
      <div className="col col-right">
        <TranscriptPanel />
        <EventLog />
      </div>
      <Soundboard />
    </main>
  );
}
