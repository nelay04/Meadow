/**
 * Roman to Bengali, by rule, offline.
 *
 * The fallback half of the phonetic input option. Google's own service is what the
 * candidate list is built from when it can be reached, because that is what makes the
 * suggestions the ones a person already knows from every other Bengali text box they
 * have used. It is not always reachable, and a diary that stops accepting Bengali the
 * moment the network does is not an input method, so this is here to answer with
 * something correct on its own.
 *
 * The scheme is Avro's, which is the one nearly every Bengali typist on a keyboard
 * already has in their fingers: `k` is ক, `K` is খ, a consonant straight after another
 * consonant conjoins, a vowel after a consonant is its kar and on its own is the
 * independent letter.
 *
 * It is deliberately a transliterator and not a speller. It has no dictionary, so it
 * cannot know that "amar" is far more often আমার than অমর - ranking is what the online
 * source is for.
 */

type Entry =
  /** A consonant. Conjoins with a hasanta when another consonant follows directly. */
  | { kind: 'consonant'; out: string }
  /** A vowel: the independent letter, or its kar when it lands on a consonant. */
  | { kind: 'vowel'; out: string; kar: string }
  /** Anusvara, visarga, chandrabindu, an explicit hasanta: written as-is. */
  | { kind: 'sign'; out: string }

/*
 * Case matters, exactly as it does in Avro: the capital is the aspirated or retroflex
 * partner of the small letter. Longest match wins, which is what makes `kh` খ rather
 * than ক্হ, so multi-character keys never need to be ordered by hand.
 */
const RULES: Record<string, Entry> = {
  // Vowels.
  o: { kind: 'vowel', out: 'অ', kar: '' },
  O: { kind: 'vowel', out: 'ও', kar: 'ো' },
  a: { kind: 'vowel', out: 'আ', kar: 'া' },
  aa: { kind: 'vowel', out: 'আ', kar: 'া' },
  A: { kind: 'vowel', out: 'আ', kar: 'া' },
  i: { kind: 'vowel', out: 'ই', kar: 'ি' },
  I: { kind: 'vowel', out: 'ঈ', kar: 'ী' },
  ee: { kind: 'vowel', out: 'ঈ', kar: 'ী' },
  ii: { kind: 'vowel', out: 'ঈ', kar: 'ী' },
  u: { kind: 'vowel', out: 'উ', kar: 'ু' },
  U: { kind: 'vowel', out: 'ঊ', kar: 'ূ' },
  oo: { kind: 'vowel', out: 'ঊ', kar: 'ূ' },
  uu: { kind: 'vowel', out: 'ঊ', kar: 'ূ' },
  rri: { kind: 'vowel', out: 'ঋ', kar: 'ৃ' },
  e: { kind: 'vowel', out: 'এ', kar: 'ে' },
  E: { kind: 'vowel', out: 'এ', kar: 'ে' },
  oi: { kind: 'vowel', out: 'ঐ', kar: 'ৈ' },
  OI: { kind: 'vowel', out: 'ঐ', kar: 'ৈ' },
  ou: { kind: 'vowel', out: 'ঔ', kar: 'ৌ' },
  OU: { kind: 'vowel', out: 'ঔ', kar: 'ৌ' },

  // Consonants.
  k: { kind: 'consonant', out: 'ক' },
  kh: { kind: 'consonant', out: 'খ' },
  K: { kind: 'consonant', out: 'খ' },
  g: { kind: 'consonant', out: 'গ' },
  gh: { kind: 'consonant', out: 'ঘ' },
  G: { kind: 'consonant', out: 'ঘ' },
  Ng: { kind: 'consonant', out: 'ঙ' },
  c: { kind: 'consonant', out: 'চ' },
  ch: { kind: 'consonant', out: 'ছ' },
  C: { kind: 'consonant', out: 'ছ' },
  j: { kind: 'consonant', out: 'জ' },
  jh: { kind: 'consonant', out: 'ঝ' },
  J: { kind: 'consonant', out: 'ঝ' },
  NG: { kind: 'consonant', out: 'ঞ' },
  T: { kind: 'consonant', out: 'ট' },
  Th: { kind: 'consonant', out: 'ঠ' },
  D: { kind: 'consonant', out: 'ড' },
  Dh: { kind: 'consonant', out: 'ঢ' },
  N: { kind: 'consonant', out: 'ণ' },
  t: { kind: 'consonant', out: 'ত' },
  th: { kind: 'consonant', out: 'থ' },
  d: { kind: 'consonant', out: 'দ' },
  dh: { kind: 'consonant', out: 'ধ' },
  n: { kind: 'consonant', out: 'ন' },
  p: { kind: 'consonant', out: 'প' },
  ph: { kind: 'consonant', out: 'ফ' },
  f: { kind: 'consonant', out: 'ফ' },
  F: { kind: 'consonant', out: 'ফ' },
  b: { kind: 'consonant', out: 'ব' },
  bh: { kind: 'consonant', out: 'ভ' },
  v: { kind: 'consonant', out: 'ভ' },
  V: { kind: 'consonant', out: 'ভ' },
  m: { kind: 'consonant', out: 'ম' },
  z: { kind: 'consonant', out: 'য' },
  Z: { kind: 'consonant', out: 'য' },
  r: { kind: 'consonant', out: 'র' },
  R: { kind: 'consonant', out: 'ড়' },
  Rh: { kind: 'consonant', out: 'ঢ়' },
  l: { kind: 'consonant', out: 'ল' },
  L: { kind: 'consonant', out: 'ল' },
  sh: { kind: 'consonant', out: 'শ' },
  S: { kind: 'consonant', out: 'শ' },
  Sh: { kind: 'consonant', out: 'ষ' },
  s: { kind: 'consonant', out: 'স' },
  h: { kind: 'consonant', out: 'হ' },
  H: { kind: 'consonant', out: 'হ' },
  y: { kind: 'consonant', out: 'য়' },
  Y: { kind: 'consonant', out: 'য়' },
  w: { kind: 'consonant', out: 'ও' },
  W: { kind: 'consonant', out: 'ও' },
  x: { kind: 'consonant', out: 'ক্স' },
  X: { kind: 'consonant', out: 'ক্স' },
  q: { kind: 'consonant', out: 'ক' },
  Q: { kind: 'consonant', out: 'ক' },

  // Signs.
  ng: { kind: 'sign', out: 'ং' },
  M: { kind: 'sign', out: 'ং' },
  ':': { kind: 'sign', out: 'ঃ' },
  '^': { kind: 'sign', out: 'ঁ' },
  ',,': { kind: 'sign', out: '্' },
  '.': { kind: 'sign', out: '।' },
}

const DIGITS = '০১২৩৪৫৬৭৮৯'

/** Longest key first, so `kh` is never read as `k` + `h`. */
const KEY_LENGTHS = [...new Set(Object.keys(RULES).map((key) => key.length))].sort((a, b) => b - a)

/**
 * The transliteration of one roman word.
 *
 * Anything with no rule behind it - a digit, a stray apostrophe - is passed through
 * unchanged rather than dropped. A character the scheme has no opinion about is not an
 * error, and swallowing it would make the field lose text the person typed.
 */
export function transliterate(roman: string): string {
  let out = ''
  let index = 0
  // Whether the last thing written was a consonant with no vowel on it yet. This is the
  // whole of the conjunct rule: another consonant now means a hasanta between them.
  let pending = false

  while (index < roman.length) {
    let entry: Entry | undefined
    let length = 0
    for (const size of KEY_LENGTHS) {
      const key = roman.slice(index, index + size)
      if (key.length < size) continue
      const found = RULES[key]
      if (found !== undefined) {
        entry = found
        length = size
        break
      }
    }

    if (entry === undefined) {
      const char = roman[index] ?? ''
      const digit = char >= '0' && char <= '9' ? DIGITS[Number(char)] : undefined
      out += digit ?? char
      pending = false
      index += 1
      continue
    }

    if (entry.kind === 'consonant') {
      if (pending) out += '্'
      out += entry.out
      pending = true
    } else if (entry.kind === 'vowel') {
      out += pending ? entry.kar : entry.out
      pending = false
    } else {
      out += entry.out
      pending = false
    }

    index += length
  }

  return out
}

/*
 * The letters this scheme cannot choose between without knowing the word.
 *
 * Bengali has three sibilants and two each of n, r and the long vowels; roman has one
 * of each. A rule engine has to pick one, and the other is often the right one, so the
 * alternatives are offered rather than hidden. In the order a mistake is most likely.
 */
const ALTERNATES: readonly (readonly [string, string])[] = [
  ['স', 'শ'],
  ['ন', 'ণ'],
  ['র', 'ড়'],
  ['ি', 'ী'],
  ['ু', 'ূ'],
  ['জ', 'য'],
  ['ত', 'ৎ'],
]

/**
 * A candidate list for one roman word, with no network.
 *
 * The transliteration first, then one single-letter alternative per ambiguity above,
 * then the roman itself - which is how the online list ends too, and is the only way to
 * type a latin word while the input method is on.
 */
export function localCandidates(roman: string, limit = 6): string[] {
  const primary = transliterate(roman)
  const out = [primary]

  for (const [from, to] of ALTERNATES) {
    if (out.length >= limit - 1) break
    const at = primary.indexOf(from)
    if (at < 0) continue
    const variant = primary.slice(0, at) + to + primary.slice(at + from.length)
    if (!out.includes(variant)) out.push(variant)
  }

  if (!out.includes(roman)) out.push(roman)
  return out.slice(0, limit)
}
