// Reconciles the scoring model's free-text staff[] names against the STAFF
// display names actually seen in the transcript. The prompt asks for verbatim
// names, but nothing enforces it — small models occasionally garble unusual
// proper nouns ("Gilad Resisi" → "Gilad Resski"), and every garbled name
// becomes a permanent phantom staff tag in Influx. Exact/near matches snap to
// the canonical transcript spelling; everything else is dropped.

export interface StaffEntry {
  name: string;
  tone: number;
  clarity: number;
  correctness: number;
}

export interface ReconcileResult {
  staff: StaffEntry[];
  snapped: Array<{ from: string; to: string }>;
  dropped: string[];
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

// knownNames = null means the snapshot predates this feature (rows written
// before the staffNames column existed) — pass the model output through
// unvalidated rather than dropping everything.
export function reconcileStaffNames(staff: StaffEntry[], knownNames: string[] | null): ReconcileResult {
  if (knownNames === null) return { staff, snapped: [], dropped: [] };

  const canonicalByNorm = new Map<string, string>();
  for (const name of knownNames) {
    if (!canonicalByNorm.has(normalize(name))) canonicalByNorm.set(normalize(name), name);
  }

  const kept: StaffEntry[] = [];
  const seen = new Set<string>();
  const snapped: Array<{ from: string; to: string }> = [];
  const dropped: string[] = [];

  for (const entry of staff) {
    const norm = normalize(entry.name);
    let canonical = canonicalByNorm.get(norm);

    if (canonical === undefined) {
      // Nearest known name within an edit-distance budget of ~1/4 of its
      // length; ties are ambiguous and treated as no match.
      let best: { name: string; dist: number } | null = null;
      let tied = false;
      for (const [knownNorm, knownCanonical] of canonicalByNorm) {
        const dist = levenshtein(norm, knownNorm);
        if (dist > Math.max(1, Math.floor(knownNorm.length / 4))) continue;
        if (best === null || dist < best.dist) {
          best = { name: knownCanonical, dist };
          tied = false;
        } else if (dist === best.dist && knownCanonical !== best.name) {
          tied = true;
        }
      }
      if (best !== null && !tied) canonical = best.name;
    }

    if (canonical === undefined) {
      dropped.push(entry.name);
      continue;
    }
    if (seen.has(canonical)) {
      // Two model entries collapsed onto one person — keep the first.
      dropped.push(entry.name);
      continue;
    }
    seen.add(canonical);
    if (canonical !== entry.name) snapped.push({ from: entry.name, to: canonical });
    kept.push({ ...entry, name: canonical });
  }

  return { staff: kept, snapped, dropped };
}
