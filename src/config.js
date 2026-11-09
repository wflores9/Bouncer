// Config loading. config.json is the base; mods can add to the lists at runtime
// with /bouncer commands, and those additions live in the data file.
import { readFileSync } from 'node:fs';

export const DEFAULTS = {
  reportTicketPrefix: 'report-',
  minAccountAgeDays: 7,
  timeoutMinutes: 60,
  massMentionLimit: 5,
  raid: { joins: 8, windowSeconds: 60, durationMinutes: 10, timeoutNewAccounts: true },
  flood: { windowSeconds: 10, maxMessages: 7, dupWindowSeconds: 120, maxDuplicates: 3, crossChannelLimit: 3 },
  strikes: { expireDays: 30, steps: [{ at: 2, timeoutMinutes: 360 }, { at: 3, timeoutMinutes: 1440 }] },
  gate: { minSecondsAfterJoin: 15 },
  xrpl: {
    rpc: ['https://xrplcluster.com/', 'https://s1.ripple.com:51234/', 'https://s2.ripple.com:51234/'],
    holderSyncHours: 24,
  },
  dataFile: './data/bouncer.json',
  exemptRoleIds: [],
  protectedNames: [],
  allowedDomains: [],
  protectedBrands: [],
  blockedDomains: [],
  blockedAddresses: [],
  shorteners: [],
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** Fill missing keys (one level of nesting) so older config files keep working. */
export function withDefaults(cfg) {
  const out = { ...DEFAULTS, ...cfg };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (isPlainObject(v)) out[k] = { ...v, ...(cfg[k] ?? {}) };
  }
  return out;
}

export function loadConfig(path) {
  return withDefaults(JSON.parse(readFileSync(path, 'utf8')));
}

const uniq = (a) => [...new Set(a)];

/** Base config + runtime lists. A runtime block always beats an allow. */
export function effectiveConfig(base, lists) {
  const blockedDomains = uniq([...base.blockedDomains, ...lists.blockedDomains]);
  return {
    ...base,
    blockedDomains,
    allowedDomains: uniq([...base.allowedDomains, ...lists.allowedDomains]).filter((d) => !lists.blockedDomains.includes(d)),
    protectedNames: uniq([...base.protectedNames, ...lists.protectedNames]),
    blockedAddresses: uniq([...base.blockedAddresses, ...lists.blockedAddresses]),
  };
}
