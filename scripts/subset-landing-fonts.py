"""
Cut the landing pages' Indic faces down to the words those pages actually print.

The static pages under apps/web/ set thirteen languages in nine scripts, and the app's
own Noto faces are 30 to 110 KB each: most of a megabyte to print thirteen language
names and thirteen sample words. Each face here is instanced at weight 300 - the single
weight site.css sets them in - and subset to that script's characters, which brings them
to 2 to 10 KB. A browser fetches one only when a page lays out a letter of that script,
so the home page's demo costs Bengali and nothing else until somebody clicks.

The character list is the source of truth: the language's own name, its sample word from
apps/web/src/text/inputLanguages.ts, and the glyph that stands for it. Change a sample
word and you must run this, or the new word renders as empty boxes on any machine
without that script installed.

    python3 -m venv .fonts && .fonts/bin/pip install "fonttools[woff]"
    .fonts/bin/python scripts/subset-landing-fonts.py [script ...]

With no arguments it does every script below.
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FONTS = Path(__file__).resolve().parent.parent / 'apps/web/public/fonts'

# A space, zero-width non-joiner, zero-width joiner and the dotted circle. Indic shaping
# reaches for the three invisible ones, and a missing dotted circle turns a stray matra
# into a blank rather than into the mark that says a stray matra is what it is.
SHAPING = ' ‌‍◌'

# script -> the text it has to carry. One language per line: glyph, name, sample.
SCRIPTS = {
    # Bengali and Assamese share the block, so this face carries both.
    'bengali': 'অ বাংলা নমস্কার' + ' অ অসমীয়া নমস্কাৰ',
    'devanagari': 'अ हिन्दी नमस्ते' + ' अ मराठी नमस्कार' + ' अ नेपाली नमस्ते' + ' अ संस्कृतम् नमः',
    'gujarati': 'અ ગુજરાતી નમસ્તે',
    'gurmukhi': 'ਅ ਪੰਜਾਬੀ ਨਮਸਕਾਰ',
    'kannada': 'ಅ ಕನ್ನಡ ನಮಸ್ಕಾರ',
    'malayalam': 'അ മലയാളം നമസ്കാരം',
    'oriya': 'ଅ ଓଡ଼ିଆ ନମସ୍କାର',
    'tamil': 'அ தமிழ் வணக்கம்',
    'telugu': 'అ తెలుగు నమస్కారం',
}

# site.css declares these at weight 300 and nothing else asks for another.
WEIGHT = 300


def cut(script: str, text: str) -> None:
    source = next(FONTS.glob(f'noto-sans-{script}-*-{script}.woff2'))
    target = FONTS / f'noto-sans-{script}-landing-subset.woff2'

    font = TTFont(source)
    instancer.instantiateVariableFont(font, {'wght': WEIGHT}, inplace=True)

    options = subset.Options()
    # Everything, rather than the default set: a script whose conjuncts live in a
    # feature the default list drops renders as separate letters, which is wrong in a
    # way that still looks like text.
    options.layout_features = ['*']
    options.name_IDs = ['*']
    options.notdef_outline = True

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=text + SHAPING)
    subsetter.subset(font)

    font.flavor = 'woff2'
    font.save(target)
    print(f'{target.name}: {len(font.getBestCmap())} glyphs, {target.stat().st_size} bytes')


for name in sys.argv[1:] or SCRIPTS:
    cut(name, SCRIPTS[name])
