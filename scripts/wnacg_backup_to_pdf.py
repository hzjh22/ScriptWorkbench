#!/usr/bin/env python3
"""Download a WNACG/Bazuo/Telegraph gallery and save it as a verified local PDF backup.

Example:
    python wnacg_backup_to_pdf.py \
      "https://www.wnacg.com/photos-slide-aid-370138.html" \
      -o "output/pdf/我的教师妈妈_01_370138.pdf" \
      --verify-render
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

try:
    import img2pdf
    import requests
    from PIL import Image, ImageChops, ImageStat
    from pypdf import PdfReader, PdfWriter
except ImportError as exc:
    raise SystemExit(
        "缺少依赖。请执行：\n"
        "python -m pip install requests Pillow img2pdf pypdf\n"
        f"详细信息：{exc}"
    ) from exc


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36"
)
FALLBACK_BASES = ("https://www.wn07.ru", "https://www.wn08.cfd")
IMAGE_EXT_RE = re.compile(r"\.(?:jpe?g|png|webp|gif)(?:[?#].*)?$", re.I)
DIRECT_FETCH_HOSTS: set[str] = set()
# Raw image + normalized JPEG + two PDF passes can need several MB per page.
PDF_WORK_BYTES_PER_PAGE = 6_000_000
PDF_WORK_OVERHEAD_BYTES = 512 * 1024 * 1024
E_TEMP_ROOT = Path(
    os.environ.get(
        "SCRIPT_WORKBENCH_PDF_TEMP_DIR",
        r"E:\ScriptWorkbench\artifacts\tmp\pdfs",
    )
).expanduser().resolve()

BAZUO_IMAGE_REFERER_MAP: list[tuple[str | tuple[str, ...], str]] = [
    # (host/suffix, referer) — matched by exact host or ".suffix"
    ("cdn.mmba.stream", "https://mhxiaoshen.vip/"),
    ("qy0.ru", "https://www.wnacg.com/"),
    ("960173.xyz", "https://reader.960173.xyz/"),
    ("bazuo.link", "https://manga.bazuo.link/"),
    ("graph.org", "https://graph.org/"),
    ("telegra.ph", "https://telegra.ph/"),
    ("komiic.com", "https://komiic.com/"),
    (("bilimanga.net", "bilicomic.net", "motiezw.com"), "https://www.bilimanga.net/"),
    (("hamreus.com", "mhgui.com", "manhuagui.com"), "https://www.manhuagui.com/"),
]


def _host_matches(host: str, suffix: str) -> bool:
    host = host.lower()
    suffix = suffix.lower()
    return host == suffix or host.endswith("." + suffix)


def image_referer_for(image_url: str, fallback: str) -> str:
    host = urlsplit(image_url).netloc.lower()
    for key, referer in BAZUO_IMAGE_REFERER_MAP:
        if isinstance(key, tuple):
            matched = any(_host_matches(host, suffix) for suffix in key)
        else:
            matched = _host_matches(host, key)
        if matched:
            return referer
    return fallback


def configure_output_streams() -> None:
    """Keep redirected Windows output Unicode-safe instead of inheriting GBK."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="backslashreplace")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="将 WNACG / Bazuo manga-app / Telegraph 图集完整下载、转成 PDF，并校验页数和页面渲染。"
    )
    p.add_argument("urls", nargs="+", metavar="URL", help="一个或多个图集阅读页 URL")
    p.add_argument("-o", "--output", type=Path, help="输出 PDF 路径")
    p.add_argument("--limit", type=int, default=0, help="调试用：最多下载前 N 页")
    p.add_argument("--work-dir", type=Path, help="临时下载根目录；每次运行自动创建隔离子目录")
    p.add_argument("--workers", type=int, default=8, help="并发下载数，默认 8")
    p.add_argument("--quality", type=int, default=95, help="标准化 JPEG 质量，默认 95")
    p.add_argument("--timeout", type=int, default=75, help="单次请求超时秒数，默认 75")
    p.add_argument("--retries", type=int, default=6, help="每页最大下载次数，默认 6")
    p.add_argument(
        "--verify-render",
        action="store_true",
        help="使用 Poppler 逐页渲染 PDF，并和源图缩略图比较",
    )
    p.add_argument("--keep-temp", action="store_true", help="成功后保留原图及校验文件")
    p.add_argument("--overwrite", action="store_true", help="覆盖已经存在的输出 PDF")
    p.add_argument(
        "--insecure",
        action="store_true",
        help="关闭 TLS 证书验证，仅在本机代理导致证书错误时使用",
    )
    return p.parse_args()


def is_bazuo_manga_app_url(url: str) -> bool:
    parts = urlsplit(url)
    return (
        parts.hostname
        and parts.hostname.lower() == "manga.bazuo.link"
        and parts.path.startswith("/manga-app/")
    )


def wnacg_aid_from_url(url: str) -> int | None:
    m = re.search(r"aid-(\d+)", url)
    return int(m.group(1)) if m else None


def gallery_id_from_url(url: str) -> str:
    aid = wnacg_aid_from_url(url)
    if aid is not None:
        return str(aid)
    parts = urlsplit(url)
    host = re.sub(r"[^A-Za-z0-9]+", "_", parts.netloc).strip("_") or "page"
    slug = unquote(Path(parts.path).stem or Path(parts.path).name or "gallery")
    slug = safe_filename(re.sub(r"\s+", "_", slug)).strip("_ .")[:48] or "gallery"
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
    return f"{host}_{slug}_{digest}"


def clean_title(page_html: str, aid: int) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", page_html, re.I | re.S)
    title = html.unescape(re.sub(r"\s+", " ", m.group(1))).strip() if m else f"wnacg_{aid}"
    title = re.split(r"\s+-\s+(?:列表|紳士漫畫|绅士漫画)", title, maxsplit=1)[0].strip()
    return title or f"wnacg_{aid}"


def safe_filename(value: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip().rstrip(".")
    return value[:120] or "wnacg_backup"


def default_output_filename(title: str, aid: int) -> str:
    """Build: title without leading author + underscores + album id + .pdf."""
    work_title = re.sub(
        r"^\s*(?:\[[^\]]+\]|【[^】]+】)\s*", "", title, count=1
    ).strip()
    work_title = re.sub(r"\s+", "_", work_title)
    work_title = safe_filename(work_title).strip("_ .") or "wnacg"
    return f"{work_title}_{aid}.pdf"


def resolve_output_path(requested: Path | None, title: str, aid: int) -> Path:
    """Accept either a PDF filename or an output directory for --output."""
    filename = default_output_filename(title, aid)
    if requested is None:
        return (Path("output/pdf") / filename).resolve()
    requested = requested.expanduser()
    if requested.is_dir() or requested.suffix.lower() != ".pdf":
        requested = requested / filename
    return requested.resolve()


def resolve_bazuo_output_path(requested: Path | None, title: str) -> Path:
    """Name Bazuo exports after the comic title, e.g. ``海女实习生.pdf``."""
    filename = safe_filename(re.sub(r"\s+", "_", title).strip("_ .")) + ".pdf"
    if requested is None:
        return (Path("output/pdf") / filename).resolve()
    requested = requested.expanduser()
    if requested.is_dir() or requested.suffix.lower() != ".pdf":
        requested = requested / filename
    return requested.resolve()


def direct_request_get(url: str, *, headers: dict[str, str], timeout: int, verify_tls: bool, allow_redirects: bool = True) -> requests.Response:
    session = requests.Session()
    session.trust_env = False
    response = session.get(
        url,
        headers=headers,
        timeout=timeout,
        verify=verify_tls,
        allow_redirects=allow_redirects,
    )
    response.raise_for_status()
    return response


def request_get(url: str, *, headers: dict[str, str], timeout: int, verify_tls: bool, allow_redirects: bool = True) -> requests.Response:
    """Fetch with env proxy first, then remember hosts that work better by direct connection."""
    host = urlsplit(url).netloc.lower()
    if host in DIRECT_FETCH_HOSTS:
        return direct_request_get(
            url, headers=headers, timeout=timeout, verify_tls=verify_tls, allow_redirects=allow_redirects
        )
    try:
        response = requests.get(
            url,
            headers=headers,
            timeout=timeout,
            verify=verify_tls,
            allow_redirects=allow_redirects,
        )
        response.raise_for_status()
        return response
    except requests.RequestException as first_exc:
        try:
            response = direct_request_get(
                url, headers=headers, timeout=timeout, verify_tls=verify_tls, allow_redirects=allow_redirects
            )
            DIRECT_FETCH_HOSTS.add(host)
            print(f"[网络] 环境代理请求失败，已对 {host} 切换为直连：{type(first_exc).__name__}: {first_exc}")
            return response
        except requests.RequestException:
            raise first_exc


def clean_page_title(page_html: str, fallback: str) -> str:
    og = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)', page_html, re.I | re.S)
    if og:
        title = html.unescape(og.group(1)).strip()
    else:
        m = re.search(r"<title[^>]*>(.*?)</title>", page_html, re.I | re.S)
        title = html.unescape(re.sub(r"\s+", " ", m.group(1))).strip() if m else fallback
    title = re.sub(r"\s+[–-]\s+Telegraph\s*$", "", title, flags=re.I).strip()
    return title or fallback


def extract_image_urls(page_html: str, base_url: str) -> list[str]:
    urls: list[str] = []
    for match in re.finditer(r"<img\b[^>]*>", page_html, re.I | re.S):
        tag = match.group(0)
        for attr in ("src", "data-src", "data-original", "data-lazy-src"):
            attr_match = re.search(attr + r'\s*=\s*(["\'])(.*?)\1', tag, re.I | re.S)
            if not attr_match:
                continue
            image_url = html.unescape(attr_match.group(2)).strip()
            if not image_url or image_url.startswith("data:"):
                continue
            image_url = urljoin(base_url, image_url)
            if IMAGE_EXT_RE.search(image_url):
                urls.append(image_url)
            break
    return list(dict.fromkeys(urls))


def fetch_html_image_metadata(source_url: str, gallery_id: str, timeout: int, verify_tls: bool) -> tuple[str, str, list[str], str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    page = request_get(source_url, headers=headers, timeout=timeout, verify_tls=verify_tls)
    page_html = page.content.decode(page.encoding or "utf-8", "replace")
    title = clean_page_title(page_html, gallery_id)
    urls = extract_image_urls(page_html, page.url)
    if not urls:
        raise ValueError("页面中未发现可下载图片")
    return title, page.url, urls, page_html


def candidate_bases(source_url: str) -> list[str]:
    parts = urlsplit(source_url)
    first = f"{parts.scheme or 'https'}://{parts.netloc}" if parts.netloc else ""
    return list(dict.fromkeys(x.rstrip("/") for x in (first, *FALLBACK_BASES) if x))


def fetch_wnacg_metadata(
    source_url: str, aid: int, timeout: int, verify_tls: bool
) -> tuple[str, str, list[str], str]:
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9"}
    errors: list[str] = []
    for base in candidate_bases(source_url):
        page_url = urljoin(base + "/", f"photos-slide-aid-{aid}.html")
        try:
            page = request_get(
                page_url,
                headers=headers,
                timeout=timeout,
                verify_tls=verify_tls,
                allow_redirects=True,
            )
            page_html = page.content.decode("utf-8", "replace")
            if f"photos-item-aid-{aid}.html" not in page_html:
                raise ValueError("页面中缺少图集数据入口")

            item_url = urljoin(page.url, f"/photos-item-aid-{aid}.html")
            item = request_get(
                item_url,
                headers={**headers, "Referer": page.url},
                timeout=timeout,
                verify_tls=verify_tls,
            )
            script = item.content.decode("utf-8", "replace")
            block = re.search(r'"page_url"\s*:\s*\[(.*?)\]', script, re.I | re.S)
            if not block:
                raise ValueError("图集数据中缺少 page_url")
            urls = re.findall(
                r'"((?:https?:)?//[^"\\]+?\.(?:jpe?g|png|webp)(?:\?[^"\\]*)?)"',
                block.group(1),
                re.I,
            )
            urls = list(dict.fromkeys("https:" + u if u.startswith("//") else u for u in urls))
            urls = [re.sub(r"^http://", "https://", u, flags=re.I) for u in urls]
            if not urls:
                raise ValueError("图集图片列表为空")
            return clean_title(page_html, aid), page.url, urls, script
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{page_url}: {type(exc).__name__}: {exc}")
    raise RuntimeError("所有站点入口均失败：\n" + "\n".join(errors))


def fetch_gallery_metadata(
    source_url: str, gallery_id: str, timeout: int, verify_tls: bool
) -> tuple[str, str, list[str], str]:
    if is_bazuo_manga_app_url(source_url):
        return fetch_bazuo_metadata(source_url, timeout, verify_tls)
    aid = wnacg_aid_from_url(source_url)
    if aid is not None:
        return fetch_wnacg_metadata(source_url, aid, timeout, verify_tls)
    return fetch_html_image_metadata(source_url, gallery_id, timeout, verify_tls)


def fetch_bazuo_metadata(
    source_url: str, timeout: int, verify_tls: bool
) -> tuple[str, str, list[str], str]:
    """Parse manga.bazuo.link/manga-app/… URL and return (title, referer, image_urls, raw_json)."""
    parsed = urlsplit(source_url)
    params = parse_qs(parsed.query, keep_blank_values=True)
    comic_id = (params.get("comic") or [""])[0].strip()
    chapter_id = (params.get("chapter") or [""])[0].strip()
    chapters_mode = any(
        value.strip().lower() in {"1", "true", "yes"}
        for value in params.get("chapters", [])
    )
    if not comic_id:
        raise ValueError("manga-app URL 缺少 comic 参数")

    base = f"{parsed.scheme or 'https'}://{parsed.netloc}"
    app_base = base + "/manga-app/"
    json_url = app_base + "data/comics/" + quote(comic_id, safe="") + ".json"

    headers = {
        "User-Agent": USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept": "application/json",
    }
    resp = request_get(json_url, headers=headers, timeout=timeout, verify_tls=verify_tls)
    data = resp.json()

    comic_title = str(data.get("title") or comic_id or "manga")
    chapters = data.get("chapters") or []
    root_pages = data.get("pages") or []

    selected: list[dict[str, object]] = []
    if chapter_id:
        for chapter in chapters:
            if str(chapter.get("id", "")) == chapter_id:
                selected.append(chapter)
                break
        if not selected:
            if not chapters:
                raise ValueError(f"章节 {chapter_id} 未找到，漫画数据中没有章节信息")
            available = ", ".join(str(chapter.get("id", "?")) for chapter in chapters)
            raise ValueError(f"章节 {chapter_id} 未找到，可用章节：{available}")
    elif chapters:
        # The share link uses chapters=1 to open the catalogue for an entire
        # comic, so a catalogue link should back up every listed chapter.
        selected = chapters if chapters_mode else chapters[:1]

    raw_pages: list[object] = []
    for chapter in selected:
        raw_pages.extend(chapter.get("pages") or [])
    if not raw_pages and not selected:
        raw_pages = root_pages
    if not raw_pages:
        raise ValueError("漫画数据中无章节信息或图片信息")

    urls: list[str] = []
    if selected:
        for chapter in selected:
            urls.extend(extract_bazuo_page_urls(chapter.get("pages") or [], app_base))
    else:
        urls = extract_bazuo_page_urls(root_pages, app_base)
    if not urls:
        raise ValueError(f"漫画 {comic_id} 中未找到图片 URL")
    # The output artifact represents the comic, not an implementation detail
    # of the grouped chapter (for example, "1-102"). Keep the chapter title
    # in the raw manifest data, while naming the PDF after the comic title.
    return comic_title, source_url, urls, json.dumps(data, ensure_ascii=False)


def extract_bazuo_page_urls(raw_pages: list[object], app_base: str) -> list[str]:
    """Normalize manga-app JSON page entries into absolute http(s) image URLs."""
    urls: list[str] = []
    for page in raw_pages:
        if isinstance(page, str):
            candidate = page
        elif isinstance(page, dict):
            candidate = next(
                (
                    value
                    for key in ("directSrc", "sourceUrl", "imageUrl", "src", "url")
                    if (value := page.get(key))
                ),
                None,
            )
        else:
            candidate = None
        if not candidate:
            continue
        candidate_str = str(candidate).strip()
        if not candidate_str or candidate_str.lower().startswith("data:"):
            continue
        image_url = urljoin(app_base, candidate_str)
        if image_url.lower().startswith(("http://", "https://")):
            urls.append(image_url)
    return list(dict.fromkeys(urls))


def normalize_image(data: bytes, output: Path, quality: int) -> dict[str, object]:
    with Image.open(io.BytesIO(data)) as im:
        source_format = im.format or "unknown"
        im.load()
        width, height = im.size
        frames = getattr(im, "n_frames", 1)
        if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
            rgba = im.convert("RGBA")
            rgb = Image.new("RGB", rgba.size, "white")
            rgb.paste(rgba, mask=rgba.getchannel("A"))
        else:
            rgb = im.convert("RGB")
        rgb.save(output, "JPEG", quality=quality, subsampling=0, optimize=True)
    with Image.open(output) as check:
        check.verify()
    return {
        "source_format": source_format,
        "width": width,
        "height": height,
        "frames": frames,
    }


def download_page(
    number: int,
    url: str,
    raw_dir: Path,
    page_dir: Path,
    referer: str,
    timeout: int,
    retries: int,
    quality: int,
    verify_tls: bool,
) -> dict[str, object]:
    raw_path = raw_dir / f"{number:04d}.bin"
    page_path = page_dir / f"{number:04d}.jpg"
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": image_referer_for(url, referer),
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            if raw_path.exists() and raw_path.stat().st_size > 1024:
                data = raw_path.read_bytes()
            else:
                response = request_get(
                    url, headers=headers, timeout=timeout, verify_tls=verify_tls
                )
                data = response.content
                if len(data) <= 1024:
                    raise ValueError(f"响应过小：{len(data)} bytes")
                raw_path.write_bytes(data)
            info = normalize_image(data, page_path, quality)
            return {
                "page": number,
                "url": url,
                "raw_bytes": len(data),
                "raw_sha256": hashlib.sha256(data).hexdigest(),
                "pdf_image_bytes": page_path.stat().st_size,
                "pdf_image_sha256": hashlib.sha256(page_path.read_bytes()).hexdigest(),
                **info,
            }
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            raw_path.unlink(missing_ok=True)
            page_path.unlink(missing_ok=True)
            if attempt < retries:
                time.sleep(min(2**attempt, 20))
    raise RuntimeError(f"第 {number} 页下载/解码失败：{last_error}")


def download_all(
    urls: list[str],
    raw_dir: Path,
    page_dir: Path,
    referer: str,
    args: argparse.Namespace,
) -> list[dict[str, object]]:
    raw_dir.mkdir(parents=True, exist_ok=True)
    page_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, object]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(
                download_page,
                n,
                url,
                raw_dir,
                page_dir,
                referer,
                args.timeout,
                args.retries,
                args.quality,
                not args.insecure,
            ): n
            for n, url in enumerate(urls, 1)
        }
        try:
            for done, fut in enumerate(concurrent.futures.as_completed(futures), 1):
                records.append(fut.result())
                if done % 10 == 0 or done == len(urls):
                    print(f"[下载校验] {done}/{len(urls)}", flush=True)
        except Exception:
            for fut in futures:
                fut.cancel()
            raise
    records.sort(key=lambda x: int(x["page"]))
    if [int(x["page"]) for x in records] != list(range(1, len(urls) + 1)):
        raise RuntimeError("下载结果页码不连续")
    return records


def build_pdf(images: list[Path], output: Path, temp_pdf: Path, title: str, aid: int) -> None:
    with temp_pdf.open("wb") as f:
        img2pdf.convert([str(p) for p in images], outputstream=f)
    temp_reader = PdfReader(temp_pdf)
    if len(temp_reader.pages) != len(images):
        raise RuntimeError(f"临时 PDF 页数错误：{len(temp_reader.pages)}/{len(images)}")
    writer = PdfWriter(clone_from=temp_pdf)
    writer.add_metadata(
        {
            "/Title": title,
            "/Subject": f"网站内容本地备份 - album {aid}",
            "/Keywords": f"backup, wnacg, {aid}",
            "/Creator": "wnacg_backup_to_pdf.py",
        }
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as f:
        writer.write(f)


def find_pdftoppm() -> Path | None:
    found = shutil.which("pdftoppm")
    if found and (os.name != "nt" or Path(found).suffix.lower() == ".exe"):
        return Path(found)
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Packages"
        matches = list(root.glob("oschwartz10612.Poppler_*/poppler-*/Library/bin/pdftoppm.exe"))
        if matches:
            return sorted(matches)[-1]
    return Path(found) if found else None


def render_verify(pdf: Path, images: list[Path], render_dir: Path) -> dict[str, object]:
    pdftoppm = find_pdftoppm()
    if not pdftoppm:
        raise RuntimeError(
            "未找到 pdftoppm。Windows 可执行：\n"
            "winget install --id oschwartz10612.Poppler --exact"
        )
    if render_dir.exists():
        shutil.rmtree(render_dir)
    render_dir.mkdir(parents=True)
    prefix = render_dir / "page"
    subprocess.run(
        [
            str(pdftoppm),
            "-r",
            "30",
            "-jpeg",
            "-jpegopt",
            "quality=80",
            str(pdf),
            str(prefix),
        ],
        check=True,
    )
    renders = sorted(render_dir.glob("page-*.jpg"))
    if len(renders) != len(images):
        raise RuntimeError(f"渲染页数错误：{len(renders)}/{len(images)}")
    max_mae = 0.0
    min_stddev = float("inf")
    source_blank_pages: list[int] = []
    for n, (source_path, render_path) in enumerate(zip(images, renders), 1):
        with Image.open(source_path) as source, Image.open(render_path) as rendered:
            source = source.convert("RGB").resize(rendered.size, Image.Resampling.LANCZOS)
            rendered = rendered.convert("RGB")
            diff = ImageStat.Stat(ImageChops.difference(source, rendered))
            mae = sum(diff.mean) / 3
            source_stddev = sum(ImageStat.Stat(source).stddev) / 3
            stddev = sum(ImageStat.Stat(rendered).stddev) / 3
            max_mae = max(max_mae, mae)
            min_stddev = min(min_stddev, stddev)
            if mae >= 25:
                raise RuntimeError(f"第 {n} 页渲染与源图差异过大：MAE={mae:.2f}")
            if source_stddev <= 5:
                source_blank_pages.append(n)
            elif stddev <= 5:
                raise RuntimeError(f"第 {n} 页疑似空白或纯色页：stddev={stddev:.2f}")
    return {
        "rendered_pages": len(renders),
        "max_mean_absolute_error": round(max_mae, 4),
        "min_page_stddev": round(min_stddev, 4),
        "source_blank_pages": source_blank_pages,
        "pdftoppm": str(pdftoppm),
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def readable_pdf_page_count(path: Path) -> int | None:
    try:
        return len(PdfReader(path).pages)
    except Exception:  # noqa: BLE001
        return None


def free_bytes_on_path(path: Path) -> int:
    current = path
    while not current.exists() and current.parent != current:
        current = current.parent
    try:
        return shutil.disk_usage(current).free
    except OSError:
        return 0


def choose_work_root(preferred: Path, required_bytes: int) -> tuple[Path, bool]:
    """Keep PDF work on a drive that can hold images and both PDF passes."""
    candidates: list[Path] = [preferred, E_TEMP_ROOT]
    for env_name in ("TEMP", "TMP"):
        env_value = os.environ.get(env_name)
        if env_value:
            candidates.append(Path(env_value).expanduser())
    candidates.append(Path(tempfile.gettempdir()))
    seen: set[str] = set()
    for root in candidates:
        root = root.expanduser().resolve()
        key = str(root).casefold()
        if key in seen:
            continue
        seen.add(key)
        if free_bytes_on_path(root) >= required_bytes:
            return root, root != preferred
    return preferred, False


def install_staged_pdf(staged_output: Path, output: Path) -> None:
    """Move a staged PDF into place, copying across drives when necessary."""
    output.parent.mkdir(parents=True, exist_ok=True)
    if staged_output.anchor.casefold() == output.anchor.casefold():
        staged_output.replace(output)
        return
    incoming = output.with_name(f"{output.name}.incoming-{os.getpid()}.tmp")
    incoming.unlink(missing_ok=True)
    try:
        shutil.copyfile(staged_output, incoming)
        incoming.replace(output)
    finally:
        incoming.unlink(missing_ok=True)
        staged_output.unlink(missing_ok=True)


def process_gallery(
    args: argparse.Namespace,
    source_url: str,
    batch_index: int = 1,
    batch_total: int = 1,
) -> str:
    gallery_id = gallery_id_from_url(source_url)
    requested_work_root = (args.work_dir or Path("tmp/pdfs")).expanduser().resolve()

    if batch_total > 1:
        print(f"\n{'=' * 72}")
        print(f"[批量 {batch_index}/{batch_total}] {source_url}")
        print(f"{'=' * 72}")
    print(f"[1/5] 读取图集信息：id={gallery_id}")
    title, resolved_page, urls, item_script = fetch_gallery_metadata(
        source_url, gallery_id, args.timeout, not args.insecure
    )
    total_pages = len(urls)
    bazuo_data: dict[str, object] | None = None
    if is_bazuo_manga_app_url(source_url):
        try:
            bazuo_data = json.loads(item_script)
        except (TypeError, json.JSONDecodeError):
            bazuo_data = None
    if args.limit and args.limit < total_pages:
        urls = urls[:args.limit]
        print(f"调试限页：下载 {len(urls)}/{total_pages} 页")
    output = (
        resolve_bazuo_output_path(args.output, title)
        if is_bazuo_manga_app_url(source_url)
        else resolve_output_path(args.output, title, gallery_id)
    )
    bazuo_chapter_count = (
        len(bazuo_data.get("chapters") or []) if bazuo_data else None
    )
    replace_stale_output = False
    if output.exists() and not args.overwrite:
        existing_pages = readable_pdf_page_count(output)
        if (
            bazuo_chapter_count is not None
            and not args.limit
            and existing_pages is not None
            and existing_pages != total_pages
        ):
            print(
                f"[更新] 已存在 {output.name}（{existing_pages} 页），"
                f"本次整本漫画为 {total_pages} 页，将覆盖不完整旧备份"
            )
            replace_stale_output = True
        else:
            print(f"[跳过] 输出已存在：{output}")
            return "skipped"
    pages_to_work = len(urls)
    required_bytes = (
        pages_to_work * PDF_WORK_BYTES_PER_PAGE + PDF_WORK_OVERHEAD_BYTES
    )
    work_root, switched_for_space = choose_work_root(
        requested_work_root, required_bytes
    )
    if switched_for_space:
        free_gb = free_bytes_on_path(requested_work_root) / (1024**3)
        needed_gb = required_bytes / (1024**3)
        print(
            f"[空间] {requested_work_root.anchor} 可用 {free_gb:.2f}GB，"
            f"本次预计需要 {needed_gb:.2f}GB；临时工作目录已切换到：{work_root}"
        )
    # Every batch item gets its own directory, including repeated copies of one URL.
    work_dir = work_root / f"gallery_{gallery_id}_{os.getpid()}_{batch_index:03d}"
    raw_dir = work_dir / "raw"
    page_dir = work_dir / "pages"
    render_dir = work_dir / "render"
    work_dir.mkdir(parents=True, exist_ok=False)
    print(f"隔离临时目录：{work_dir}")
    print(f"标题：{title}")
    if bazuo_chapter_count:
        print(f"章节模式：合并 {bazuo_chapter_count} 节，共 {total_pages} 页")
    print(f"输出文件名：{output.name}")
    print(f"页面入口：{resolved_page}")
    if args.limit and args.limit < total_pages:
        print(f"本次下载页数：{len(urls)}（共 {total_pages} 页）")
    else:
        print(f"发现页数：{len(urls)}")
    (work_dir / "item-script.js").write_text(item_script, "utf-8")

    print("[2/5] 下载并解码所有页面")
    records = download_all(urls, raw_dir, page_dir, resolved_page, args)
    images = [page_dir / f"{number:04d}.jpg" for number in range(1, len(urls) + 1)]
    missing_images = [str(path) for path in images if not path.is_file()]
    if missing_images:
        raise RuntimeError(
            f"标准化页面缺失：{len(missing_images)}/{len(urls)}，首个：{missing_images[0]}"
        )

    print("[3/5] 生成 PDF")
    temp_pdf = work_dir / "content.tmp.pdf"
    staged_output = work_dir / "verified-output.tmp.pdf"
    build_pdf(images, staged_output, temp_pdf, title, gallery_id)
    reader = PdfReader(staged_output)
    if len(reader.pages) != len(urls):
        raise RuntimeError(f"PDF 页数错误：{len(reader.pages)}/{len(urls)}")
    if reader.metadata.title != title:
        raise RuntimeError("PDF 中文标题元数据校验失败")

    render_result: dict[str, object] | None = None
    if args.verify_render:
        print("[4/5] 使用 Poppler 逐页渲染校验")
        render_result = render_verify(staged_output, images, render_dir)
    else:
        print("[4/5] 已跳过渲染校验；使用 --verify-render 可开启")

    print("[5/5] 写入校验记录")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not args.overwrite and not replace_stale_output:
        print(f"[跳过] 另一个运行已生成输出：{output}")
        if not args.keep_temp:
            shutil.rmtree(work_dir)
        return "skipped"
    install_staged_pdf(staged_output, output)
    result = {
        "id": gallery_id,
        "title": title,
        "requested_url": source_url,
        "resolved_page": resolved_page,
        "page_count": len(urls),
        "page_total": total_pages,
        "pdf": str(output),
        "pdf_bytes": output.stat().st_size,
        "pdf_sha256": sha256_file(output),
        "render_verification": render_result,
        "pages": records,
    }
    if bazuo_chapter_count is not None:
        result["chapter_count"] = bazuo_chapter_count
        site_page_count = bazuo_data.get("pageCount") if bazuo_data else None
        if site_page_count is not None:
            result["site_page_count"] = int(site_page_count)
    manifest = work_dir / "manifest.json"
    manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2), "utf-8")
    print(
        json.dumps(
            {k: v for k, v in result.items() if k != "pages"},
            ensure_ascii=False,
            indent=2,
        )
    )

    if not args.keep_temp:
        shutil.rmtree(work_dir)
        print(f"已清理临时目录：{work_dir}")
    else:
        print(f"临时文件及清单：{work_dir}")
    return "finished"


def main() -> int:
    configure_output_streams()
    args = parse_args()
    if not 1 <= args.workers <= 32:
        raise SystemExit("--workers 应在 1 到 32 之间")
    if not 70 <= args.quality <= 100:
        raise SystemExit("--quality 应在 70 到 100 之间")
    if args.limit < 0:
        raise SystemExit("--limit 不能为负数")
    if len(args.urls) > 100:
        raise SystemExit("单次运行最多输入 100 个 URL")
    if len(args.urls) > 1 and args.output and args.output.suffix.lower() == ".pdf":
        raise SystemExit("批量 URL 模式的 --output 应填写目录，而不是单个 PDF 文件")

    if len(args.urls) == 1:
        process_gallery(args, args.urls[0])
        return 0

    counts = {"finished": 0, "skipped": 0, "failed": 0}
    failures: list[dict[str, str]] = []
    for index, source_url in enumerate(args.urls, 1):
        try:
            status = process_gallery(args, source_url, index, len(args.urls))
            counts[status] += 1
        except Exception as exc:  # noqa: BLE001
            counts["failed"] += 1
            failures.append({"url": source_url, "error": f"{type(exc).__name__}: {exc}"})
            print(f"[批量失败 {index}/{len(args.urls)}] {source_url}", file=sys.stderr)
            traceback.print_exc()

    summary = {
        "batch_total": len(args.urls),
        **counts,
        "failures": failures,
    }
    print("\n批量执行汇总：")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit("用户中止；本次隔离临时文件已保留")


