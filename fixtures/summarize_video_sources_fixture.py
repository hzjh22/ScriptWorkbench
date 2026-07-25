import argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--watch-url")
parser.add_argument("--input-html", type=Path)
parser.add_argument("--video-id")
parser.add_argument("--cookie-header")
parser.add_argument("--proxy")
parser.add_argument("--direct", action="store_true")
parser.add_argument("--output-root", type=Path)
parser.add_argument("--no-backup", action="store_true")
parser.add_argument("--no-browser-fallback", action="store_true")
parser.add_argument("--timeout", type=int, default=30)

