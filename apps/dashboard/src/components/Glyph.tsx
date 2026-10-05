/** Original Cantina glyph: a circle cut by three lines of decreasing width (SPEC §12.2). */
export function Glyph({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="none" stroke="var(--signal)" strokeWidth="1.5" />
      <path d="M5 12h22M8 16h16M11 20h10" stroke="var(--line)" strokeWidth="1.5" />
    </svg>
  );
}
