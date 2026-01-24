export function dedupeDestinations(destinations) {
  const seen = new Set();
  const out = [];
  for (const d of destinations) {
    const key = String(d || "").trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
