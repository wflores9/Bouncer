import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FloodWatch } from '../src/flood.js';
import { Store } from '../src/store.js';
import { withDefaults, effectiveConfig } from '../src/config.js';
import { strikeAction, clampTimeoutMinutes, formatMinutes } from '../src/strikes.js';
import {
  isValidAddress, findAddresses, toCurrencyCode, currencyName, formatAmount, cleanDomain, isTxHash, XrplClient, fetchLedgerToml,
} from '../src/xrpl.js';
import { qualifyingRoles, describeRule } from '../src/holders.js';
import { Xaman } from '../src/xaman.js';
import { scanMessage, classifyHost } from '../src/detect.js';

const base = withDefaults(JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')));
const GENESIS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B'; // Bitstamp
const SCAM = 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH';

// ---------- flood ----------

test('flood: fast posting trips and returns every message', () => {
  const f = new FloodWatch({ windowSeconds: 10, maxMessages: 5, dupWindowSeconds: 60, maxDuplicates: 3, crossChannelLimit: 3 });
  let r;
  for (let n = 0; n < 5; n++) r = f.record({ userId: 'u', channelId: 'c', messageId: `m${n}`, content: `msg ${n}`, now: n * 1000 });
  assert.equal(r.verdict, 'flood');
  assert.equal(r.messages.length, 5);
  // history cleared after a trip
  assert.equal(f.record({ userId: 'u', channelId: 'c', messageId: 'm9', content: 'hi', now: 6000 }).verdict, 'none');
});

test('flood: normal pace is fine', () => {
  const f = new FloodWatch({ windowSeconds: 10, maxMessages: 5, dupWindowSeconds: 60, maxDuplicates: 3, crossChannelLimit: 3 });
  for (let n = 0; n < 20; n++) {
    assert.equal(f.record({ userId: 'u', channelId: 'c', messageId: `m${n}`, content: `message number ${n}`, now: n * 4000 }).verdict, 'none');
  }
});

test('flood: copy-paste spam across channels', () => {
  const f = new FloodWatch({ windowSeconds: 10, maxMessages: 50, dupWindowSeconds: 120, maxDuplicates: 3, crossChannelLimit: 3 });
  const spam = 'Huge giveaway happening right now, check my profile';
  assert.equal(f.record({ userId: 'u', channelId: 'a', messageId: '1', content: spam, now: 0 }).verdict, 'none');
  assert.equal(f.record({ userId: 'u', channelId: 'b', messageId: '2', content: spam, now: 5000 }).verdict, 'none');
  const r = f.record({ userId: 'u', channelId: 'c', messageId: '3', content: spam.toUpperCase(), now: 9000 });
  assert.equal(r.verdict, 'duplicate');
  assert.equal(r.messages.length, 3);
});

test('flood: same link in two channels is enough; repeated "gm" is not', () => {
  const f = new FloodWatch({ windowSeconds: 10, maxMessages: 50, dupWindowSeconds: 120, maxDuplicates: 3, crossChannelLimit: 3 });
  f.record({ userId: 'u', channelId: 'a', messageId: '1', content: 'mint live https://xrp-mint.top', now: 0 });
  assert.equal(f.record({ userId: 'u', channelId: 'b', messageId: '2', content: 'mint live https://xrp-mint.top', now: 2000 }).verdict, 'duplicate');
  for (let n = 0; n < 5; n++) assert.equal(f.record({ userId: 'v', channelId: 'a', messageId: `g${n}`, content: 'gm', now: n * 20_000 }).verdict, 'none');
});

// ---------- strikes + store ----------

test('strike steps escalate and cap', () => {
  const steps = [{ at: 2, timeoutMinutes: 360 }, { at: 3, timeoutMinutes: 1440 }];
  assert.equal(strikeAction(1, steps), null);
  assert.equal(strikeAction(2, steps).timeoutMinutes, 360);
  assert.equal(strikeAction(3, steps).top, true);
  assert.equal(strikeAction(9, steps).timeoutMinutes, 1440);
  assert.equal(clampTimeoutMinutes(99_999), 28 * 24 * 60);
  assert.equal(formatMinutes(1440), '1d');
  assert.equal(formatMinutes(360), '6h');
  assert.equal(formatMinutes(45), '45m');
});

test('store: strikes count warns + autos in window, revoke works', () => {
  const s = new Store();
  const now = Date.now();
  s.addCase({ userId: 'u', type: 'warn', reason: 'a' });
  const c = s.addCase({ userId: 'u', type: 'auto', reason: 'b' });
  s.addCase({ userId: 'u', type: 'note', reason: 'not a strike' });
  assert.equal(s.strikeCount('u', 30, now), 2);
  s.revokeCase(c.id);
  assert.equal(s.strikeCount('u', 30, now), 1);
  assert.equal(s.strikeCount('u', 30, now + 31 * 86_400_000), 0); // expired
  assert.equal(s.revokeCase(c.id), null); // already revoked
});

test('store: a wallet belongs to one member', () => {
  const s = new Store();
  assert.equal(s.linkWallet('a', GENESIS), null);
  assert.equal(s.linkWallet('b', GENESIS), 'a');
  assert.equal(s.walletOf('a'), null);
  assert.equal(s.userByWallet(GENESIS), 'b');
});

test('runtime lists merge into config; block beats allow', () => {
  const s = new Store();
  s.listAdd('blockedDomains', 'xrpscan.com');
  s.listAdd('allowedDomains', 'xrp.cafe');
  s.listAdd('blockedAddresses', SCAM);
  const cfg = effectiveConfig(base, s.data.lists);
  assert.equal(classifyHost('xrpscan.com', cfg), 'blocked');
  assert.equal(classifyHost('xrp.cafe', cfg), 'allowed');
  assert.equal(cfg.blockedAddresses.includes(SCAM), true);
});

test('config: old config files get new defaults', () => {
  const cfg = withDefaults({ guildId: '1', flood: { maxMessages: 4 } });
  assert.equal(cfg.flood.maxMessages, 4);
  assert.equal(cfg.flood.windowSeconds, 10);
  assert.equal(cfg.strikes.expireDays, 30);
  assert.deepEqual(cfg.blockedAddresses, []);
});

// ---------- scam addresses in messages ----------

test('scam addresses are removed; bait + any address is removed', () => {
  const s = new Store();
  s.listAdd('blockedAddresses', SCAM);
  const cfg = effectiveConfig(base, s.data.lists);
  assert.equal(scanMessage({ content: `send to ${SCAM}` }, cfg).verdict, 'remove');
  assert.equal(scanMessage({ content: `my wallet is ${GENESIS}` }, cfg).verdict, 'none');
  assert.equal(scanMessage({ content: `claim your airdrop: send 1 XRP to ${GENESIS}` }, cfg).verdict, 'remove');
});

// ---------- xrpl helpers ----------

test('address checksum', () => {
  assert.equal(isValidAddress(GENESIS), true);
  assert.equal(isValidAddress(ISSUER), true);
  assert.equal(isValidAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTx'), false); // bad checksum
  assert.equal(isValidAddress('xHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'), false);
  assert.deepEqual(findAddresses(`a ${GENESIS} b rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTx c`), [GENESIS]);
});

test('currency codes, amounts, domains, hashes', () => {
  assert.equal(toCurrencyCode('USD'), 'USD');
  assert.equal(toCurrencyCode('SOLO'), '534F4C4F00000000000000000000000000000000');
  assert.equal(currencyName('534F4C4F00000000000000000000000000000000'), 'SOLO');
  assert.equal(formatAmount('1500000'), '1.5 XRP');
  assert.equal(formatAmount({ currency: 'USD', issuer: ISSUER, value: '12.5' }), '12.5 USD');
  assert.equal(cleanDomain('https://Xaman.app/path?q=1'), 'xaman.app');
  assert.equal(cleanDomain('localhost'), null);
  assert.equal(cleanDomain('127.0.0.1'), null);
  assert.equal(cleanDomain('printer.local'), null);
  assert.equal(isTxHash('A'.repeat(64)), true);
  assert.equal(isTxHash('xyz'), false);
});

function fakeFetch(handler) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const out = await handler(url, body, init);
    if (out instanceof Error) throw out;
    return { ok: out.status ? out.status < 400 : true, status: out.status ?? 200, json: async () => out.json, text: async () => out.text };
  };
}

test('xrpl client: falls over to the next server, treats actNotFound as final', async () => {
  const seen = [];
  const c = new XrplClient(['https://a/', 'https://b/'], fakeFetch((url, body) => {
    seen.push(url);
    if (url === 'https://a/') return new Error('ECONNRESET');
    if (body.params[0].account === GENESIS) return { json: { result: { status: 'success', account_data: { Balance: '25000000', OwnerCount: 0 } } } };
    return { json: { result: { status: 'error', error: 'actNotFound' } } };
  }));
  assert.equal((await c.accountInfo(GENESIS)).Balance, '25000000');
  assert.deepEqual(seen, ['https://a/', 'https://b/']);
  assert.equal(await c.accountInfo(ISSUER), null);
});

test('ledger toml parsing', async () => {
  const f = fakeFetch(() => ({ text: `[[ACCOUNTS]]\naddress = "${GENESIS}"\n[[ACCOUNTS]]\naddress = "rBAD"\n` }));
  assert.deepEqual((await fetchLedgerToml('example.com', f)).accounts, [GENESIS]);
  const missing = fakeFetch(() => ({ status: 404 }));
  assert.equal((await fetchLedgerToml('example.com', missing)).found, false);
});

// ---------- holder roles ----------

test('holder rules: trustline, NFT, XRP', async () => {
  const client = {
    accountInfo: async () => ({ Balance: '150000000' }),
    lines: async () => [{ account: ISSUER, currency: '5445525259000000000000000000000000000000', balance: '0' }],
    nfts: async () => ({ items: [{ Issuer: ISSUER, NFTokenTaxon: 7 }, { Issuer: ISSUER, NFTokenTaxon: 7 }], more: false }),
  };
  const rules = [
    { roleId: 'line', type: 'trustline', issuer: ISSUER, currency: 'TERRY', min: 0 },
    { roleId: 'whale', type: 'trustline', issuer: ISSUER, currency: 'TERRY', min: 1000 },
    { roleId: 'nft', type: 'nft', issuer: ISSUER, taxon: 7, min: 2 },
    { roleId: 'nft3', type: 'nft', issuer: ISSUER, min: 3 },
    { roleId: 'xrp', type: 'xrp', min: 100 },
  ];
  const got = await qualifyingRoles(GENESIS, rules, client);
  assert.deepEqual([...got].sort(), ['line', 'nft', 'xrp']);
  assert.match(describeRule(rules[0]), /trustline to TERRY/);
  assert.equal(describeRule(rules[4]), '≥ 100 XRP');
});

test('holder rules: unactivated wallet qualifies for nothing', async () => {
  const client = { accountInfo: async () => null };
  assert.equal((await qualifyingRoles(GENESIS, [{ roleId: 'x', type: 'xrp', min: 1 }], client)).size, 0);
});

// ---------- xaman ----------

test('xaman: sign-in request is SignIn only, and status is parsed', async () => {
  let sent;
  const f = fakeFetch((url, body, init) => {
    if (init.method === 'POST') {
      sent = { body, headers: init.headers };
      return { json: { uuid: 'u1', next: { always: 'https://xumm.app/sign/u1' }, refs: { qr_png: 'https://xumm.app/sign/u1_q.png' } } };
    }
    return { json: { meta: { resolved: true, signed: true, expired: false }, response: { account: GENESIS }, payload: { tx_type: 'SignIn' } } };
  });
  const x = new Xaman('k', 's', f);
  assert.equal(new Xaman('', '').enabled, false);
  const p = await x.createSignIn('d1-abc', 'Sign in');
  assert.equal(sent.body.txjson.TransactionType, 'SignIn');
  assert.equal(Object.keys(sent.body.txjson).length, 1); // nothing but SignIn, ever
  assert.equal(sent.headers['x-api-key'], 'k');
  assert.equal(p.link, 'https://xumm.app/sign/u1');
  const s = await x.waitForSignIn('u1', { intervalMs: 1 });
  assert.equal(s.signed, true);
  assert.equal(s.account, GENESIS);
});

// ---------- gate ----------

import { checkGateWallet, needsWallet, gateLabel } from '../src/gate.js';

test('gate: wallet mode needs an activated wallet', async () => {
  const gate = { mode: 'wallet' };
  assert.equal(needsWallet(gate), true);
  assert.equal(needsWallet({ mode: 'button' }), false);
  assert.equal((await checkGateWallet(GENESIS, gate, { accountInfo: async () => ({ Balance: '1000000' }) })).ok, true);
  const unfunded = await checkGateWallet(GENESIS, gate, { accountInfo: async () => null });
  assert.equal(unfunded.ok, false);
  assert.match(unfunded.reason, /reserve/);
});

test('gate: trustline mode needs the line', async () => {
  const gate = { mode: 'trustline', issuer: ISSUER, currency: 'TERRY' };
  assert.equal(gateLabel(gate), '$TERRY trustline');
  const withLine = { accountInfo: async () => ({}), lines: async () => [{ account: ISSUER, currency: toCurrencyCode('TERRY'), balance: '0' }] };
  const noLine = { accountInfo: async () => ({}), lines: async () => [] };
  assert.equal((await checkGateWallet(GENESIS, gate, withLine)).ok, true);
  const r = await checkGateWallet(GENESIS, gate, noLine);
  assert.equal(r.ok, false);
  assert.match(r.reason, /No trustline, no entry/);
});
