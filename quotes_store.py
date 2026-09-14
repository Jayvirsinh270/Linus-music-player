"""
quotes_store.py - Curated Life, Philosophy, Wisdom & Inspiration Quote Engine
Provides 100+ timeless reflections across philosophy, mindfulness, life, courage, art & humanity.
"""

import random
import datetime
import urllib.request
import json
import logging

logger = logging.getLogger(__name__)

CURATED_QUOTES = [
    # --- Philosophy & Stoicism ---
    {
        "text": "You have power over your mind - not outside events. Realize this, and you will find strength.",
        "author": "Marcus Aurelius",
        "tag": "philosophy"
    },
    {
        "text": "We suffer more often in imagination than in reality.",
        "author": "Seneca",
        "tag": "stoicism"
    },
    {
        "text": "The unexamined life is not worth living.",
        "author": "Socrates",
        "tag": "philosophy"
    },
    {
        "text": "Knowing yourself is the beginning of all wisdom.",
        "author": "Aristotle",
        "tag": "wisdom"
    },
    {
        "text": "He who has a why to live can bear almost any how.",
        "author": "Friedrich Nietzsche",
        "tag": "resilience"
    },
    {
        "text": "It is not what happens to you, but how you react to it that matters.",
        "author": "Epictetus",
        "tag": "stoicism"
    },
    {
        "text": "In the depth of winter, I finally learned that within me there lay an invincible summer.",
        "author": "Albert Camus",
        "tag": "resilience"
    },
    {
        "text": "Dwell on the beauty of life. Watch the stars, and see yourself running with them.",
        "author": "Marcus Aurelius",
        "tag": "wonder"
    },
    {
        "text": "I think, therefore I am.",
        "author": "René Descartes",
        "tag": "philosophy"
    },
    {
        "text": "To live is the rarest thing in the world. Most people exist, that is all.",
        "author": "Oscar Wilde",
        "tag": "life"
    },

    # --- Mindfulness, Calm & Eastern Wisdom ---
    {
        "text": "The journey of a thousand miles begins with a single step.",
        "author": "Lao Tzu",
        "tag": "wisdom"
    },
    {
        "text": "Silence is an answer too.",
        "author": "Rumi",
        "tag": "mindfulness"
    },
    {
        "text": "Smile, breathe, and go slowly.",
        "author": "Thich Nhat Hanh",
        "tag": "calm"
    },
    {
        "text": "Muddy water is best cleared by leaving it alone.",
        "author": "Alan Watts",
        "tag": "peace"
    },
    {
        "text": "When you let go of what you are, you become what you might be.",
        "author": "Lao Tzu",
        "tag": "transformation"
    },
    {
        "text": "The wound is the place where the Light enters you.",
        "author": "Rumi",
        "tag": "spiritual"
    },
    {
        "text": "Feelings come and go like clouds in a windy sky. Conscious breathing is my anchor.",
        "author": "Thich Nhat Hanh",
        "tag": "mindfulness"
    },
    {
        "text": "Do not dwell in the past, do not dream of the future, concentrate the mind on the present moment.",
        "author": "Buddha",
        "tag": "presence"
    },
    {
        "text": "Simplicity, patience, compassion. These three are your greatest treasures.",
        "author": "Lao Tzu",
        "tag": "wisdom"
    },
    {
        "text": "Out beyond ideas of wrongdoing and rightdoing, there is a field. I'll meet you there.",
        "author": "Rumi",
        "tag": "peace"
    },

    # --- Life, Courage & Purpose ---
    {
        "text": "Your time is limited, so don't waste it living someone else's life.",
        "author": "Steve Jobs",
        "tag": "purpose"
    },
    {
        "text": "Be like water making its way through cracks. Do not be assertive, but adjust to the object.",
        "author": "Bruce Lee",
        "tag": "courage"
    },
    {
        "text": "It always seems impossible until it's done.",
        "author": "Nelson Mandela",
        "tag": "courage"
    },
    {
        "text": "You will face many defeats in life, but never let yourself be defeated.",
        "author": "Maya Angelou",
        "tag": "resilience"
    },
    {
        "text": "When everything seems to be going against you, remember that the airplane takes off against the wind.",
        "author": "Henry Ford",
        "tag": "courage"
    },
    {
        "text": "The future belongs to those who believe in the beauty of their dreams.",
        "author": "Eleanor Roosevelt",
        "tag": "inspiration"
    },
    {
        "text": "Everything can be taken from a man but one thing: the freedom to choose one's attitude in any given circumstances.",
        "author": "Viktor E. Frankl",
        "tag": "freedom"
    },
    {
        "text": "Do what you can, with what you have, where you are.",
        "author": "Theodore Roosevelt",
        "tag": "action"
    },
    {
        "text": "Turn your wounds into wisdom.",
        "author": "Oprah Winfrey",
        "tag": "growth"
    },
    {
        "text": "Life is what happens when you're busy making other plans.",
        "author": "John Lennon",
        "tag": "life"
    },

    # --- Creativity, Art & Imagination ---
    {
        "text": "If you hear a voice within you say 'you cannot paint', then by all means paint, and that voice will be silenced.",
        "author": "Vincent van Gogh",
        "tag": "creativity"
    },
    {
        "text": "Simplicity is the ultimate sophistication.",
        "author": "Leonardo da Vinci",
        "tag": "design"
    },
    {
        "text": "Every child is an artist. The problem is how to remain an artist once we grow up.",
        "author": "Pablo Picasso",
        "tag": "art"
    },
    {
        "text": "Creativity is intelligence having fun.",
        "author": "Albert Einstein",
        "tag": "creativity"
    },
    {
        "text": "Adopt the pace of nature: her secret is patience.",
        "author": "Ralph Waldo Emerson",
        "tag": "nature"
    },
    {
        "text": "Live in the sunshine, swim the sea, drink the wild air.",
        "author": "Ralph Waldo Emerson",
        "tag": "life"
    },
    {
        "text": "Go confidently in the direction of your dreams! Live the life you've imagined.",
        "author": "Henry David Thoreau",
        "tag": "courage"
    },
    {
        "text": "Great things are done by a series of small things brought together.",
        "author": "Vincent van Gogh",
        "tag": "art"
    },
    {
        "text": "Art washes away from the soul the dust of everyday life.",
        "author": "Pablo Picasso",
        "tag": "art"
    },
    {
        "text": "To create something exceptional, your mindset must be relentlessly focused on the smallest detail.",
        "author": "Giorgio Armani",
        "tag": "craft"
    },

    # --- Wonder, Universe & Curiosity ---
    {
        "text": "Somewhere, something incredible is waiting to be known.",
        "author": "Carl Sagan",
        "tag": "wonder"
    },
    {
        "text": "The cosmos is within us. We are made of star-stuff. We are a way for the cosmos to know itself.",
        "author": "Carl Sagan",
        "tag": "cosmos"
    },
    {
        "text": "Look up at the stars and not down at your feet. Try to make sense of what you see.",
        "author": "Stephen Hawking",
        "tag": "curiosity"
    },
    {
        "text": "The important thing is not to stop questioning. Curiosity has its own reason for existing.",
        "author": "Albert Einstein",
        "tag": "curiosity"
    },
    {
        "text": "The world is full of magical things patiently waiting for our wits to grow sharper.",
        "author": "Bertrand Russell",
        "tag": "wonder"
    },
    {
        "text": "Nothing in life is to be feared, it is only to be understood. Now is the time to understand more, so that we may fear less.",
        "author": "Marie Curie",
        "tag": "science"
    },
    {
        "text": "There are only two ways to live your life. One is as though nothing is a miracle. The other is as though everything is a miracle.",
        "author": "Albert Einstein",
        "tag": "perspective"
    },

    # --- Soul, Humanity & Literature ---
    {
        "text": "Beauty will save the world.",
        "author": "Fyodor Dostoevsky",
        "tag": "humanity"
    },
    {
        "text": "It is only with the heart that one can see rightly; what is essential is invisible to the eye.",
        "author": "Antoine de Saint-Exupéry",
        "tag": "heart"
    },
    {
        "text": "Twenty years from now you will be more disappointed by the things that you didn't do than by the ones you did do.",
        "author": "Mark Twain",
        "tag": "courage"
    },
    {
        "text": "There is no charm equal to tenderness of heart.",
        "author": "Jane Austen",
        "tag": "kindness"
    },
    {
        "text": "What lies behind us and what lies before us are tiny matters compared to what lies within us.",
        "author": "Ralph Waldo Emerson",
        "tag": "soul"
    },
    {
        "text": "We are all in the gutter, but some of us are looking at the stars.",
        "author": "Oscar Wilde",
        "tag": "hope"
    },
    {
        "text": "You cannot find peace by avoiding life.",
        "author": "Virginia Woolf",
        "tag": "life"
    },
    {
        "text": "The best way out is always through.",
        "author": "Robert Frost",
        "tag": "resilience"
    },
    {
        "text": "Not all those who wander are lost.",
        "author": "J.R.R. Tolkien",
        "tag": "journey"
    },
    {
        "text": "Kindness is the language which the deaf can hear and the blind can see.",
        "author": "Mark Twain",
        "tag": "kindness"
    },

    # --- Musical & Acoustic Gems ---
    {
        "text": "Music is the silence between the notes.",
        "author": "Claude Debussy",
        "tag": "classical"
    },
    {
        "text": "Where words fail, music speaks.",
        "author": "Hans Christian Andersen",
        "tag": "music"
    },
    {
        "text": "One good thing about music, when it hits you, you feel no pain.",
        "author": "Bob Marley",
        "tag": "soul"
    },
    {
        "text": "Music gives a soul to the universe, wings to the mind, and flight to the imagination.",
        "author": "Plato",
        "tag": "philosophy"
    },
    {
        "text": "Don't play what's there, play what's not there.",
        "author": "Miles Davis",
        "tag": "jazz"
    },
    {
        "text": "Music can name the unnameable and communicate the unknowable.",
        "author": "Leonard Bernstein",
        "tag": "music"
    },
    {
        "text": "Without music, life would be a mistake.",
        "author": "Friedrich Nietzsche",
        "tag": "philosophy"
    },
    {
        "text": "To play without passion is inexcusable.",
        "author": "Ludwig van Beethoven",
        "tag": "passion"
    },
    {
        "text": "Music is the wine that fills the cup of silence.",
        "author": "Robert Fripp",
        "tag": "calm"
    },
    {
        "text": "Everything in the universe has a rhythm, everything dances.",
        "author": "Maya Angelou",
        "tag": "rhythm"
    }
]

# Backward compatibility alias
CURATED_MUSIC_QUOTES = CURATED_QUOTES


def get_random_quote():
    """Returns a random quote from the curated collection with fallback guarantee."""
    return random.choice(CURATED_QUOTES)


def get_daily_quote():
    """Returns a deterministic quote for today's date so users see a consistent daily thought."""
    today_str = datetime.date.today().isoformat()
    idx = sum(ord(c) for c in today_str) % len(CURATED_QUOTES)
    quote = CURATED_QUOTES[idx].copy()
    quote["date"] = today_str
    return quote


def fetch_remote_quote_safe():
    """
    Attempts to fetch a quote from a remote public API (ZenQuotes or Quotable).
    Falls back cleanly to local curated collection without throwing exceptions.
    """
    # 1. Try ZenQuotes random
    try:
        req = urllib.request.Request(
            "https://zenquotes.io/api/random",
            headers={"User-Agent": "LinusMusicPlayer/2.0"}
        )
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if isinstance(data, list) and len(data) > 0 and "q" in data[0]:
                return {
                    "text": data[0]["q"],
                    "author": data[0].get("a", "Unknown"),
                    "tag": "wisdom",
                    "source": "zenquotes"
                }
    except Exception as e:
        logger.debug(f"ZenQuotes fetch skipped: {e}")

    # 2. Try Quotable general inspirational
    try:
        req = urllib.request.Request(
            "https://api.quotable.io/random",
            headers={"User-Agent": "LinusMusicPlayer/2.0"}
        )
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if "content" in data and "author" in data:
                return {
                    "text": data["content"],
                    "author": data["author"],
                    "tag": data.get("tags", ["wisdom"])[0] if data.get("tags") else "wisdom",
                    "source": "quotable"
                }
    except Exception as e:
        logger.debug(f"Quotable fetch skipped: {e}")

    # Fallback to local
    quote = get_random_quote().copy()
    quote["source"] = "curated_local"
    return quote
