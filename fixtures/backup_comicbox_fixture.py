import argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--book-url")
parser.add_argument("--output", type=Path)
parser.add_argument("--chapters", help="留空下载全部章节")
parser.add_argument("--limit", type=int, help="只处理前 N 个章节")
parser.add_argument("--delay", type=float, default=0.15)
parser.add_argument("--workers", type=int, default=4)
parser.add_argument("--http-pool-size", type=int, help="HTTP 连接池大小")
parser.add_argument("--no-proxy", action="store_true")
parser.add_argument("--proxy")
parser.add_argument("--image-quality", type=int)
parser.add_argument("--image-optimize", action="store_true")
parser.add_argument("--pdf-backend", choices=["auto", "img2pdf", "pillow"])
parser.add_argument("--quiet-pages", action="store_true")
parser.add_argument("--force-pdf", action="store_true")
parser.add_argument("--fail-missing", action="store_true")
