import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import handler, { toArtwork } from "../api/object.js";

const KEY = "secret-key-123";
let realFetch;
let calls;

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(b) {
      this.body = b;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

async function call(url, { method = "GET" } = {}) {
  const res = fakeRes();
  await handler({ method, url }, res);
  return res;
}

const RECORD = {
  id: 299843,
  title: "  Self-Portrait  Dedicated to Paul Gauguin ",
  people: [
    { name: "Unknown Workshop", role: "Workshop" },
    { name: "Vincent van Gogh", role: "Artist" },
  ],
  culture: "Dutch",
  dated: "1888",
  medium: "Oil on canvas",
  dimensions: "61.5 x 50.3 cm",
  classification: "Paintings",
  creditline: "Bequest of Collection of Maurice Wertheim",
  url: "https://www.harvardartmuseums.org/collections/object/299843",
  imagepermissionlevel: 0,
  images: [{ iiifbaseuri: "https://ids.lib.harvard.edu/ids/iiif/47174896/", width: 2400, height: 3000, alttext: "A man" }],
};

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  process.env.HARVARD_API_KEY = KEY;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.HARVARD_API_KEY;
});

function upstream(status, body) {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}

test("returns public details and a IIIF image URL", async () => {
  upstream(200, RECORD);
  const res = await call("/api/object?id=299843");
  assert.equal(res.statusCode, 200);
  const a = res.json();
  assert.equal(a.title, "Self-Portrait Dedicated to Paul Gauguin");
  assert.equal(a.artist, "Vincent van Gogh");
  assert.equal(a.culture, "Dutch");
  assert.equal(a.dated, "1888");
  assert.equal(a.image.url, "https://ids.lib.harvard.edu/ids/iiif/47174896/full/!1600,1600/0/default.jpg");
  assert.equal(a.image.fullUrl, "https://ids.lib.harvard.edu/ids/iiif/47174896/full/full/0/default.jpg");
  assert.equal(a.image.alt, "A man");
  assert.match(res.headers["cache-control"], /s-maxage/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api\.harvardartmuseums\.org\/object\/299843\?apikey=secret-key-123$/);
  assert.ok(!res.body.includes(KEY), "the key never reaches the browser");
});

test("respects image permission levels", () => {
  assert.match(toArtwork({ ...RECORD, imagepermissionlevel: 1 }).image.url, /!256,256/);
  assert.equal(toArtwork({ ...RECORD, imagepermissionlevel: 1 }).image.fullUrl, null);
  assert.equal(toArtwork({ ...RECORD, imagepermissionlevel: 2 }).image, null);
  const nrs = toArtwork({ id: 1, primaryimageurl: "https://nrs.harvard.edu/urn-3:HUAM:1", images: [] });
  assert.equal(nrs.image.url, "https://nrs.harvard.edu/urn-3:HUAM:1?width=1600&height=1600");
  assert.equal(toArtwork({ id: 2 }).image, null);
  assert.equal(toArtwork({ id: 2 }).title, "Untitled");
  assert.equal(toArtwork({ id: 2 }).url, "https://harvardartmuseums.org/collections/object/2");
});

test("rejects bad ids and methods without calling the API", async () => {
  upstream(200, RECORD);
  for (const q of ["", "?id=", "?id=abc", "?id=1;drop", "?id=12345678901", "?id=-4"]) {
    const res = await call(`/api/object${q}`);
    assert.equal(res.statusCode, 400, q);
  }
  const post = await call("/api/object?id=1", { method: "POST" });
  assert.equal(post.statusCode, 405);
  assert.equal(calls.length, 0);
});

test("explains a missing key without leaking anything", async () => {
  delete process.env.HARVARD_API_KEY;
  upstream(200, RECORD);
  const res = await call("/api/object?id=1");
  assert.equal(res.statusCode, 500);
  assert.match(res.json().error, /no Harvard Art Museums API key/);
  assert.equal(calls.length, 0);
});

test("maps upstream failures to clear errors", async () => {
  const cases = [
    [404, { error: "not found" }, 404, /no object with id 7/],
    [401, { error: "bad key" }, 502, /didn't accept/],
    [429, {}, 503, /rate limit/],
    [500, "oops", 502, /HTTP 500/],
    [200, "<html>not json</html>", 502, /isn't JSON/],
    [200, {}, 404, /no object/],
  ];
  for (const [status, body, expected, message] of cases) {
    upstream(status, body);
    const res = await call("/api/object?id=7");
    assert.equal(res.statusCode, expected, `upstream ${status}`);
    assert.match(res.json().error, message);
    assert.ok(!res.body.includes(KEY));
  }
  globalThis.fetch = async () => {
    throw new TypeError("network down");
  };
  const res = await call("/api/object?id=7");
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /Couldn't reach/);
});
