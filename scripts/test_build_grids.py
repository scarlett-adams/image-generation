"""Tests for build_grids.py. Run: python -m unittest discover scripts

They use synthetic images and a fake API, so they need no network or key.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_grids as bg  # noqa: E402


def solid(rgb, w=40, h=30):
    return Image.new("RGB", (w, h), rgb)


def split(left, right, w=40, h=40):
    im = Image.new("RGB", (w, h), left)
    im.paste(Image.new("RGB", (w // 2, h), right), (w // 2, 0))
    return im


class ColorTests(unittest.TestCase):
    def test_lab_reference_values(self):
        white = bg.srgb_to_lab(np.array([255, 255, 255]))
        np.testing.assert_allclose(white, [100, 0, 0], atol=0.01)
        red = bg.srgb_to_lab(np.array([255, 0, 0]))
        np.testing.assert_allclose(red, [53.24, 80.09, 67.20], atol=0.05)
        black = bg.srgb_to_lab(np.array([0, 0, 0]))
        np.testing.assert_allclose(black, [0, 0, 0], atol=0.01)

    def test_lab_round_trip(self):
        rng = np.random.default_rng(1)
        rgb = rng.integers(0, 256, size=(500, 3))
        back = bg.lab_to_srgb(bg.srgb_to_lab(rgb))
        self.assertLessEqual(np.abs(back.astype(int) - rgb).max(), 1)

    def test_hex(self):
        self.assertEqual(bg.to_hex(np.array([255, 16, 0])), "#ff1000")


class KMeansTests(unittest.TestCase):
    def test_recovers_obvious_clusters(self):
        rng = np.random.default_rng(0)
        centers = np.array([[10, 0, 0], [50, 40, -20], [90, -30, 30]], dtype=float)
        X = np.concatenate([c + rng.normal(0, 1, size=(300, 3)) for c in centers])
        C, labels, inertia = bg.kmeans(X, 3, seed=0)
        found = sorted(C.tolist())
        np.testing.assert_allclose(found, sorted(centers.tolist()), atol=0.5)
        self.assertEqual(len(set(labels.tolist())), 3)
        self.assertGreater(inertia, 0)

    def test_deterministic(self):
        rng = np.random.default_rng(3)
        X = rng.normal(size=(400, 3)) * 30
        a = bg.kmeans(X, 5, seed=7)[0]
        b = bg.kmeans(X, 5, seed=7)[0]
        np.testing.assert_array_equal(a, b)


def patchwork(colors, w=60, h=60, cols=3):
    """A grid of colored blocks, cycling through `colors`."""
    im = Image.new("RGB", (w, h))
    rows = cols
    for r in range(rows):
        for c in range(cols):
            block = Image.new("RGB", (w // cols + 1, h // rows + 1), colors[(r * cols + c) % len(colors)])
            im.paste(block, (c * w // cols, r * h // rows))
    return im


NO_FILTER = bg.Rules(max_dominant=1, min_colors=1, min_contrast=0, max_aspect=99)
BOLD = [(0, 0, 0), (255, 255, 255), (200, 30, 30), (30, 60, 200), (240, 210, 40), (40, 150, 60)]


class BuildTests(unittest.TestCase):
    def make(self):
        colors = [(120, 80, 40), (230, 220, 200), (20, 30, 60), (180, 40, 30)]
        images = [solid(c) for c in colors] + [split(colors[0], colors[1]), split(colors[2], colors[3])]
        records = [
            {"id": 100 + i, "title": f" Work  {i} ", "people": [{"role": "Artist", "name": "A. Painter"}],
             "culture": "Dutch", "dated": "1650"}
            for i in range(len(images))
        ]
        return records, images

    def test_build_shapes_and_palette(self):
        records, images = self.make()
        out = bg.build(records, images, [16, 8], n_colors=4, seed=0, rules=NO_FILTER)
        for size in (16, 8):
            data = out[size]
            self.assertEqual(len(data["works"]), 6)
            self.assertEqual(len(data["palette"]), 4)
            self.assertEqual(len(data["paletteLab"]), 4)
            self.assertAlmostEqual(sum(data["paletteShare"]), 1, places=3)
            self.assertEqual(data["paletteShare"], sorted(data["paletteShare"], reverse=True))
            self.assertEqual(data["palette"], out[16]["palette"])  # one shared palette
            for work in data["works"]:
                self.assertEqual(len(work["grid"]), size * size)
                self.assertTrue(all(0 <= i < 4 for i in work["grid"]))
        w = out[16]["works"][0]
        self.assertEqual((w["title"], w["artist"], w["culture"], w["dated"], w["aspect"]),
                         ("Work 0", "A. Painter", "Dutch", "1650", round(40 / 30, 3)))
        # A solid image maps to a single palette color.
        self.assertEqual(len(set(out[16]["works"][0]["grid"])), 1)
        # A split image keeps its left/right halves.
        g = np.array(out[16]["works"][4]["grid"]).reshape(16, 16)
        self.assertEqual(len(set(g[:, :8].ravel())), 1)
        self.assertEqual(len(set(g[:, 8:].ravel())), 1)
        self.assertNotEqual(g[0, 0], g[0, 15])
        json.dumps(out)  # serializable

    def test_legibility_filter(self):
        greys = [(120, 120, 120), (126, 118, 114), (116, 122, 128)]
        images = [
            patchwork(BOLD),                      # 0 legible
            solid((140, 110, 70)),                # 1 one flat color
            patchwork(BOLD, w=40, h=120),         # 2 tall scroll shape (1:3)
            patchwork(greys),                     # 3 low contrast
            split((0, 0, 0), (255, 255, 255)),    # 4 only two colors
            patchwork(BOLD[::-1]),                # 5 legible
            patchwork(BOLD[1:] + BOLD[:1]),       # 6 legible
            patchwork(BOLD, w=70, h=60),          # 7 legible, mildly wide
        ]
        records = [{"id": i, "title": f"W{i}", "culture": ["Dutch", "Chinese"][i % 2]} for i in range(len(images))]
        rules = bg.Rules(max_dominant=0.5, min_colors=4, min_contrast=10, max_aspect=1.5)
        with mock.patch.object(bg, "log"):
            out = bg.build(records, images, [16], n_colors=6, seed=0, count=3, rules=rules)[16]
        self.assertEqual([w["id"] for w in out["works"]], [0, 5, 6])  # first 3 legible, API order
        sel = out["selection"]
        self.assertEqual((sel["pool"], sel["legible"], sel["kept"]), (8, 4, 3))
        self.assertEqual(sel["failed"]["shape"], 1)
        self.assertGreaterEqual(sel["failed"]["oneColor"], 1)
        self.assertGreaterEqual(sel["failed"]["fewColors"], 2)
        self.assertGreaterEqual(sel["failed"]["lowContrast"], 2)
        self.assertEqual(sel["rules"], {"maxDominant": 0.5, "minColors": 4, "minContrast": 10, "maxAspect": 1.5})
        by = {r["culture"]: r for r in sel["cultures"]}
        self.assertEqual(by["Dutch"], {"culture": "Dutch", "pool": 4, "legible": 2, "kept": 2})
        self.assertEqual(by["Chinese"], {"culture": "Chinese", "pool": 4, "legible": 2, "kept": 1})
        for w in out["works"]:
            counts = np.bincount(w["grid"], minlength=6)
            self.assertLessEqual(counts.max() / 256, 0.5)
            self.assertGreaterEqual((counts > 0).sum(), 4)

    def test_too_strict_rules_raise(self):
        images = [solid((100, 100, 100)), solid((10, 10, 10))]
        records = [{"id": i} for i in range(2)]
        with mock.patch.object(bg, "log"), self.assertRaises(ValueError):
            bg.build(records, images, [16], n_colors=4, seed=0,
                     rules=bg.Rules(max_dominant=0.5, min_colors=4, min_contrast=10, max_aspect=0.5))

    def test_downsample_squeezes_whole_image(self):
        im = split((0, 0, 0), (255, 255, 255), w=200, h=50)
        g = bg.downsample(im, 8)
        self.assertEqual(g.shape, (8, 8, 3))
        self.assertTrue((g[:, :4] == 0).all() and (g[:, 4:] == 255).all())


class ApiTests(unittest.TestCase):
    def fake_api(self, pages):
        calls = []

        def get(url, **kw):
            calls.append(url)
            page = int(dict(p.split("=", 1) for p in url.split("?", 1)[1].split("&"))["page"])
            records = pages[page - 1] if page <= len(pages) else []
            return json.dumps({"info": {"pages": len(pages)}, "records": records}).encode()

        return get, calls

    def test_fetch_paginates_dedupes_and_filters(self):
        pages = [
            [{"id": 1, "primaryimageurl": "u"}, {"id": 2, "images": [{"iiifbaseuri": "b"}]},
             {"id": 3}, {"id": 4, "primaryimageurl": "u", "imagepermissionlevel": 1}],
            [{"id": 2, "primaryimageurl": "u"}, {"id": 5, "primaryimageurl": "u"}],
        ]
        get, calls = self.fake_api(pages)
        with mock.patch.object(bg, "http_get", get), mock.patch.object(bg, "log"):
            records = bg.fetch_records("SECRET", limit=None, seed=1)
        self.assertEqual([r["id"] for r in records], [1, 2, 5])
        self.assertEqual(len(calls), 2)
        self.assertIn("classification=Paintings", calls[0])
        self.assertIn("hasimage=1", calls[0])
        self.assertIn("sort=random%3A1", calls[0])

    def test_small_image_urls(self):
        r = {"primaryimageurl": "https://nrs.harvard.edu/urn-3:HUAM:123",
             "images": [{"iiifbaseuri": "https://ids.lib.harvard.edu/ids/iiif/42"}]}
        self.assertEqual(bg.small_image_urls(r, 128), [
            "https://ids.lib.harvard.edu/ids/iiif/42/full/!128,128/0/default.jpg",
            "https://nrs.harvard.edu/urn-3:HUAM:123?width=128&height=128",
        ])

    def test_downloads_stop_once_enough_succeed(self):
        records = [{"id": i, "primaryimageurl": f"https://img/{i}"} for i in range(200)]
        fetched = []

        def get(url, **kw):
            fetched.append(url)
            buf = io.BytesIO()
            solid((100, 50, 20)).save(buf, "JPEG")
            return buf.getvalue()

        with mock.patch.object(bg, "http_get", get), mock.patch.object(bg, "log"):
            kept = bg.download_images(records, need=20, cache_dir=None, px=64, workers=4, budget_s=60)
        self.assertEqual([r["id"] for r, _ in kept], list(range(20)))  # API order kept
        self.assertLess(len(fetched), 40)  # didn't download all 200

    def test_downloads_fail_fast_with_reasons(self):
        records = [{"id": i, "primaryimageurl": f"https://img/{i}"} for i in range(500)]

        def get(url, **kw):
            raise bg.FetchError(url, "HTTP 403")

        with mock.patch.object(bg, "http_get", get), mock.patch.object(bg, "log"):
            with self.assertRaisesRegex(RuntimeError, r"all failed.*HTTP 403"):
                bg.download_images(records, need=400, cache_dir=None, px=64, workers=4, budget_s=60)

    def test_failed_downloads_are_replaced_by_spares(self):
        records = [{"id": i, "primaryimageurl": f"https://img/{i}"} for i in range(30)]

        def get(url, **kw):
            if int(url.split("/")[3].split("?")[0]) % 3 == 0:
                raise bg.FetchError(url, "timed out")
            buf = io.BytesIO()
            solid((10, 20, 30)).save(buf, "JPEG")
            return buf.getvalue()

        logs = []
        with mock.patch.object(bg, "http_get", get), mock.patch.object(bg, "log", lambda *a: logs.append(a)):
            kept = bg.download_images(records, need=15, cache_dir=None, px=64, workers=3, budget_s=60)
        self.assertEqual(len(kept), 15)
        self.assertTrue(all(r["id"] % 3 for r, _ in kept))
        self.assertIn("timed out", " ".join(map(str, logs[-1])))

    def test_refusal_details_come_from_the_real_http_response(self):
        import http.server
        import threading

        class Refuse(http.server.BaseHTTPRequestHandler):
            server_version = "cloudflare"
            sys_version = ""

            def do_GET(self):
                body = b"<html><head><style>x{}</style></head><body><h1>Access denied</h1> bots go away</body></html>"
                self.send_response(403)
                self.send_header("cf-mitigated", "challenge")
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Refuse)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/iiif/1/full/!128,128/0/default.jpg?apikey=SECRET"
            with self.assertRaises(bg.FetchError) as caught:
                bg.http_get(url, timeout=5, retries=1)
            e = caught.exception
            self.assertEqual(e.reason, "HTTP 403")
            self.assertIn("server=cloudflare", e.detail)
            self.assertIn("cf-mitigated=challenge", e.detail)
            self.assertIn('body="Access denied bots go away"', e.detail)
            self.assertNotIn("SECRET", str(e))

            bg.FIRST_FAILURES.clear()
            image, reason = bg.load_image({"id": 1, "primaryimageurl": url}, None, 64)
            self.assertIsNone(image)
            self.assertEqual(reason, "127.0.0.1: HTTP 403")
            examples = bg.failure_examples(Counter({reason: 3}))
            self.assertIn("cf-mitigated=challenge", examples)
        finally:
            server.shutdown()

    def test_redact(self):
        self.assertEqual(bg.redact("GET https://x/object?apikey=abc-123&page=2 failed"),
                         "GET https://x/object?apikey=REDACTED&page=2 failed")

    def test_missing_key(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.dict(os.environ, {"HARVARD_API_KEY": ""}), \
                mock.patch.object(bg, "ROOT", Path(d)), mock.patch.object(bg, "log"):
            self.assertEqual(bg.main(["--out-dir", d]), 2)

    def test_key_from_dotenv(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.dict(os.environ, {"HARVARD_API_KEY": ""}), \
                mock.patch.object(bg, "ROOT", Path(d)):
            Path(d, ".env").write_text("# comment\nHARVARD_API_KEY='abc-123'\n")
            self.assertEqual(bg.read_api_key(), "abc-123")

    def test_end_to_end_with_fake_api(self):
        pages = [[{"id": i, "title": f"T{i}", "primaryimageurl": f"https://img/{i}",
                   "people": [{"role": "Artist", "name": "P"}]} for i in range(p * 10, p * 10 + 10)]
                 for p in range(2)]
        get_api, _ = self.fake_api(pages)

        def get(url, **kw):
            if url.startswith("https://img/"):
                i = int(url.split("/")[3].split("?")[0])
                # every third painting is a flat color the filter should drop
                im = solid(BOLD[i % 6]) if i % 3 == 0 else patchwork(BOLD[i % 6:] + BOLD[:i % 6])
                buf = io.BytesIO()
                im.save(buf, "JPEG")
                return buf.getvalue()
            return get_api(url, **kw)

        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as cwd, \
                mock.patch.dict(os.environ, {"HARVARD_API_KEY": "k"}), \
                mock.patch.object(bg, "http_get", get), mock.patch.object(bg, "log"):
            old_cwd = os.getcwd()
            os.chdir(cwd)
            try:
                code = bg.main(["--size", "16", "8", "--count", "10", "--colors", "6", "--min-colors", "4",
                                "--out-dir", d, "--cache-dir", ""])
            finally:
                os.chdir(old_cwd)
            self.assertEqual(os.listdir(cwd), [])  # --cache-dir "" writes no images
            self.assertEqual(code, 0)
            g16 = json.loads(Path(d, "grids.json").read_text())
            g8 = json.loads(Path(d, "grids-8.json").read_text())
            self.assertEqual(len(g16["works"]), 10)
            self.assertTrue(all(w["id"] % 3 for w in g16["works"]))  # flat ones dropped
            self.assertEqual([w["id"] for w in g16["works"]], [w["id"] for w in g8["works"]])
            self.assertEqual(g16["selection"]["pool"], 20)
            self.assertEqual(g16["selection"]["kept"], 10)
            self.assertEqual(g16["palette"], g8["palette"])
            self.assertEqual(len(g8["works"][0]["grid"]), 64)
            self.assertNotIn("apikey", json.dumps(g16))


if __name__ == "__main__":
    unittest.main()
