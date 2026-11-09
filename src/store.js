// Small JSON-file store: cases, wallet links, runtime lists, holder rules, settings.
// One file, written atomically. Plenty for a single community server.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LIST_NAMES = ['allowedDomains', 'blockedDomains', 'protectedNames', 'blockedAddresses'];

function empty() {
  return {
    version: 1,
    nextCase: 1,
    nextRule: 1,
    cases: [],
    wallets: {}, // discordUserId -> { address, linkedAt }
    lists: Object.fromEntries(LIST_NAMES.map((n) => [n, []])),
    addressNotes: {}, // address -> note
    holderRules: [],
    settings: {},
  };
}

export class Store {
  /** @param {string|null} file  null = memory only (tests) */
  constructor(file = null) {
    this.file = file;
    this.data = empty();
    if (file && existsSync(file)) {
      const loaded = JSON.parse(readFileSync(file, 'utf8'));
      this.data = { ...empty(), ...loaded, lists: { ...empty().lists, ...(loaded.lists ?? {}) } };
    }
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  // ---------- settings ----------
  get(key) { return this.data.settings[key]; }
  set(key, value) {
    if (value == null) delete this.data.settings[key];
    else this.data.settings[key] = value;
    this.save();
  }

  // ---------- cases / strikes ----------
  addCase({ userId, type, reason, modId = null }) {
    const c = { id: this.data.nextCase++, userId, type, reason, modId, at: Date.now(), active: true };
    this.data.cases.push(c);
    this.save();
    return c;
  }

  casesFor(userId) {
    return this.data.cases.filter((c) => c.userId === userId).sort((a, b) => b.at - a.at);
  }

  /** Active warnings + automatic removals inside the expiry window. */
  strikeCount(userId, expireDays, now = Date.now()) {
    const since = now - expireDays * 86_400_000;
    return this.data.cases.filter((c) => c.userId === userId && c.active && ['warn', 'auto'].includes(c.type) && c.at >= since).length;
  }

  revokeCase(id) {
    const c = this.data.cases.find((x) => x.id === id);
    if (!c || !c.active) return null;
    c.active = false;
    this.save();
    return c;
  }

  // ---------- runtime lists ----------
  list(name) { return this.data.lists[name]; }

  listAdd(name, value) {
    const l = this.data.lists[name];
    if (l.includes(value)) return false;
    l.push(value);
    this.save();
    return true;
  }

  listRemove(name, value) {
    const l = this.data.lists[name];
    const i = l.indexOf(value);
    if (i < 0) return false;
    l.splice(i, 1);
    this.save();
    return true;
  }

  noteAddress(address, note) {
    if (note) this.data.addressNotes[address] = note;
    else delete this.data.addressNotes[address];
    this.save();
  }

  // ---------- wallets ----------
  walletOf(userId) { return this.data.wallets[userId] ?? null; }

  userByWallet(address) {
    return Object.entries(this.data.wallets).find(([, w]) => w.address === address)?.[0] ?? null;
  }

  /** Link a wallet. A wallet belongs to one Discord user; returns the user it was moved from, if any. */
  linkWallet(userId, address) {
    const prev = this.userByWallet(address);
    if (prev && prev !== userId) delete this.data.wallets[prev];
    this.data.wallets[userId] = { address, linkedAt: Date.now() };
    this.save();
    return prev && prev !== userId ? prev : null;
  }

  unlinkWallet(userId) {
    if (!this.data.wallets[userId]) return false;
    delete this.data.wallets[userId];
    this.save();
    return true;
  }

  allWallets() { return Object.entries(this.data.wallets).map(([userId, w]) => ({ userId, ...w })); }

  // ---------- holder rules ----------
  rules() { return this.data.holderRules; }

  addRule(rule) {
    const r = { id: this.data.nextRule++, ...rule };
    this.data.holderRules.push(r);
    this.save();
    return r;
  }

  removeRule(id) {
    const i = this.data.holderRules.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const [r] = this.data.holderRules.splice(i, 1);
    this.save();
    return r;
  }
}
