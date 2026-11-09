// Read-only XRPL helpers over public JSON-RPC. No keys, no signing, ever.
import { createHash } from 'node:crypto';

const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const RIPPLE_EPOCH = 946_684_800;
export const ADDRESS_IN_TEXT = /(?<![A-Za-z0-9])r[1-9A-HJ-NP-Za-km-z]{24,34}(?![A-Za-z0-9])/g;
const TX_HASH = /^[A-F0-9]{64}$/i;

const sha256 = (b) => createHash('sha256').update(b).digest();

function base58Decode(str) {
  let n = 0n;
  for (const ch of str) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let lead = 0;
  for (const ch of str) { if (ch === ALPHABET[0]) lead++; else break; }
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')]);
}

/** Classic r-address with a valid checksum. */
export function isValidAddress(addr) {
  if (typeof addr !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr)) return false;
  const b = base58Decode(addr);
  if (!b || b.length !== 25 || b[0] !== 0) return false;
  return sha256(sha256(b.subarray(0, 21))).subarray(0, 4).equals(b.subarray(21));
}

export function findAddresses(text = '') {
  return [...new Set(text.match(ADDRESS_IN_TEXT) ?? [])].filter(isValidAddress);
}

export function isTxHash(s) { return TX_HASH.test(s ?? ''); }

/** "SOLO" -> 40-char hex; "USD" stays; hex stays (uppercased). */
export function toCurrencyCode(input) {
  const s = String(input).trim();
  if (/^[A-F0-9]{40}$/i.test(s)) return s.toUpperCase();
  if (s.length === 3) return s;
  return Buffer.from(s, 'utf8').toString('hex').toUpperCase().padEnd(40, '0').slice(0, 40);
}

export function currencyName(code) {
  if (!/^[A-F0-9]{40}$/i.test(code)) return code;
  const txt = Buffer.from(code.replace(/(00)+$/, ''), 'hex').toString('utf8');
  return /^[\x20-\x7e]+$/.test(txt) ? txt : `${code.slice(0, 8)}…`;
}

export function formatAmount(a) {
  if (a == null) return '—';
  if (typeof a === 'string') return `${(Number(a) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} XRP`;
  if (a.mpt_issuance_id) return `${a.value} MPT ${a.mpt_issuance_id.slice(0, 10)}…`;
  return `${Number(a.value).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${currencyName(a.currency)}`;
}

export function hexToAscii(hex = '') {
  try { return Buffer.from(hex, 'hex').toString('utf8'); } catch { return ''; }
}

export function rippleTime(t) { return new Date((t + RIPPLE_EPOCH) * 1000); }

/** Hostname a mod or member typed, cleaned. Rejects IPs, localhost and internal names. */
export function cleanDomain(input = '') {
  let s = String(input).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0].replace(/\.$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(s)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(s)) return null;
  return s;
}

const FINAL_ERRORS = new Set(['actNotFound', 'txnNotFound', 'actMalformed', 'invalidParams', 'notFound']);

export class XrplClient {
  constructor(urls, fetchImpl = globalThis.fetch) {
    this.urls = urls;
    this.fetch = fetchImpl;
  }

  async rpc(method, params = {}) {
    let lastErr = new Error('No XRPL servers configured');
    for (const url of this.urls) {
      try {
        const res = await this.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, params: [params] }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        const { result } = await res.json();
        if (!result) throw new Error(`Empty result from ${url}`);
        if (result.status === 'error') {
          const e = new Error(result.error_message || result.error);
          e.code = result.error;
          if (FINAL_ERRORS.has(e.code)) throw e;
          lastErr = e;
          continue;
        }
        return result;
      } catch (e) {
        if (FINAL_ERRORS.has(e.code)) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /** account_data, or null if the account isn't activated. */
  async accountInfo(account) {
    try {
      const r = await this.rpc('account_info', { account, ledger_index: 'validated' });
      return r.account_data;
    } catch (e) {
      if (e.code === 'actNotFound') return null;
      throw e;
    }
  }

  async paged(method, params, field, maxPages) {
    const out = [];
    let marker;
    for (let p = 0; p < maxPages; p++) {
      const r = await this.rpc(method, { ...params, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
      out.push(...(r[field] ?? []));
      marker = r.marker;
      if (!marker) return { items: out, more: false };
    }
    return { items: out, more: true };
  }

  async lines(account, peer) {
    return (await this.paged('account_lines', { account, ...(peer ? { peer } : {}) }, 'lines', 5)).items;
  }

  async nfts(account) {
    return this.paged('account_nfts', { account }, 'account_nfts', 10);
  }

  async tx(hash) {
    try {
      return await this.rpc('tx', { transaction: hash, binary: false });
    } catch (e) {
      if (e.code === 'txnNotFound' || e.code === 'notFound') return null;
      throw e;
    }
  }
}

/** Fetch a domain's xrp-ledger.toml and pull the account list out of it. */
export async function fetchLedgerToml(domain, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`https://${domain}/.well-known/xrp-ledger.toml`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { found: false, status: res.status, accounts: [] };
    const text = (await res.text()).slice(0, 200_000);
    const accounts = [...new Set([...text.matchAll(/address\s*=\s*["'](r[1-9A-HJ-NP-Za-km-z]{24,34})["']/g)].map((m) => m[1]))]
      .filter(isValidAddress)
      .slice(0, 10);
    return { found: true, accounts };
  } catch (e) {
    return { found: false, error: e.message, accounts: [] };
  }
}
