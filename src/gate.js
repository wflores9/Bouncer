// Gate rules. Pure apart from the XRPL client passed in.
//   button    : press to enter
//   wallet    : sign in with Xaman; the wallet must be activated on mainnet (holds the reserve)
//   trustline : as wallet, and the wallet must hold a trustline to issuer/currency
import { currencyName, toCurrencyCode } from './xrpl.js';

export const GATE_MODES = ['button', 'wallet', 'trustline'];

export function needsWallet(gate) {
  return gate.mode === 'wallet' || gate.mode === 'trustline';
}

export function gateLabel(gate) {
  if (gate.mode === 'trustline') return `$${currencyName(toCurrencyCode(gate.currency))} trustline`;
  if (gate.mode === 'wallet') return 'activated XRPL wallet';
  return 'button';
}

/**
 * Does this wallet meet the gate?
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function checkGateWallet(address, gate, client) {
  const info = await client.accountInfo(address);
  if (!info) {
    return { ok: false, reason: 'That wallet isn\'t activated on the XRP Ledger yet. It needs the 1 XRP reserve. Fund it, then press the button again.' };
  }
  if (gate.mode !== 'trustline') return { ok: true };
  const code = toCurrencyCode(gate.currency);
  const lines = await client.lines(address, gate.issuer);
  const line = lines.find((l) => l.account === gate.issuer && l.currency === code);
  if (!line) {
    const name = currencyName(code);
    return { ok: false, reason: `No trustline, no entry. Add the $${name} trustline in Xaman (issuer \`${gate.issuer}\`), then press the button again.` };
  }
  return { ok: true };
}
