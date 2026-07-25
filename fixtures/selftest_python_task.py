import argparse
import json
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ping", default="none")
    parser.add_argument("--extra", default="")
    args = parser.parse_args()

    payload = {
        "argv": sys.argv[1:],
        "ping": args.ping,
        "extra": args.extra,
        "cwd": str(Path.cwd()),
        "python": sys.executable,
        "selftest_env": os.environ.get("SELFTEST_ENV", ""),
    }
    print("SELFTEST_PYTHON_OK")
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
