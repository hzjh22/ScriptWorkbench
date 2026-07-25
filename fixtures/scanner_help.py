import sys


if "--help" in sys.argv:
    print("usage: scanner_help.py [--from-help VALUE] [--switch]")
    print()
    print("options:")
    print("  --from-help VALUE  Option discovered from help")
    print("  --switch           Boolean discovered from help")

