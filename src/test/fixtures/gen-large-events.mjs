// Generate a synthetic .ass with N dialogue events for manual scale testing.
// Usage: node src/test/fixtures/gen-large-events.mjs 71234 > _temp/large.ass
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const n = Number(process.argv[2] ?? 71234);
const out = process.argv[3] ?? '_temp/large.ass';

const header =
`[Script Info]
Title: Scale test (${n} events)
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,54,&H00FFFFFF&,&H000000FF&,&H00000000&,&H80000000&,0,0,0,0,100,100,0,0,1,2,2,2,48,48,40,1
Style: Title,Impact,92,&H00F0F0F0&,&H0000A5FF&,&H00101010&,&H00000000&,-1,0,0,0,100,100,0,0,1,4,3,8,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const lines = [header];
for (let i = 0; i < n; i++) {
  const t = i * 0.1;
  const start = fmt(t);
  const end = fmt(t + 2);
  const style = i % 7 === 0 ? 'Title' : 'Default';
  lines.push(`Dialogue: 0,${start},${end},${style},,0,0,0,,{\\fad(200,200)}Line ${i} — the quick brown fox jumps over the lazy dog.`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${n} events to ${out}`);

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `0:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
