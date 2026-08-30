/**
 * Every language the phonetic input can write.
 *
 * India's languages, and no others. The service transliterates twenty-nine, and the
 * first cut of this listed all of them - Greek, Russian, Hebrew, Japanese and the rest -
 * which was a menu built around what the endpoint happened to offer rather than around
 * anybody who writes here. What is left is the scheduled languages of India that the
 * service supports, minus Urdu, which was asked for.
 *
 * The ones dropped are not missing: they are out of scope, and adding one back is a row
 * here plus its font in scripts/fetch-fonts.mjs. Chinese and Korean were never possible
 * anyway - both want a different kind of input method, segmentation and jamo
 * composition, and a candidate list over a word boundary is the wrong shape for either.
 *
 * `id` is the BCP-47 code the service takes, as `<id>-t-i0-und`.
 *
 * The order is the order the menu shows: Bengali, then Hindi, then by English name. The
 * first two are pinned because they are the two this was built for; everything after is
 * alphabetical so the list stays scannable.
 */

export type InputLanguage = {
  id: string
  /** English name, for the menu. */
  label: string
  /** The name in its own script, which is how a reader of it finds their line fastest. */
  native: string
  /**
   * One letter, for the toolbar button. The script's own, so the button says which
   * keyboard you are about to type on without being read.
   */
  glyph: string
  /** Roman, and what it becomes. The menu shows it, and it is the fastest possible demo. */
  sample: readonly [string, string]
}

export const INPUT_LANGUAGES: readonly InputLanguage[] = [
  { id: 'bn', label: 'Bengali', native: 'বাংলা', glyph: 'অ', sample: ['amar', 'আমার'] },
  { id: 'hi', label: 'Hindi', native: 'हिन्दी', glyph: 'अ', sample: ['namaste', 'नमस्ते'] },
  { id: 'as', label: 'Assamese', native: 'অসমীয়া', glyph: 'অ', sample: ['nomoskar', 'নমস্কাৰ'] },
  { id: 'gu', label: 'Gujarati', native: 'ગુજરાતી', glyph: 'અ', sample: ['kem', 'કેમ'] },
  { id: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ', glyph: 'ಅ', sample: ['namaskara', 'ನಮಸ್ಕಾರ'] },
  { id: 'ml', label: 'Malayalam', native: 'മലയാളം', glyph: 'അ', sample: ['namaskaram', 'നമസ്കാരം'] },
  { id: 'mr', label: 'Marathi', native: 'मराठी', glyph: 'अ', sample: ['namaskar', 'नमस्कार'] },
  // Nepal's language and one of India's twenty-two, which is why it is here and Sinhala
  // and Thai are not.
  { id: 'ne', label: 'Nepali', native: 'नेपाली', glyph: 'अ', sample: ['namaste', 'नमस्ते'] },
  { id: 'or', label: 'Odia', native: 'ଓଡ଼ିଆ', glyph: 'ଅ', sample: ['namaskar', 'ନମସ୍କାର'] },
  { id: 'pa', label: 'Punjabi', native: 'ਪੰਜਾਬੀ', glyph: 'ਅ', sample: ['sat', 'ਸਤਿ'] },
  { id: 'sa', label: 'Sanskrit', native: 'संस्कृतम्', glyph: 'अ', sample: ['namah', 'नमः'] },
  { id: 'ta', label: 'Tamil', native: 'தமிழ்', glyph: 'அ', sample: ['vanakkam', 'வணக்கம்'] },
  { id: 'te', label: 'Telugu', native: 'తెలుగు', glyph: 'అ', sample: ['namaskaram', 'నమస్కారం'] },
]

const BY_ID = new Map(INPUT_LANGUAGES.map((language) => [language.id, language]))

export function inputLanguage(id: string | null): InputLanguage | null {
  return id === null ? null : (BY_ID.get(id) ?? null)
}
