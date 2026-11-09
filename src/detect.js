// Pure detection logic. No Discord calls here, so it is easy to test.
import { validateMnemonic } from '@scure/bip39';
import { wordlist as BIP39 } from '@scure/bip39/wordlists/english.js';
import { normalizeText, normalizeName, editDistance } from './normalize.js';
import { findAddresses } from './xrpl.js';

const BIP39_SET = new Set(BIP39);
const PHRASE_LENGTHS = [24, 21, 18, 15, 12];
// Seed words that are also everyday chat words. A real (random) phrase almost never
// has 3+ of these; a normal sentence almost always does.
const CHATTY_SEED_WORDS = new Set(`about above again all also always any away because before below between
can come day during few first give good great have into just know like little long make more much must
never next now off once one only other over own people please price pretty put right same say still such
sure thank that then there they thing this time today true try under very want way what when where will
year you coin token sell hold moon check soon real cool fun game hope deal boost level club art morning`.split(/\s+/));

// XRPL base58 alphabet (no 0, O, I, l). Family seeds start with "s".
const XRPL_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const FAMILY_SEED = new RegExp(`(?<![A-Za-z0-9])s[${XRPL_ALPHABET}]{27,32}(?![A-Za-z0-9])`);
// Xaman "secret numbers": 8 blocks of 6 digits.
const SECRET_NUMBERS = /(?<!\d)(?:\d{6}[\s,\-]+){7}\d{6}(?!\d)/;

const URL_RE = /https?:\/\/[^\s<>()\]]+/gi;
const MASKED_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg|discord\.me)\/[a-z0-9-]+/i;
// Longest first so the alternation never stops on a shorter prefix.
const TLDS = [
  'com', 'net', 'org', 'xyz', 'io', 'app', 'co', 'gg', 'me', 'link', 'site', 'online', 'top', 'info', 'live',
  'pro', 'fi', 'finance', 'cc', 'ru', 'cn', 'tk', 'ml', 'ga', 'cf', 'click', 'lol', 'vip', 'shop', 'store',
  'club', 'network', 'exchange', 'ai', 'to', 'ly', 'at', 'dev', 'world', 'cash', 'money', 'digital', 'website',
  'space', 'tech',
  // Endings scam kits favour
  'cafe', 'claims', 'claim', 'wallet', 'support', 'services', 'help', 'events', 'zone', 'rewards', 'gift', 'gifts',
  'bond', 'sbs', 'cfd', 'icu', 'buzz', 'quest', 'fun', 'pw', 'su', 'ws', 'biz', 'one', 'nft', 'crypto', 'global',
  'center', 'cloud', 'foundation', 'ventures', 'capital', 'markets', 'market', 'trade', 'trading', 'today', 'page',
  'host', 'llc', 'ltd', 'inc', 'us', 'uk', 'de', 'eu', 'ca', 'vc', 'ph', 'mx', 'tv', 'fm',
].sort((a, b) => b.length - a.length).join('|');
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
  if (cfg.blockedDomains.some((d) => hostMatches(host, d))) return 'blocked';
  if (cfg.allowedDomains.some((d) => hostMatches(host, d))) return 'allowed';
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
  if (hasRecoveryPhrase(content)) found.push('recovery phrase (BIP39)');
  return found;
}

/**
 * A recovery phrase is 12/15/18/21/24 seed words in a row that pass the BIP39 checksum
 * and don't read like a normal sentence. The checksum alone lets ~1 in 16 random
 * 12-word windows through, so the chatty-word cap is what keeps normal chat safe.
 */
function hasRecoveryPhrase(content) {
  const words = normalizeText(content).split(/[^a-z]+/).filter(Boolean);
  const runs = [];
  let cur = [];
  for (const w of words) {
    if (BIP39_SET.has(w)) cur.push(w);
    else { if (cur.length >= 12) runs.push(cur); cur = []; }
  }
  if (cur.length >= 12) runs.push(cur);

  for (const run of runs) {
    for (const n of PHRASE_LENGTHS) {
      for (let i = 0; i + n <= run.length; i++) {
        const win = run.slice(i, i + n);
        if (!validateMnemonic(win.join(' '), BIP39)) continue;
        // A message that is basically just the phrase gets caught no matter which words it uses.
        if (words.length <= n + 2) return true;
        const chatty = win.filter((w) => CHATTY_SEED_WORDS.has(w)).length;
        if (chatty <= Math.floor(n / 6)) return true;
      }
    }
  }
  return false;
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
  const addresses = findAddresses(content);
  const scamAddresses = addresses.filter((a) => (cfg.blockedAddresses ?? []).includes(a));

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
  for (const a of scamAddresses) { reasons.push(`known scam address: ${a}`); bump('remove'); }
  if (mentionCount >= cfg.massMentionLimit) { reasons.push(`mass mention (${mentionCount})`); bump('remove'); }

  for (const why of soft) {
    reasons.push(why);
    // Bait plus somewhere to go (a link, an invite, or an address to send to) is a removal.
    bump(riskyHosts.length || invite || addresses.length ? 'remove' : 'flag');
  }
  for (const h of riskyHosts) {
    reasons.push(`${h.kind} link: ${h.host}`);
    bump(isNew ? 'remove' : 'flag');
  }
  if (isNew && riskyHosts.length) reasons.push(`account is under ${cfg.minAccountAgeDays} days old`);

  return { verdict, reasons, hosts, addresses };
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
