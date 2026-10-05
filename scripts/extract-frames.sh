#!/usr/bin/env bash
# Extract reference stills from docs/style/reference.mov into docs/style/frames/ (Appendix B).
set -euo pipefail
cd "$(dirname "$0")/.."
src=docs/style/reference.mov
[[ -f "$src" ]] || { echo "Add $src first (docs/HUMAN-TASKS.md)"; exit 1; }
mkdir -p docs/style/frames
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")
for i in 1 2 3 4 5 6 7 8; do
  t=$(awk -v d="$dur" -v i="$i" 'BEGIN { printf "%.2f", d * (i - 0.5) / 8 }')
  ffmpeg -v error -y -ss "$t" -i "$src" -frames:v 1 -vf "scale=1280:-2" "docs/style/frames/frame-$i.png"
done
echo "Wrote $(ls docs/style/frames | wc -l | tr -d ' ') frames to docs/style/frames/"
