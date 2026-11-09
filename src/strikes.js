// Strike escalation. A strike is a mod /warn or an automatic removal by Bouncer.

/**
 * Which escalation step applies at this strike count?
 * @param {number} count  active strikes including the new one
 * @param {{at:number, timeoutMinutes:number}[]} steps
 * @returns {{at:number, timeoutMinutes:number, top:boolean} | null}
 */
export function strikeAction(count, steps) {
  const sorted = [...steps].sort((a, b) => a.at - b.at);
  let hit = null;
  for (const s of sorted) if (count >= s.at) hit = s;
  if (!hit) return null;
  return { ...hit, top: hit === sorted[sorted.length - 1] };
}

/** Discord caps timeouts at 28 days. */
export function clampTimeoutMinutes(m) {
  return Math.max(1, Math.min(m, 28 * 24 * 60));
}

export function formatMinutes(m) {
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}
