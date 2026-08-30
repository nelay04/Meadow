"""Default names for a new board: "Untitled <Adjective> <Noun> <HASH>".

A bare "Untitled" tells nobody anything once there are more than a handful of boards
in a workspace, and the boards list has no other distinguishing thumbnail until the
first render lands. The random tail gives every new glade or lea a name you can
actually pick out of a list, without asking the person to type one before they are
allowed to start (BoardsPage.tsx's create() comment covers why that's off the table).

"Untitled" is kept as the literal prefix rather than replaced outright: it is the
sentinel `create_board` checks for to decide a name was never supplied, and it keeps
the placeholder-select behavior in BoardPage.tsx recognizable as "still unnamed."
"""

import random
import secrets
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Board

DEFAULT_TITLE = "Untitled"

# Nature/vibe adjectives and animal/plant/nature nouns, kept short and lowercase so the
# generated tail reads as one word-ish token next to "Untitled" rather than a sentence.
_ADJECTIVES = [
    "amber", "ancient", "arctic", "autumn", "azure", "bare", "basalt", "bitter", "black", "bleak",
    "blind", "blue", "bold", "brave", "breezy", "bright", "brilliant", "brisk", "bronze", "brown",
    "calm", "carmine", "celestial", "chilly", "chrome", "clear", "cloudy", "cobalt", "cold",
    "cool", "copper", "coral", "crimson", "crisp", "crystal", "cyan", "dark", "dawn", "deep",
    "delicate", "desert", "dewy", "dim", "distant", "dry", "dull", "dusk", "dusty", "eager",
    "early", "earthen", "echoing", "emerald", "empty", "evening", "faint", "fair", "falling",
    "fast", "fierce", "fiery", "flat", "floating", "flowing", "fluffy", "flying", "foggy",
    "fragrant", "freezing", "fresh", "frosty", "frozen", "gentle", "giant", "glassy", "gleaming",
    "glowing", "gold", "golden", "grand", "gray", "green", "grim", "happy", "harsh", "heavy",
    "hidden", "hollow", "hot", "howling", "humble", "icy", "indigo", "ivory", "jade", "jagged",
    "jovial", "jumping", "late", "lazy", "light", "limpid", "little", "lone", "lonely", "long",
    "loud", "lucid", "lunar", "lush", "magenta", "majestic", "marble", "mellow", "melting",
    "midnight", "misty", "moonlit", "morning", "mossy", "muddy", "muffled", "mute", "mystic",
    "narrow", "neon", "night", "nimble", "noble", "noisy", "northern", "obsidian", "oceanic",
    "old", "olive", "onyx", "opal", "orange", "pale", "patient", "peaceful", "pink", "placid",
    "plain", "polar", "proud", "purple", "quiet", "radiant", "rainy", "rapid", "red", "restless",
    "roaring", "rough", "round", "ruby", "running", "rusty", "sad", "sandy", "sapphire", "secret",
    "serene", "shaded", "shadowy", "shallow", "sharp", "shining", "short", "shy", "silent",
    "silver", "sleepy", "slow", "small", "smooth", "snowy", "soft", "solar", "solid", "solitary",
    "somber", "sparkling", "spicy", "spring", "square", "steep", "still", "stormy", "stout",
    "straight", "strong", "summer", "sunny", "sweet", "swift", "tall", "tame", "teal", "thick",
    "thin", "tiny", "tired", "tranquil", "twilight", "umber", "velvet", "violet", "vivid", "warm",
    "watery", "wavy", "weak", "wet", "whispering", "white", "wild", "windy", "winter", "wise",
    "yellow", "young", "zealous", "zen", "zesty", "zinc", "zircon",
]

_NOUNS = [
    "albatross", "alligator", "alpaca", "ant", "antelope", "apple", "ash", "aster", "badger",
    "bamboo", "bass", "bat", "bear", "beaver", "bee", "beech", "beetle", "birch", "bird", "bison",
    "boulder", "branch", "breeze", "brook", "brush", "butterfly", "cactus", "camel", "canyon",
    "carp", "cat", "cave", "cedar", "cherry", "chipmunk", "cliff", "cloud", "coast", "comet",
    "coral", "cougar", "coyote", "crab", "crane", "creek", "crow", "daisy", "deer", "desert",
    "dingo", "dog", "dolphin", "dove", "dragon", "duck", "dune", "eagle", "earth", "eel",
    "elephant", "elk", "elm", "falcon", "fern", "finch", "fire", "fish", "flame", "flower",
    "forest", "fox", "frog", "frost", "galaxy", "gecko", "glacier", "goat", "goose", "grass",
    "grove", "gull", "hare", "hawk", "hill", "horse", "hound", "husky", "ice", "iceberg",
    "iguana", "island", "ivy", "jaguar", "jay", "jellyfish", "jungle", "koala", "lake", "leaf",
    "lemur", "leopard", "lily", "lion", "lizard", "llama", "lotus", "lynx", "macaque", "macaw",
    "maple", "marsh", "meadow", "meteor", "mink", "moon", "moose", "morning", "moss", "moth",
    "mountain", "mouse", "mule", "nebula", "newt", "night", "oak", "oasis", "ocean", "octopus",
    "orca", "orchid", "ostrich", "otter", "owl", "ox", "panda", "panther", "parrot", "peak",
    "pebble", "pelican", "penguin", "pine", "plain", "planet", "plant", "pond", "pool", "puffin",
    "puma", "quail", "rabbit", "raccoon", "rain", "raven", "reef", "rhino", "ridge", "river",
    "robin", "rock", "root", "rose", "salmon", "sand", "sea", "seagull", "seal", "shadow",
    "shark", "sheep", "shell", "shrub", "skunk", "sky", "sloth", "snail", "snake", "snow",
    "sparrow", "spider", "spring", "squid", "squirrel", "star", "starfish", "stone", "storm",
    "stream", "sun", "swan", "tiger", "toad", "tortoise", "tree", "trout", "tulip", "turtle",
    "tundra", "valley", "vine", "volcano", "walrus", "water", "wave", "whale", "willow", "wind",
    "wolf", "wood", "wren", "yak", "zebra",
]

_MAX_ATTEMPTS = 20


def _random_title() -> str:
    adjective = random.choice(_ADJECTIVES)
    noun = random.choice(_NOUNS)
    suffix = secrets.token_hex(2).upper()
    return f"{DEFAULT_TITLE} {adjective.capitalize()} {noun.capitalize()} {suffix}"


async def generate_unique_board_title(session: AsyncSession, workspace_id: uuid.UUID) -> str:
    """A random "Untitled ..." title that no board in this workspace already has.

    Scoped to the workspace, not global: that's the account boundary a person actually
    sees a board list against, and it keeps the search space small enough that a
    collision is rare in the first place.
    """
    for _ in range(_MAX_ATTEMPTS):
        title = _random_title()
        collision = await session.scalar(
            select(Board.id).where(Board.workspace_id == workspace_id, Board.title == title)
        )
        if collision is None:
            return title

    # 20 collisions in a row on a 4-hex-char tail is not happening by chance; widen the
    # suffix instead of looping forever.
    adjective = random.choice(_ADJECTIVES)
    noun = random.choice(_NOUNS)
    suffix = secrets.token_hex(6).upper()
    return f"{DEFAULT_TITLE} {adjective.capitalize()} {noun.capitalize()} {suffix}"
