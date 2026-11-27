# PNG Squeeze

owner=FgitYY
repo=makefun-png-squeeze-v2
referral_code=c6jkt78n

Entry for the make.fun bounty png-squeeze-01-run-20261127: rewrite each 1280x720 RGBA
screenshot as the smallest lossless PNG that still decodes to the exact same pixels.

## Run

```
node main.ts
```

Reads every `/input/<id>/image.png` and writes `/output/<id>/image.png` in one run
(`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the paths for local testing).
Node 22 standard library only; nothing to install.

## How it works

- Decodes each screenshot to raw RGBA (8-bit, non-interlaced PNGs of colour types 0/2/3/4/6).
- Tries every colour form that can hold the image exactly: palette (at most 256 colours,
  exact RGBA through PLTE + tRNS, entries ordered by count, by luminance and by first
  appearance, with non-opaque entries first), grey, grey + alpha, RGB and RGBA, including
  RGB/grey with a single transparent value keyed by tRNS instead of an alpha channel.
- Combines each form with fixed PNG filters and two per-row adaptive heuristics
  (minimum signed sum and fewest distinct byte pairs), screens the candidates with zlib
  at level 6, re-deflates the best two at level 9, and also brute-forces the per-row
  filter choice of the winning form (each row weighed by deflating it after the bytes
  already chosen). The smallest verified file wins.
- Accepts a candidate only after decoding it back and matching every pixel against the
  original; falls back to RGBA + Paeth + level 9, and finally to a copy of the input.
- Fully deterministic: no clock, no randomness, no network. The same input set always
  produces byte-identical output.
