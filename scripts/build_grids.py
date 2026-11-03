#!/usr/bin/env python3
"""Build public/grids.json: tiny quantized versions of Harvard Art Museums paintings.

Steps:
  1. Fetch paintings with images from the Harvard Art Museums API (all of
     them by default, in the API's seeded random order).
  2. Download a small version of each image.
  3. Downsample each image to an N x N grid.
  4. Fit ONE global palette with k-means in CIE Lab space, using every pixel
     of the downsampled collection.
  5. Keep only paintings that are still legible as a grid (see Rules): not
     one flat color, several colors, some light/dark contrast, and not so
     tall or wide that squeezing into a square wrecks the composition. The
     first --count legible paintings are kept, the palette is refitted to
     them, and this repeats until the selection settles.
  6. Map each pixel to its nearest palette color (Lab distance) and write
     grids.json: {palette, works: [{id, title, artist, culture, dated, aspect,
     grid}], selection: {...what the filter removed...}}.

The API key is read from the HARVARD_API_KEY environment variable, or from a
.env file in the repo root. It is never printed or written to the output.

Usage:
  python scripts/build_grids.py                 # 16x16 -> public/grids.json
  python scripts/build_grids.py --size 8        # 8x8   -> public/grids-8.json
  python scripts/build_grids.py --size 16 8     # both, sharing one palette
  python scripts/build_grids.py --max-dominant 1 --min-colors 1 --min-contrast 0 --max-aspect 99
                                                # no legibility filter
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from dataclasses import dataclass
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.harvardartmuseums.org/object"
FIELDS = [
    "id",
    "title",
    "people",
    "culture",
    "dated",
    "primaryimageurl",
    "images",
    "imagepermissionlevel",
]
PAGE_SIZE = 100
USER_AGENT = "InfiniteMonkeyMuseum/1.0 (data pipeline)"


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def log(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def read_api_key() -> str | None:
    """HARVARD_API_KEY from the environment, else from ROOT/.env."""
    key = os.environ.get("HARVARD_API_KEY", "").strip()
    if key:
        return key
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            m = re.match(r"\s*HARVARD_API_KEY\s*=\s*(.*)\s*$", line)
            if m:
                return m.group(1).strip().strip("'\"") or None
    return None


def redact(text: str) -> str:
    """Remove the API key from anything we might print (URLs, errors)."""
    return re.sub(r"apikey=[^&\s]+", "apikey=REDACTED", str(text))


class FetchError(RuntimeError):
    """A failed GET. `reason` is short ("HTTP 403", "timed out") for tallying;
    `detail` describes the server's response, for diagnosing refusals."""

    def __init__(self, url: str, reason: str, detail: str = ""):
        super().__init__(redact(f"GET {url} failed: {reason}"))
        self.reason = reason
        self.detail = detail


def _describe_refusal(e: urllib.error.HTTPError) -> str:
    """Which server refused, and what it said (headers + start of the body)."""
    headers = e.headers or {}
    parts = [f"server={headers.get('Server', '?')}"]
    for name in ("cf-mitigated", "cf-ray", "x-amzn-waf-action", "x-cache", "via", "content-type"):
        if headers.get(name):
            parts.append(f"{name}={headers.get(name)}")
    try:
        body = e.read(2000).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 - best effort diagnostics only
        body = ""
    body = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", body, flags=re.S | re.I)
    body = " ".join(re.sub(r"<[^>]+>", " ", body).split())
    if body:
        parts.append(f'body="{body[:240]}"')
    return redact(" ".join(parts))


def _reason(e: Exception) -> str:
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code}"
    if isinstance(e, urllib.error.URLError):
        e = e.reason if isinstance(e.reason, Exception) else e
    if isinstance(e, TimeoutError) or "timed out" in str(e):
        return "timed out"
    return redact(f"{type(e).__name__}: {e}")[:80]


def http_get(url: str, timeout: float = 30, retries: int = 3) -> bytes:
    """GET with retries and exponential backoff. Raises FetchError on final failure."""
    reason, detail = "no attempts", ""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            reason = _reason(e)
            detail = _describe_refusal(e)
            # 4xx other than 429 won't get better by retrying.
            if 400 <= e.code < 500 and e.code != 429:
                break
        except (urllib.error.URLError, OSError) as e:
            reason = _reason(e)
            detail = ""
        if attempt < retries - 1:
            time.sleep(1.5 * 2**attempt)
    raise FetchError(url, reason, detail)


def clean(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value or None


def artist_of(record: dict) -> str | None:
    people = record.get("people") or []
    for person in people:
        if (person.get("role") or "").lower() == "artist" and person.get("name"):
            return clean(person["name"])
    for person in people:
        if person.get("name"):
            return clean(person["name"])
    return None


def small_image_urls(record: dict, px: int) -> list[str]:
    """Candidate URLs for a small (<= px on the long side) version of the image:
    the IIIF image service first (one request), then the primary image URL,
    which redirects to the same service."""
    urls = []
    for image in record.get("images") or []:
        base = image.get("iiifbaseuri")
        if base:
            urls.append(f"{base.rstrip('/')}/full/!{px},{px}/0/default.jpg")
            break
    primary = record.get("primaryimageurl")
    if primary:
        parts = urllib.parse.urlsplit(primary)
        query = urllib.parse.urlencode({"width": px, "height": px})
        urls.append(urllib.parse.urlunsplit(parts._replace(query=query)))
    return urls


# --------------------------------------------------------------------------
# 1. Fetch records
# --------------------------------------------------------------------------


def fetch_records(api_key: str, limit: int | None, seed: int, max_pages: int = 100) -> list[dict]:
    """Usable painting records (all of them, or the first `limit`),
    deduplicated, in API order.

    The API's random sort is seeded, so the same seed gives the same order.
    """
    records: list[dict] = []
    seen: set[int] = set()
    want = limit or float("inf")
    page = 1
    while len(records) < want and page <= max_pages:
        params = {
            "apikey": api_key,
            "classification": "Paintings",
            "hasimage": 1,
            "q": "imagepermissionlevel:0",
            "sort": f"random:{seed}",
            "size": PAGE_SIZE,
            "page": page,
            "fields": ",".join(FIELDS),
        }
        url = f"{API}?{urllib.parse.urlencode(params)}"
        data = json.loads(http_get(url))
        batch = data.get("records") or []
        if not batch:
            break
        for record in batch:
            rid = record.get("id")
            if not isinstance(rid, int) or rid in seen:
                continue
            if not record.get("primaryimageurl") and not record.get("images"):
                continue
            if record.get("imagepermissionlevel", 0) != 0:
                continue
            seen.add(rid)
            records.append(record)
        pages = (data.get("info") or {}).get("pages")
        log(f"  page {page}{'/' + str(pages) if pages else ''}: {len(records)} usable records")
        if pages and page >= pages:
            break
        page += 1
    return records[:limit] if limit else records


# --------------------------------------------------------------------------
# 2-3. Download and downsample
# --------------------------------------------------------------------------


# First example of each kind of failure ("host: reason" -> URL and server
# response), printed when downloads fail so refusals can be diagnosed.
FIRST_FAILURES: dict[str, str] = {}


def load_image(record: dict, cache_dir: Path | None, px: int) -> tuple[Image.Image | None, str]:
    """(image, "") on success, (None, reason) if no candidate URL worked.
    The reason lists each URL's failure, e.g. "ids.lib.harvard.edu: HTTP 403"."""
    path = cache_dir / f"{record['id']}.jpg" if cache_dir else None
    if path and path.exists():
        try:
            return Image.open(path).convert("RGB"), ""
        except OSError:
            path.unlink(missing_ok=True)
    reasons = []
    for url in small_image_urls(record, px):
        host = urllib.parse.urlsplit(url).hostname or "?"
        try:
            data = http_get(url, timeout=20, retries=2)
        except FetchError as e:
            key = f"{host}: {e.reason}"
            FIRST_FAILURES.setdefault(key, f"{url} {e.detail}".strip())
            reasons.append(key)
            continue
        try:
            image = Image.open(io.BytesIO(data))
            image.load()
        except OSError:
            key = f"{host}: not an image"
            FIRST_FAILURES.setdefault(key, url)
            reasons.append(key)
            continue
        if path:
            path.write_bytes(data)
        return image.convert("RGB"), ""
    return None, " + ".join(reasons) or "no image URL"


def failure_examples(reasons: Counter) -> str:
    """One example URL and server response per failure kind, for the log."""
    kinds = {k for r in reasons for k in r.split(" + ")}
    return "".join(f"\n    e.g. {k}: {FIRST_FAILURES[k]}" for k in sorted(kinds) if k in FIRST_FAILURES)


def download_images(
    records: list[dict],
    need: int,
    cache_dir: Path | None,
    px: int,
    workers: int,
    budget_s: float,
) -> list[tuple[dict, Image.Image]]:
    """Downloads images in parallel until `need` succeed, the records run out,
    or `budget_s` seconds pass. Prints progress, and gives up early if the
    first images all fail (the reasons are printed). Keeps API order."""
    start = time.monotonic()
    results: dict[int, Image.Image] = {}
    failures: Counter[str] = Counter()
    pending = iter(enumerate(records))
    done = 0
    out_of_time = False

    def top_reasons() -> str:
        return ", ".join(f"{r} ({n})" for r, n in failures.most_common(3)) or "none"

    with ThreadPoolExecutor(max_workers=workers) as pool:
        running = {}

        def submit_next() -> None:
            nxt = next(pending, None)
            if nxt is not None:
                i, record = nxt
                running[pool.submit(load_image, record, cache_dir, px)] = i

        for _ in range(workers * 2):
            submit_next()
        while running:
            finished, _ = wait(running, timeout=30, return_when=FIRST_COMPLETED)
            elapsed = time.monotonic() - start
            if not finished:
                log(f"  still downloading... {len(results)} ok, {sum(failures.values())} failed, {elapsed:.0f}s")
            for future in finished:
                i = running.pop(future)
                image, reason = future.result()
                done += 1
                if image is not None:
                    results[i] = image
                else:
                    failures[reason] += 1
                if done % 100 == 0:
                    log(f"  {done} tried: {len(results)} ok, {sum(failures.values())} failed, {elapsed:.0f}s")
                if done >= 50 and not results:
                    raise RuntimeError(
                        f"the first {done} images all failed to download: {top_reasons()}"
                        + failure_examples(failures)
                    )
                if len(results) + len(running) < need and elapsed < budget_s:
                    submit_next()
            if elapsed >= budget_s and running and not out_of_time:
                out_of_time = True
                log(f"  download time budget ({budget_s:.0f}s) used up; finishing the {len(running)} in flight")

    elapsed = time.monotonic() - start
    log(f"  {len(results)} images ready, {sum(failures.values())} failed ({top_reasons()}), {elapsed:.0f}s"
        + (failure_examples(failures) if failures else ""))
    return [(records[i], results[i]) for i in sorted(results)][:need]


def downsample(image: Image.Image, size: int) -> np.ndarray:
    """size x size x 3 uint8 RGB, each cell the average of its region.

    The whole picture is squeezed into the square (nothing is cropped), so
    portrait and landscape works both keep all of their composition.
    """
    return np.asarray(image.resize((size, size), Image.Resampling.BOX), dtype=np.uint8)


# --------------------------------------------------------------------------
# 4. Color: sRGB <-> CIE Lab (D65) and k-means
# --------------------------------------------------------------------------

_M = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]
)
_WHITE = np.array([0.95047, 1.0, 1.08883])
_EPS = (6 / 29) ** 3


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """(..., 3) uint8 or 0-255 floats -> (..., 3) Lab."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = (lin @ _M.T) / _WHITE
    f = np.where(xyz > _EPS, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    """(..., 3) Lab -> (..., 3) uint8 sRGB (out-of-gamut colors are clipped)."""
    lab = np.asarray(lab, dtype=np.float64)
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], axis=-1)
    xyz = np.where(f > 6 / 29, f**3, 3 * (6 / 29) ** 2 * (f - 4 / 29)) * _WHITE
    lin = np.clip(xyz @ np.linalg.inv(_M).T, 0, 1)
    c = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin ** (1 / 2.4) - 0.055)
    return np.clip(np.round(c * 255), 0, 255).astype(np.uint8)


def _sq_dists(X: np.ndarray, C: np.ndarray) -> np.ndarray:
    return (X * X).sum(1)[:, None] - 2 * X @ C.T + (C * C).sum(1)[None, :]


def kmeans(X: np.ndarray, k: int, seed: int = 0, n_init: int = 4, max_iter: int = 100):
    """Plain k-means with k-means++ init. Returns (centroids, labels, inertia)."""
    rng = np.random.default_rng(seed)
    n = len(X)
    if n < k:
        raise ValueError(f"need at least {k} pixels, got {n}")
    best = None
    for _ in range(n_init):
        # k-means++ initialization
        C = np.empty((k, X.shape[1]))
        C[0] = X[rng.integers(n)]
        closest = _sq_dists(X, C[:1]).ravel()
        for j in range(1, k):
            probs = np.clip(closest, 0, None)
            total = probs.sum()
            idx = rng.choice(n, p=probs / total) if total > 0 else rng.integers(n)
            C[j] = X[idx]
            closest = np.minimum(closest, _sq_dists(X, C[j : j + 1]).ravel())
        # Lloyd iterations
        for _ in range(max_iter):
            d = _sq_dists(X, C)
            labels = d.argmin(1)
            counts = np.bincount(labels, minlength=k)
            sums = np.stack(
                [np.bincount(labels, weights=X[:, c], minlength=k) for c in range(X.shape[1])], 1
            )
            newC = sums / np.maximum(counts, 1)[:, None]
            for j in np.flatnonzero(counts == 0):  # empty cluster: restart on the worst-fit point
                newC[j] = X[d.min(1).argmax()]
            shift = np.abs(newC - C).max()
            C = newC
            if shift < 1e-4:
                break
        d = _sq_dists(X, C)
        labels = d.argmin(1)
        inertia = float(np.clip(d[np.arange(n), labels], 0, None).sum())
        if best is None or inertia < best[2]:
            best = (C, labels, inertia)
    return best


def nearest(lab_pixels: np.ndarray, palette_lab: np.ndarray) -> np.ndarray:
    """Index of the nearest palette color for each Lab pixel."""
    return _sq_dists(lab_pixels.reshape(-1, 3), palette_lab).argmin(1)


def to_hex(rgb: np.ndarray) -> str:
    return "#{:02x}{:02x}{:02x}".format(*(int(v) for v in rgb))


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


@dataclass
class Rules:
    """When is a painting still legible as a small grid?"""

    max_dominant: float = 0.5  # no palette color covers more than this share of cells
    min_colors: int = 5  # at least this many palette colors appear
    min_contrast: float = 10.0  # std of L* (lightness, 0-100) across cells
    max_aspect: float = 1.5  # long side at most this many times the short side

    def shape_ok(self, aspect: float) -> bool:
        return 1 / self.max_aspect <= aspect <= self.max_aspect


def fit_palette(lab: np.ndarray, n_colors: int, seed: int, max_pixels: int = 300_000):
    """k-means palette for (n, 3) Lab pixels, most common color first.
    Returns (centroids, share of pixels nearest each centroid)."""
    sample = lab
    if len(lab) > max_pixels:
        sample = lab[np.random.default_rng(seed).choice(len(lab), max_pixels, replace=False)]
    centroids, _, _ = kmeans(sample, n_colors, seed=seed)
    counts = np.bincount(nearest(lab, centroids), minlength=n_colors)
    order = np.argsort(-counts, kind="stable")
    return centroids[order], counts[order] / counts.sum()


def legibility(lab_grid: np.ndarray, idx: np.ndarray, n_colors: int) -> tuple[float, int, float]:
    """(dominant color share, number of colors used, L* contrast) for one
    painting: its Lab cells and their palette indices."""
    counts = np.bincount(idx, minlength=n_colors)
    return float(counts.max() / len(idx)), int((counts > 0).sum()), float(lab_grid[:, 0].std())


def select_works(lab_grids: list[np.ndarray], aspects: list[float], count: int,
                 n_colors: int, seed: int, rules: Rules, max_rounds: int = 4):
    """Chooses the first `count` legible paintings (list order) and a palette
    fitted to them. Legibility depends on the palette and the palette on the
    selection, so this alternates until the selection stops changing.

    Returns (selected indices, centroids, share, per-work stats, per-work pass flags).
    """
    n = len(lab_grids)
    candidates = [i for i in range(n) if rules.shape_ok(aspects[i])]
    selected = candidates
    stable = False
    for round_ in range(1, max_rounds + 1):
        pixels = np.concatenate([lab_grids[i] for i in selected]) if selected else np.zeros((0, 3))
        if len(pixels) < n_colors:
            raise ValueError("too few paintings to fit a palette; loosen the legibility rules")
        log(f"  round {round_}: fitting the palette to {len(selected)} paintings ({len(pixels):,} pixels)...")
        centroids, share = fit_palette(pixels, n_colors, seed)
        stats = [legibility(g, nearest(g, centroids), n_colors) for g in lab_grids]
        passes = [
            rules.shape_ok(aspects[i])
            and stats[i][0] <= rules.max_dominant
            and stats[i][1] >= rules.min_colors
            and stats[i][2] >= rules.min_contrast
            for i in range(n)
        ]
        new = [i for i in range(n) if passes[i]][:count]
        log(f"           {sum(passes)} legible, keeping {len(new)}")
        if new == selected:
            stable = True
            break
        selected = new
    if not stable:
        # Refit to the final selection; a few marginal works may now sit just
        # outside the rules, which is reported below.
        centroids, share = fit_palette(np.concatenate([lab_grids[i] for i in selected]), n_colors, seed)
        stats = [legibility(g, nearest(g, centroids), n_colors) for g in lab_grids]
        off = sum(1 for i in selected if stats[i][0] > rules.max_dominant or stats[i][1] < rules.min_colors)
        log(f"  selection still shifting after {max_rounds} rounds; {off} kept works are now marginal")
    return selected, centroids, share, stats, passes


def selection_report(records: list[dict], aspects: list[float], stats, passes, selected,
                     rules: Rules, top: int = 12) -> dict:
    """What the legibility filter did, overall and by culture."""
    n = len(records)
    failed = {
        "shape": sum(not rules.shape_ok(a) for a in aspects),
        "oneColor": sum(s[0] > rules.max_dominant for s in stats),
        "fewColors": sum(s[1] < rules.min_colors for s in stats),
        "lowContrast": sum(s[2] < rules.min_contrast for s in stats),
    }
    culture = [clean(r.get("culture")) or "Unknown" for r in records]
    pool_c = Counter(culture)
    legible_c = Counter(c for c, ok in zip(culture, passes) if ok)
    kept_c = Counter(culture[i] for i in selected)
    names = [c for c, _ in pool_c.most_common(top)]
    rows = [{"culture": c, "pool": pool_c[c], "legible": legible_c[c], "kept": kept_c[c]} for c in names]
    rest = [c for c in pool_c if c not in names]
    if rest:
        rows.append({
            "culture": "Other",
            "pool": sum(pool_c[c] for c in rest),
            "legible": sum(legible_c[c] for c in rest),
            "kept": sum(kept_c[c] for c in rest),
        })
    return {
        "rules": {"maxDominant": rules.max_dominant, "minColors": rules.min_colors,
                  "minContrast": rules.min_contrast, "maxAspect": rules.max_aspect},
        "pool": n,
        "legible": int(sum(passes)),
        "kept": len(selected),
        "failed": failed,
        "cultures": rows,
    }


def build(
    records: list[dict],
    images: list[Image.Image],
    sizes: list[int],
    n_colors: int,
    seed: int,
    count: int | None = None,
    rules: Rules | None = None,
) -> dict[int, dict]:
    """Selects legible paintings, fits the palette and makes grids for each
    size. `records` and `images` are parallel lists, in API order."""
    rules = rules or Rules()
    count = count or len(records)
    largest = max(sizes)
    aspects = [im.width / im.height for im in images]
    lab_grids = [srgb_to_lab(downsample(im, largest)).reshape(-1, 3) for im in images]

    log(f"Choosing up to {count} legible paintings and a {n_colors}-color palette (k-means in Lab)...")
    selected, centroids, share, stats, passes = select_works(
        lab_grids, aspects, count, n_colors, seed, rules)
    report = selection_report(records, aspects, stats, passes, selected, rules)
    hexes = [to_hex(c) for c in lab_to_srgb(centroids)]

    outputs = {}
    for size in sizes:
        works = []
        for i in selected:
            lab = lab_grids[i] if size == largest else srgb_to_lab(downsample(images[i], size)).reshape(-1, 3)
            record = records[i]
            works.append(
                {
                    "id": record["id"],
                    "title": clean(record.get("title")) or "Untitled",
                    "artist": artist_of(record),
                    "culture": clean(record.get("culture")),
                    "dated": clean(record.get("dated")),
                    "aspect": round(aspects[i], 3),
                    "grid": [int(v) for v in nearest(lab, centroids)],
                }
            )
        outputs[size] = {
            "version": 2,
            "size": size,
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "Harvard Art Museums API (classification=Paintings, hasimage=1)",
            "seed": seed,
            "palette": hexes,
            "paletteLab": [[round(float(v), 3) for v in c] for c in centroids],
            "paletteShare": [round(float(v), 5) for v in share],
            "selection": report,
            "works": works,
        }
    return outputs


def output_path(out_dir: Path, size: int) -> Path:
    return out_dir / ("grids.json" if size == 16 else f"grids-{size}.json")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--size", type=int, nargs="+", default=[16], choices=[4, 8, 16, 32],
                   help="grid size(s); 16 -> grids.json, others -> grids-N.json (default: 16)")
    p.add_argument("--count", type=int, default=1000, help="number of paintings to keep (default: 1000)")
    p.add_argument("--pool", type=int, default=0,
                   help="how many paintings to consider before filtering (default: 0 = all)")
    p.add_argument("--max-dominant", type=float, default=Rules.max_dominant,
                   help="max share of cells one color may cover (default: 0.5)")
    p.add_argument("--min-colors", type=int, default=Rules.min_colors,
                   help="min number of palette colors used (default: 5)")
    p.add_argument("--min-contrast", type=float, default=Rules.min_contrast,
                   help="min std of lightness L* across cells (default: 10)")
    p.add_argument("--max-aspect", type=float, default=Rules.max_aspect,
                   help="max long side / short side (default: 1.5)")
    p.add_argument("--colors", type=int, default=10, help="palette size (default: 10)")
    p.add_argument("--seed", type=int, default=1874, help="seed for the API's random sample and k-means")
    p.add_argument("--image-px", type=int, default=128, help="size of the downloaded images (default: 128)")
    p.add_argument("--workers", type=int, default=16, help="parallel image downloads (default: 16)")
    p.add_argument("--download-budget", type=float, default=1800,
                   help="stop starting new image downloads after this many seconds (default: 1800)")
    p.add_argument("--out-dir", type=Path, default=ROOT / "public")
    p.add_argument("--cache-dir", default=str(ROOT / ".cache" / "images"),
                   help="where downloaded images are kept between runs ('' to disable)")
    args = p.parse_args(argv)

    sizes = sorted(set(args.size), reverse=True)
    api_key = read_api_key()
    if not api_key:
        log("HARVARD_API_KEY is not set. Put it in .env (see .env.example) or the environment.")
        return 2

    cache_dir = Path(args.cache_dir) if args.cache_dir.strip() else None
    if cache_dir:
        cache_dir.mkdir(parents=True, exist_ok=True)

    rules = Rules(args.max_dominant, args.min_colors, args.min_contrast, args.max_aspect)
    log(f"Fetching {'up to ' + str(args.pool) if args.pool else 'all'} paintings from the Harvard Art Museums API...")
    try:
        records = fetch_records(api_key, args.pool or None, args.seed)
    except (RuntimeError, ValueError) as e:
        log(f"Could not fetch records: {redact(e)}")
        return 1
    if not records:
        log("The API returned no usable records.")
        return 1

    log(f"Downloading small images ({args.image_px}px) for {len(records)} records...")
    try:
        kept = download_images(records, len(records), cache_dir, args.image_px,
                               args.workers, args.download_budget)
    except RuntimeError as e:
        log(f"Could not download images: {e}")
        return 1
    kept_records = [r for r, _ in kept]
    kept_images = [im for _, im in kept]
    if len(kept_records) < args.colors:
        log(f"Only {len(kept_records)} images downloaded; too few to build a palette.")
        return 1

    try:
        outputs = build(kept_records, kept_images, sizes, args.colors, args.seed, args.count, rules)
    except ValueError as e:
        log(f"Could not build the grids: {e}")
        return 1
    first = outputs[sizes[0]]
    n_kept = len(first["works"])
    if n_kept < min(100, args.count):
        log(f"Only {n_kept} paintings passed the legibility rules; loosen them (see --help).")
        return 1

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for size, data in outputs.items():
        path = output_path(args.out_dir, size)
        path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
        log(f"Wrote {path} ({len(data['works'])} works, {path.stat().st_size / 1024:.0f} KB)")

    sel = first["selection"]
    log(f"Selection: {sel['pool']} paintings -> {sel['legible']} legible -> kept {sel['kept']}"
        + (f" (fewer than the {args.count} asked for)" if n_kept < args.count else ""))
    log("  failed (a painting can fail several): " + ", ".join(f"{k} {v}" for k, v in sel["failed"].items()))
    log("  by culture (pool -> legible -> kept): " + "; ".join(
        f"{r['culture']} {r['pool']}->{r['legible']}->{r['kept']}" for r in sel["cultures"]))
    log("Palette (most common first): " + ", ".join(
        f"{h} {s:.0%}" for h, s in zip(first["palette"], first["paletteShare"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
