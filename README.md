# Infinite Monkey Museum

A "monkey" paints random low-resolution pixel grids at high speed and compares
each one to tiny quantized versions of real paintings from the
[Harvard Art Museums API](https://github.com/harvardartmuseums/api-docs).

> Work in progress. A full write-up (how it works, background, architecture)
> is coming.

## Layout

```
scripts/build_grids.py   data pipeline: fetch paintings, fit palette, write grids
scripts/vercel-build.sh  Vercel build step (runs the pipeline with the env var key)
public/                  the site (static): index.html, style.css, js/
public/grids.json        16x16 grids + palette (built by the pipeline)
public/grids-8.json      8x8 grids, same palette
test/                    JS unit tests (node --test)
```

## Building the data locally

```bash
cp .env.example .env        # then paste your key after HARVARD_API_KEY=
python3 -m pip install -r scripts/requirements.txt
python3 scripts/build_grids.py --size 16 8
```

Request a free key at <https://harvardartmuseums.org/collections/api>. The key
is read from `.env` (gitignored) or the `HARVARD_API_KEY` environment variable
and is never written to the output.

The pipeline looks at every painting with an image (about 4,700) and keeps the
first 1,000, in the API's seeded random order, that are still legible as a
16x16 grid: no palette color covers more than half the grid, at least 5 colors
are used, there is some light/dark contrast, and the painting is no more than
3:2 tall or wide. Without this, half the collection (mostly East Asian ink
paintings on silk) comes out as one flat color, and random noise "matches"
those blank grids almost every time. What the filter removed, by rule and by
culture, is saved in `grids.json` under `selection`. See `--help` to change
the rules.

Harvard's image server refuses downloads from cloud build machines (HTTP 403),
so run the pipeline on your own computer and commit `public/grids.json` and
`public/grids-8.json`. The Vercel build uses the committed files.

## Deploying

On Vercel, set `HARVARD_API_KEY` under **Project Settings → Environment
Variables** (Production and Preview). The build runs `scripts/vercel-build.sh`,
which builds `public/grids.json` with the pipeline. If `public/grids.json` is
committed to the repo, the build uses it instead.

## Tests

```bash
npm test
```
