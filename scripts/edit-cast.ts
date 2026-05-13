#!/usr/bin/env bun
// Edit an asciinema v3 .cast file: drop a head window, cap idle gaps, optional speedup.
//
// Usage:
//   bun scripts/edit-cast.ts <in.cast> <out.cast> [--drop-head 3] [--max-gap 0.5] [--speed 1.5]

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const [inPath, outPath] = args;
if (!inPath || !outPath) {
  console.error("usage: edit-cast.ts <in> <out> [--drop-head N] [--max-gap S] [--speed X]");
  process.exit(1);
}
const flag = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const dropHead = flag("drop-head", 0); // seconds to skip from start
const dropTail = flag("drop-tail", 0); // seconds to trim from the end
const maxGap = flag("max-gap", 0.5); // cap any single delta to this many seconds
const speed = flag("speed", 1.0); // playback speedup multiplier

const lines = readFileSync(inPath, "utf8").split("\n").filter(Boolean);
const header = JSON.parse(lines[0]);
const out: string[] = [JSON.stringify(header)];

// Compute total duration so we can drop the tail window.
let totalDuration = 0;
for (let i = 1; i < lines.length; i++) totalDuration += JSON.parse(lines[i])[0];
const tailCutoff = totalDuration - dropTail;

let absIn = 0; // absolute time in source
let droppedHead = false;
for (let i = 1; i < lines.length; i++) {
  const ev = JSON.parse(lines[i]) as [number, string, string];
  let [delta, kind, data] = ev;
  absIn += delta;

  if (!droppedHead && absIn < dropHead) continue; // skip event entirely
  if (dropTail > 0 && absIn > tailCutoff) break; // stop once we cross tail cutoff
  if (!droppedHead) {
    droppedHead = true;
    delta = 0; // first kept event starts at t=0
  } else {
    if (delta > maxGap) delta = maxGap;
    delta = delta / speed;
  }
  out.push(JSON.stringify([Number(delta.toFixed(3)), kind, data]));
}

writeFileSync(outPath, out.join("\n") + "\n");
const newTotal = out.slice(1).reduce((s, l) => s + JSON.parse(l)[0], 0);
console.log(`wrote ${outPath} — ${out.length - 1} events, ${newTotal.toFixed(2)}s`);
