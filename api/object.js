// GET /api/object?id=299843
//
// A Vercel serverless function: looks up one object in the Harvard Art
// Museums API and returns its public details and an image URL. The API key
// lives only in the HARVARD_API_KEY environment variable on the server; it
// is never sent to the browser or included in any response.

const API = "https://api.harvardartmuseums.org/object/";
const TIMEOUT_MS = 10000;
const CACHE_OK = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

function send(res, status, body, cache = "no-store") {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(body));
}

function clean(value) {
  if (typeof value !== "string") return null;
  const v = value.replace(/\s+/g, " ").trim();
  return v || null;
}

/** The image to show, respecting the museum's image permission level:
 * 0 = any size, 1 = at most 256 px, 2 = don't display. */
function pickImage(o) {
  const level = o.imagepermissionlevel ?? 0;
  if (level >= 2) return null;
  const px = level === 1 ? 256 : 1600;
  const image = (o.images || []).find((im) => im && (im.iiifbaseuri || im.baseimageurl)) || null;
  const alt = clean(image?.alttext) || clean(image?.description) || null;
  if (image?.iiifbaseuri) {
    const base = image.iiifbaseuri.replace(/\/+$/, "");
    return {
      url: `${base}/full/!${px},${px}/0/default.jpg`,
      fullUrl: level === 0 ? `${base}/full/full/0/default.jpg` : null,
      width: image.width || null,
      height: image.height || null,
      alt,
    };
  }
  const primary = o.primaryimageurl || image?.baseimageurl;
  if (!primary) return null;
  const u = new URL(primary);
  u.searchParams.set("width", String(px));
  u.searchParams.set("height", String(px));
  return { url: u.toString(), fullUrl: level === 0 ? primary : null, width: image?.width || null, height: image?.height || null, alt };
}

/** The public fields the page shows, from a Harvard API object record. */
export function toArtwork(o) {
  const people = (o.people || [])
    .filter((p) => p && p.name)
    .map((p) => ({ name: clean(p.name), role: clean(p.role) }));
  const artist = people.find((p) => (p.role || "").toLowerCase() === "artist") || people[0] || null;
  return {
    id: o.id,
    title: clean(o.title) || "Untitled",
    artist: artist ? artist.name : null,
    people,
    culture: clean(o.culture),
    dated: clean(o.dated),
    century: clean(o.century),
    period: clean(o.period),
    medium: clean(o.medium),
    technique: clean(o.technique),
    dimensions: clean(o.dimensions),
    classification: clean(o.classification),
    department: clean(o.department),
    creditline: clean(o.creditline),
    copyright: clean(o.copyright),
    url: o.url || `https://harvardartmuseums.org/collections/object/${o.id}`,
    image: pickImage(o),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return send(res, 405, { error: "Use GET." });
  }
  const id = new URL(req.url, "http://localhost").searchParams.get("id") || "";
  if (!/^\d{1,9}$/.test(id)) {
    return send(res, 400, { error: "Give a numeric object id, like /api/object?id=299843." });
  }
  const key = process.env.HARVARD_API_KEY;
  if (!key) {
    return send(res, 500, { error: "The server has no Harvard Art Museums API key configured." });
  }

  let upstream;
  try {
    upstream = await fetch(`${API}${id}?apikey=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch {
    return send(res, 502, { error: "Couldn't reach the Harvard Art Museums API. Try again in a moment." });
  }

  if (upstream.status === 404) {
    return send(res, 404, { error: `The museum has no object with id ${id}.` }, "public, s-maxage=3600");
  }
  if (upstream.status === 401 || upstream.status === 403) {
    return send(res, 502, { error: "The Harvard Art Museums API didn't accept the server's key." });
  }
  if (upstream.status === 429) {
    return send(res, 503, { error: "The museum's API is busy (rate limit reached). Try again later." });
  }
  if (!upstream.ok) {
    return send(res, 502, { error: `The Harvard Art Museums API answered with HTTP ${upstream.status}.` });
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return send(res, 502, { error: "The Harvard Art Museums API sent something that isn't JSON." });
  }
  if (!data || typeof data !== "object" || data.id == null) {
    return send(res, 404, { error: `The museum has no object with id ${id}.` }, "public, s-maxage=3600");
  }
  return send(res, 200, toArtwork(data), CACHE_OK);
}
