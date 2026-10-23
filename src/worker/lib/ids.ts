// Time-sortable integer ids: milliseconds since 2025-01-01 times 2048, plus a sequence.
// They fit in 53 bits for about 139 years, so they survive JSON and JavaScript numbers.
// Generating ids in the Worker lets one D1 batch insert rows that reference each other.
const EPOCH = 1_735_689_600_000;
let lastMs = 0;
let seq = 0;

export function newId(now = Date.now()): number {
  const ms = Math.max(now - EPOCH, lastMs);
  if (ms === lastMs) {
    seq += 1;
    if (seq >= 2048) {
      lastMs = ms + 1;
      seq = Math.floor(Math.random() * 1024);
      return lastMs * 2048 + seq;
    }
  } else {
    lastMs = ms;
    // Start each millisecond at a random point so two isolates rarely collide.
    seq = Math.floor(Math.random() * 1024);
  }
  return lastMs * 2048 + seq;
}

export function idTime(id: number): number {
  return Math.floor(id / 2048) + EPOCH;
}
