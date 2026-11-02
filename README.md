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

## Deploying

On Vercel, set `HARVARD_API_KEY` under **Project Settings → Environment
Variables** (Production and Preview). The build runs `scripts/vercel-build.sh`,
which builds `public/grids.json` with the pipeline. If `public/grids.json` is
committed to the repo, the build uses it instead.

## Tests

```bash
npm test
```
