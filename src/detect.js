// Pure detection logic. No Discord calls here, so it is easy to test.
import { wordlist as BIP39 } from '@scure/bip39/wordlists/english.js';
import { normalizeText, normalizeName, editDistance } from './normalize.js';

const BIP39_SET = new Set(BIP39);

// XRPL base58 alphabet (no 0, O, I, l). Family seeds start with "s".
const XRPL_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const FAMILY_SEED = new RegExp(`(?<![A-Za-z0-9])s[${XRPL_ALPHABET}]{27,32}(?![A-Za-z0-9])`);
// Xaman "secret numbers": 8 blocks of 6 digits.
const SECRET_NUMBERS = /(?<!\d)(?:\d{6}[\s,\-]+){7}\d{6}(?!\d)/;

const URL_RE = /https?:\/\/[^\s<>()\]]+/gi;
const MASKED_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg|discord\.me)\/[a-z0-9-]+/i;
const TLDS = 'com|net|org|xyz|io|app|co|gg|me|link|site|online|top|info|live|pro|fi|finance|cc|ru|cn|tk|ml|ga|cf|click|lol|vip|shop|store|club|network|exchange|ai|to|ly|at|dev|world|cash|money|digital|website|space|tech';
const BARE_DOMAIN_RE = new RegExp(
  `(?<![@\\w.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))(?![\\w-])`,
  'gi',
);

const NEGATION = /\b(never|don'?t|do not|won'?t|will not|nobody|no one|not|nor)\b/;

// Bait that is bad on its own.
const HARD_BAIT = [
  { re: /\b(send|share|give|paste|provide|submit|dm)\s+(me\s+|us\s+|it\s+)?(your\s+|the\s+)?(seed|secret|recovery|family|mnemonic)\s*(phrase|key|words?|numbers?)?\b/, why: 'asks for a seed / secret phrase' },
  { re: /\b(send|share|give|paste|provide|submit|dm)\s+(me\s+|us\s+)?(your\s+|the\s+)?private\s+keys?\b/, why: 'asks for a private key' },
  { re: /\b(double|2x|triple|3x)\s+(your\s+)?(xrp|flr|fxrp|tokens?|crypto)\b/, why: 'doubling scam' },
  { re: /\bsend\s+\d[\d,.]*\s*(xrp|flr)\b.{0,60}\b(get|receive|back|return)\b/, why: 'send-to-receive scam' },
  { re: /\bsign\s+(this|the|a)\s+(transaction|tx|payload|request)\b.{0,60}\b(claim|verify|unlock|airdrop|reward)/, why: 'asks to sign a transaction to claim' },
];

// Bait that is suspicious alone, and removable when paired with a link or invite.
const SOFT_BAIT = [
  { re: /\b(enter|type|import)\s+(your\s+|the\s+)?(seed|secret|recovery|family|mnemonic)\s*(phrase|key|words?|numbers?)?\b(?=.*\b(here|form|site|link|portal|page|below)\b)/, why: 'points to a form for a seed / secret' },
  { re: /\b(validate|verify|sync|synchroni[sz]e|connect|rectify|restore|unlock|migrate|whitelist)\s+(your\s+)?(wallet|account|xaman|xumm|trustline|assets?)\b/, why: 'wallet "verification" bait' },
  { re: /\b(claim|receive|collect)\s+(your\s+)?(free\s+)?(airdrop|rewards?|xrp|flr|tokens?|allocation|nfts?)\b/, why: 'claim / airdrop bait' },
  { re: /\bfree\s+(xrp|flr|airdrop|nfts?|tokens?|mint)\b/, why: '"free crypto" bait' },
  { re: /\b(dm|message|contact|text)\s+(me|us|an?\s+admin|support|the\s+team)\b(?=.*\b(wallet|funds|recover|refund|ticket|support|stuck|locked)\b)/, why: 'move-to-DM support bait' },
];

function negated(text, index) {
  return NEGATION.test(text.slice(Math.max(0, index - 30), index));
}

function matchBait(text, list) {
  const hits = [];
  for (const { re, why } of list) {
    const m = re.exec(text);
    if (m && !negated(text, m.index)) hits.push(why);
  }
  return hits;
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function labelOf(host) {
  const parts = host.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : host;
}

/** Pull every link host out of a message (full URLs and bare domains). */
export function extractHosts(content = '') {
  const hosts = new Set();
  let rest = content;
  for (const raw of content.match(URL_RE) ?? []) {
    try {
      hosts.add(new URL(raw).hostname.toLowerCase().replace(/\.$/, ''));
    } catch { /* not a valid URL */ }
    rest = rest.replace(raw, ' ');
  }
  for (const m of rest.matchAll(BARE_DOMAIN_RE)) hosts.add(m[1].toLowerCase());
  return [...hosts];
}

/**
 * Classify one host.
 * allowed | blocked | punycode | lookalike | shortener | suspicious | unknown
 */
export function classifyHost(host, cfg) {
  if (cfg.allowedDomains.some((d) => hostMatches(host, d))) return 'allowed';
  if (cfg.blockedDomains.some((d) => hostMatches(host, d))) return 'blocked';
  if (host.split('.').some((p) => p.startsWith('xn--'))) return 'punycode';
  if (cfg.shorteners.some((d) => hostMatches(host, d))) return 'shortener';

  const label = labelOf(host);
  const flat = label.replace(/-/g, '');
  for (const brand of cfg.protectedBrands) {
    const b = brand.replace(/-/g, '');
    if (flat === b) return 'lookalike'; // brand name on the wrong domain
    if (b.length >= 5) {
      const d = editDistance(flat, b);
      if (d > 0 && d <= (b.length >= 8 ? 2 : 1)) return 'lookalike';
      if (flat.includes(b)) return 'suspicious';
    } else if (flat.length === b.length && editDistance(flat, b) === 1) {
      return 'lookalike';
    }
  }
  // Brand used as a subdomain on someone else's domain: xaman.claim-portal.com
  const sub = host.split('.').slice(0, -2).join('.');
  if (sub && cfg.protectedBrands.some((b) => sub.includes(b))) return 'lookalike';
  return 'unknown';
}

/** Masked links whose visible text names a different domain than the real target. */
export function findDisguisedLinks(content = '') {
  const out = [];
  for (const m of content.matchAll(MASKED_LINK_RE)) {
    const shown = extractHosts(m[1])[0];
    let real;
    try { real = new URL(m[2]).hostname.toLowerCase(); } catch { continue; }
    if (shown && !hostMatches(real, shown)) out.push({ shown, real });
  }
  return out;
}

/** Secrets posted in public: XRPL family seed, Xaman secret numbers, BIP39 mnemonic. */
export function findSecrets(content = '') {
  const found = [];
  if (FAMILY_SEED.test(content)) found.push('XRPL family seed');
  if (SECRET_NUMBERS.test(content)) found.push('Xaman secret numbers');
  const words = normalizeText(content).split(/[^a-z]+/).filter(Boolean);
  let run = 0;
  for (const w of words) {
    run = BIP39_SET.has(w) ? run + 1 : 0;
    if (run >= 12) { found.push('recovery phrase (12+ BIP39 words)'); break; }
  }
  return found;
}

/**
 * Scan one message.
 * @returns {{ verdict: 'none'|'flag'|'remove'|'secret', reasons: string[], hosts: object[] }}
 *  - secret: delete to protect the poster, DM them, no timeout
 *  - remove: delete + timeout + log
 *  - flag:   log only
 */
export function scanMessage({ content = '', mentionCount = 0, accountAgeDays = Infinity }, cfg) {
  const reasons = [];
  const secrets = findSecrets(content);
  if (secrets.length) return { verdict: 'secret', reasons: secrets.map((s) => `posted a ${s}`), hosts: [] };

  const text = normalizeText(content);
  const hard = matchBait(text, HARD_BAIT);
  const soft = matchBait(text, SOFT_BAIT);
  const invite = INVITE_RE.test(content);
  const disguised = findDisguisedLinks(content);
  const hosts = extractHosts(content).map((host) => ({ host, kind: classifyHost(host, cfg) }));

  const badHosts = hosts.filter((h) => ['blocked', 'punycode', 'lookalike'].includes(h.kind));
  const riskyHosts = hosts.filter((h) => ['unknown', 'shortener', 'suspicious'].includes(h.kind));
  const isNew = accountAgeDays < cfg.minAccountAgeDays;

  let verdict = 'none';
  const bump = (v) => {
    const rank = { none: 0, flag: 1, remove: 2 };
    if (rank[v] > rank[verdict]) verdict = v;
  };

  for (const why of hard) { reasons.push(why); bump('remove'); }
  for (const h of badHosts) { reasons.push(`${h.kind} domain: ${h.host}`); bump('remove'); }
  for (const d of disguised) { reasons.push(`disguised link: shows ${d.shown}, goes to ${d.real}`); bump('remove'); }
  if (invite) { reasons.push('Discord invite link'); bump('remove'); }
  if (mentionCount >= cfg.massMentionLimit) { reasons.push(`mass mention (${mentionCount})`); bump('remove'); }

  for (const why of soft) {
    reasons.push(why);
    bump(riskyHosts.length || invite ? 'remove' : 'flag');
  }
  for (const h of riskyHosts) {
    reasons.push(`${h.kind} link: ${h.host}`);
    bump(isNew ? 'remove' : 'flag');
  }
  if (isNew && riskyHosts.length) reasons.push(`account is under ${cfg.minAccountAgeDays} days old`);

  return { verdict, reasons, hosts };
}

/**
 * Does this name impersonate staff or a protected name?
 * @returns {{ level: 'exact'|'similar', target: string } | null}
 */
export function checkName(name, targets) {
  const n = normalizeName(name);
  if (n.length < 3) return null;
  let similar = null;
  for (const raw of targets) {
    const t = normalizeName(raw);
    if (t.length < 3) continue;
    if (n === t) return { level: 'exact', target: raw };
    if (t.length >= 5 && n.includes(t) && /(support|admin|mod|official|team|help|staff|desk)/.test(n.replace(t, ''))) {
      return { level: 'exact', target: raw };
    }
    if (t.length >= 5 && !similar) {
      const d = editDistance(n, t);
      if (d > 0 && d <= (t.length >= 8 ? 2 : 1)) similar = { level: 'similar', target: raw };
    }
  }
  return similar;
}
