// Holder roles: which rule roles does a wallet qualify for? Pure apart from the XRPL client passed in.
import { currencyName, toCurrencyCode } from './xrpl.js';

/**
 * Rules: { id, roleId, type: 'trustline'|'nft'|'xrp', issuer?, currency?, taxon?, min }
 * - trustline: holds a trustline to issuer for currency with balance >= min (min 0 = just the line)
 * - nft: holds >= min NFTs from issuer (optionally one taxon)
 * - xrp: balance >= min XRP
 * Several rules can point at one role; any match gives it.
 * @returns {Promise<Set<string>>} role IDs the wallet qualifies for
 */
export async function qualifyingRoles(address, rules, client) {
  const out = new Set();
  if (!rules.length) return out;
  const info = await client.accountInfo(address);
  if (!info) return out; // not activated: holds nothing
  let lines = null;
  let nfts = null;
  for (const r of rules) {
    if (out.has(r.roleId)) continue;
    if (r.type === 'xrp') {
      if (Number(info.Balance) / 1e6 >= r.min) out.add(r.roleId);
    } else if (r.type === 'trustline') {
      lines ??= await client.lines(address);
      const code = toCurrencyCode(r.currency);
      const line = lines.find((l) => l.account === r.issuer && l.currency === code);
      if (line && Number(line.balance) >= r.min) out.add(r.roleId);
    } else if (r.type === 'nft') {
      nfts ??= (await client.nfts(address)).items;
      const n = nfts.filter((t) => t.Issuer === r.issuer && (r.taxon == null || t.NFTokenTaxon === r.taxon)).length;
      if (n >= r.min) out.add(r.roleId);
    }
  }
  return out;
}

export function describeRule(r) {
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
  if (r.type === 'xrp') return `≥ ${r.min} XRP`;
  if (r.type === 'trustline') {
    const what = `${currencyName(toCurrencyCode(r.currency))} from ${short(r.issuer)}`;
    return r.min > 0 ? `≥ ${r.min} ${what}` : `trustline to ${what}`;
  }
  return `≥ ${r.min} NFT${r.min === 1 ? '' : 's'} from ${short(r.issuer)}${r.taxon != null ? ` (taxon ${r.taxon})` : ''}`;
}
