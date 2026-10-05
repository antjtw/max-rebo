#!/usr/bin/env bash
# Generate speech fixtures with macOS `say` (SPEC §16.2). Output is gitignored test data.
set -euo pipefail
cd "$(dirname "$0")/.."
out=tests/fixtures/audio
mkdir -p "$out"
if ! command -v say >/dev/null 2>&1; then
  echo "macOS 'say' not found: fixtures can only be generated on the Mac."; exit 1
fi
phrases=(
  "ignite|I ignite my lightsaber"
  "ignite-right|Right, I ignite my lightsaber"
  "retract|I deactivate my lightsaber"
  "negated|I don't ignite my lightsaber yet"
  "question|Should I ignite my lightsaber?"
  "kael-ignites|Kael ignites his saber"
  "blaster|I fire my blaster"
  "punch-it|Punch it!"
  "ambush|It's an ambush!"
  "rest|We take a full rest"
)
voices=(Daniel Kate Serena Samantha)
rates=(160 200)
for entry in "${phrases[@]}"; do
  id="${entry%%|*}"; text="${entry#*|}"
  for v in "${voices[@]}"; do
    say -v "$v" -o /dev/null "x" 2>/dev/null || continue
    for r in "${rates[@]}"; do
      f="$out/$id.$v.$r"
      say -v "$v" -r "$r" -o "$f.aiff" "$text"
      ffmpeg -v error -y -i "$f.aiff" -ac 1 -ar 16000 -sample_fmt s16 "$f.wav"
      rm "$f.aiff"
      echo "$text" > "$f.txt"
    done
  done
done
echo "Fixtures written to $out"
