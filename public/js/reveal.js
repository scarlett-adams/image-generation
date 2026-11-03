// "The real painting": when the closest artwork (or the target) changes,
// fetch its details and image URL from our own /api/object function, which
// holds the API key on the server, and show the painting at full size.

const cache = new Map(); // object id -> details
let shownId = null;
let pendingId = null; // waiting out the delay
let timer = null;
let controller = null;

const $ = (id) => document.getElementById(id);

function harvardUrl(id) {
  return `https://harvardartmuseums.org/collections/object/${id}`;
}

function link(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text;
  return a;
}

function setFacts(rows) {
  const dl = $("reveal-facts");
  dl.replaceChildren();
  for (const [k, v] of rows) {
    if (!v) continue;
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

function setStatus(text, extraLink) {
  const p = $("reveal-status");
  p.replaceChildren(text);
  if (extraLink) p.append(" ", extraLink);
  p.hidden = !text;
}

/** What we already know from grids.json, shown while the details load. */
function showBasics(work) {
  $("reveal").hidden = false;
  $("reveal-title").textContent = work.title;
  setFacts([
    ["Artist", work.artist || "Unknown"],
    ["Date", work.dated],
    ["Culture", work.culture],
  ]);
  $("reveal-links").replaceChildren(link(harvardUrl(work.id), "View at the Harvard Art Museums ↗"));
  const frame = $("reveal-frame");
  frame.style.aspectRatio = work.aspect ? String(work.aspect) : "";
}

function showDetails(work, info) {
  $("reveal-title").textContent = info.title || work.title;
  setFacts([
    ["Artist", info.artist || work.artist || "Unknown"],
    ["Date", info.dated || work.dated],
    ["Culture", info.culture || work.culture],
    ["Medium", info.medium],
    ["Dimensions", info.dimensions],
    ["Credit", info.creditline],
  ]);
  const links = [link(info.url || harvardUrl(work.id), "View at the Harvard Art Museums ↗")];
  if (info.image?.fullUrl) links.push(link(info.image.fullUrl, "Full-size image ↗"));
  $("reveal-links").replaceChildren(...links.flatMap((a, i) => (i ? [" · ", a] : [a])));

  const img = $("reveal-img");
  if (!info.image) {
    img.hidden = true;
    img.removeAttribute("src");
    setStatus("The museum doesn't allow this image to be shown outside its own site.", link(info.url || harvardUrl(work.id), "See it there ↗"));
    return;
  }
  setStatus("Loading the image…");
  img.hidden = true;
  img.alt = info.image.alt || `${info.title || work.title}${info.artist ? `, by ${info.artist}` : ""}`;
  img.onload = () => {
    if (shownId !== work.id) return;
    img.hidden = false;
    setStatus("");
  };
  img.onerror = () => {
    if (shownId !== work.id) return;
    img.hidden = true;
    setStatus("The image couldn't be loaded from the museum's image server.", link(info.url || harvardUrl(work.id), "See it there ↗"));
  };
  img.src = info.image.url;
}

async function load(work) {
  shownId = work.id;
  showBasics(work);
  $("reveal-img").hidden = true;
  let info = cache.get(work.id);
  if (!info) {
    setStatus("Fetching the painting from the Harvard Art Museums…");
    controller?.abort();
    controller = new AbortController();
    try {
      const res = await fetch(`/api/object?id=${encodeURIComponent(work.id)}`, { signal: controller.signal });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        throw new Error(body?.error || (res.status === 404 ? "the details service isn't available here" : `HTTP ${res.status}`));
      }
      info = body;
      cache.set(work.id, info);
    } catch (err) {
      if (err.name === "AbortError" || shownId !== work.id) return;
      setStatus(`Couldn't load this painting's details (${err.message}).`, link(harvardUrl(work.id), "See it at the museum ↗"));
      return;
    }
  }
  if (shownId === work.id) showDetails(work, info);
}

/** Shows `work` (a grids.json entry), or hides the panel for null. Waits a
 * moment so a fast-changing match doesn't trigger a fetch per frame. */
export function revealWork(work) {
  if (!work) {
    clearTimeout(timer);
    controller?.abort();
    shownId = null;
    pendingId = null;
    $("reveal").hidden = true;
    return;
  }
  if (work.id === pendingId || (work.id === shownId && pendingId == null)) return;
  clearTimeout(timer);
  if (work.id === shownId) {
    pendingId = null; // back to the painting already shown
    return;
  }
  pendingId = work.id;
  timer = setTimeout(() => {
    pendingId = null;
    load(work);
  }, shownId == null ? 0 : 600);
}
