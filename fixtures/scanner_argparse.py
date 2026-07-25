"""Argparse scanner fixture."""

import argparse
from pathlib import Path

parser = argparse.ArgumentParser(description="Download a comic backup")
parser.add_argument("--book-url", required=True, help="Comic page URL")
parser.add_argument("--output", type=Path, required=True, help="Backup directory")
parser.add_argument("--chapters", help="Chapter range")
parser.add_argument("--workers", type=int, default=12, choices=[4, 8, 12])
parser.add_argument("--quiet-pages", action="store_true")
parser.add_argument("--header", action="append")
network = parser.add_mutually_exclusive_group()
network.add_argument("--direct", action="store_true")
network.add_argument("--proxy")

