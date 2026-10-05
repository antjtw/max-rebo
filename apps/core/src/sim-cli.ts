/**
 * `npm run sim -- --as james --say "I ignite my lightsaber"`: injects a line through the running
 * core's simulator endpoint (SPEC §15.2).
 */
import { loadEnv } from './env.ts';

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const as = get('--as');
const say = get('--say');
if (!as || !say) {
  console.error('Usage: npm run sim -- --as <playerId> --say "<text>"');
  process.exit(1);
}
const env = loadEnv();
const res = await fetch(`http://127.0.0.1:${env.CANTINA_PORT}/api/sim/say`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ playerId: as, text: say }),
}).catch(() => null);
if (!res) {
  console.error('Cantina is not running (start it with npm run dev).');
  process.exit(1);
}
const tested = await fetch(`http://127.0.0.1:${env.CANTINA_PORT}/api/triggers/test`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ playerId: as, text: say }),
}).then(
  (r) =>
    r.json() as Promise<
      {
        triggerId: string;
        fired: boolean;
        reason: string | null;
        confidence: number;
        subject: string | null;
      }[]
    >,
);
console.log(res.ok ? `Sent as ${as}: "${say}"` : `Failed: ${await res.text()}`);
for (const t of tested) {
  console.log(
    `  ${t.fired ? '✔' : '·'} ${t.triggerId} (conf ${t.confidence}, subject ${t.subject ?? '-'})${t.reason ? ` suppressed: ${t.reason}` : ''}`,
  );
}
