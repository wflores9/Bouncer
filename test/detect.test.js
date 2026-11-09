import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanMessage, classifyHost, checkName, findSecrets, extractHosts } from '../src/detect.js';
import { RaidWatch } from '../src/raid.js';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const scan = (content, extra = {}) => scanMessage({ content, ...extra }, cfg);

test('normal chat passes', () => {
  for (const msg of [
    'gm everyone, Terry looking sharp today',
    'Staff will never ask for your seed phrase. Never share your seed phrase with anyone.',
    'check the tx on https://livenet.xrpl.org/transactions/ABC',
    'new drop on https://trustline-terry.xyz/merch',
    'dm me if you want to collab on art',
  ]) assert.equal(scan(msg).verdict, 'none', msg);
});

test('hard scam bait is removed', () => {
  assert.equal(scan('Hey, send me your seed phrase and I will fix it').verdict, 'remove');
  assert.equal(scan('Double your XRP today only').verdict, 'remove');
  assert.equal(scan('send 500 xrp and get 1000 back').verdict, 'remove');
});

test('soft bait alone is flagged, with a link is removed', () => {
  assert.equal(scan('You need to validate your wallet first').verdict, 'flag');
  assert.equal(scan('Validate your wallet at https://xrp-portal.top/sync').verdict, 'remove');
  assert.equal(scan('claim your airdrop here bit.ly/abc').verdict, 'remove');
});

test('lookalike and punycode domains are removed', () => {
  assert.equal(classifyHost('trustline-terrry.xyz', cfg), 'lookalike');
  assert.equal(classifyHost('xaman.io', cfg), 'lookalike');
  assert.equal(classifyHost('xrp1.org', cfg), 'lookalike');
  assert.equal(classifyHost('xaman.claim-portal.com', cfg), 'lookalike');
  assert.equal(classifyHost('xn--xmn-5cd.app', cfg), 'punycode');
  assert.equal(classifyHost('docs.xrpl.org', cfg), 'allowed');
  assert.equal(classifyHost('xrp.cafe', cfg), 'unknown');
  assert.equal(scan('official site: https://xaman-app.support').verdict !== 'none', true);
  assert.equal(scan('go to xumm.io now').verdict, 'remove');
});

test('unknown links: flag for members, remove for fresh accounts', () => {
  assert.equal(scan('cool article https://coindesk.com/x').verdict, 'flag');
  assert.equal(scan('cool article https://coindesk.com/x', { accountAgeDays: 1 }).verdict, 'remove');
});

test('invites, disguised links and mass mentions are removed', () => {
  assert.equal(scan('join us discord.gg/freexrp').verdict, 'remove');
  assert.equal(scan('[xaman.app](https://evil.top/login)').verdict, 'remove');
  assert.equal(scan('hi', { mentionCount: 8 }).verdict, 'remove');
});

test('wallet secrets are caught and not echoed', () => {
  assert.deepEqual(findSecrets('my seed is shHM53KPZ87Gwdqarm1bAmPeXqpvi'), ['XRPL family seed']);
  assert.equal(findSecrets('123456 234567 345678 456789 567890 678901 789012 890123').length, 1);
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  assert.equal(scan(phrase).verdict, 'secret');
  assert.equal(scan('I think that we should all go to the lounge later tonight ok').verdict, 'none');
});

test('impersonation names', () => {
  const targets = [...cfg.protectedNames, 'wflores'];
  assert.equal(checkName('Trustline Terry', targets)?.level, 'exact');
  assert.equal(checkName('ᴛʀᴜꜱᴛʟɪɴᴇ ᴛᴇʀʀʏ', targets)?.level, 'exact');
  assert.equal(checkName('Supp0rt', targets)?.level, 'exact');
  assert.equal(checkName('wflores | support', targets)?.level, 'exact');
  assert.equal(checkName('wfIores', targets)?.level, 'exact');
  assert.equal(checkName('trustline terri', targets)?.level, 'similar');
  assert.equal(checkName('SpaceCadet', targets), null);
});

test('raid window trips once and extends', () => {
  const r = new RaidWatch({ joins: 3, windowSeconds: 60, durationMinutes: 10 });
  assert.equal(r.record(0), false);
  assert.equal(r.record(1000), false);
  assert.equal(r.record(2000), true);
  assert.equal(r.record(3000), false);
  assert.equal(r.isActive(5 * 60_000), true);
  assert.equal(r.isActive(20 * 60_000), false);
});

test('extractHosts handles URLs and bare domains', () => {
  assert.deepEqual(extractHosts('see https://Xaman.app/x and xrp-claim.top').sort(), ['xaman.app', 'xrp-claim.top']);
  assert.deepEqual(extractHosts('email me at bob@gmail.com'), []);
});
