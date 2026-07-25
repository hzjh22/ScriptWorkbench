import argparse
import json
import sys


parser = argparse.ArgumentParser()
parser.add_argument("--book-url")
parser.add_argument("--output")
parser.add_argument("--chapters")
parser.add_argument("--watch-url")
parser.add_argument("--input-html")
parser.add_argument("--video-id")
parser.add_argument("--output-root")
parser.add_argument("--no-backup", action="store_true")
parser.add_argument("--no-browser-fallback", action="store_true")
parser.add_argument("--timeout", type=int, default=30)
args = parser.parse_args()

print("STRUCTURED_E2E_OK")
print(json.dumps({"argv": sys.argv[1:], "parsed": vars(args)}, ensure_ascii=False))
