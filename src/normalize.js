// Text normalization so "ꜱᴜᴘᴘᴏʀᴛ", "Supp0rt" and "S u p p o r t" all read the same.

const SMALL_CAPS = {
  'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h',
  'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p',
  'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
};

// Common Cyrillic/Greek homoglyphs used to fake Latin names.
const HOMOGLYPHS = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j',
  'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'һ': 'h', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't',
  'α': 'a', 'ι': 'i',
};

// Leetspeak, used only for name comparison (not for message scanning).
const LEET = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

function mapChars(str, table) {
  let out = '';
  for (const ch of str) out += table[ch] ?? ch;
  return out;
}

/** Normalize free text for phrase scanning. Keeps spaces and punctuation. */
export function normalizeText(input = '') {
  let s = input.replace(ZERO_WIDTH, '');
  s = mapChars(s, SMALL_CAPS);
  s = mapChars(s, HOMOGLYPHS);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return s.toLowerCase();
}

/** Collapse a display name to bare letters/digits for impersonation checks. */
export function normalizeName(input = '') {
  let s = normalizeText(input);
  s = mapChars(s, LEET);
  s = s.replace(/[^a-z0-9]/g, '');
  // Visual skeleton: I/l/1 and rn/m look alike in Discord's font.
  return s.replace(/i/g, 'l').replace(/rn/g, 'm').replace(/vv/g, 'w');
}

/** Classic Levenshtein distance (small strings only). */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}
