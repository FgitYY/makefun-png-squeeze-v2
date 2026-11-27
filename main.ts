// PNG Squeeze: rewrite each 1280x720 RGBA screenshot as the smallest lossless PNG we can find
// with only Node's standard library. For every image we try each colour form that can hold it
// exactly (palette with PLTE+tRNS, grey, grey+alpha, RGB, RGBA, RGB/grey with a tRNS key),
// each with fixed filters and two per-row adaptive heuristics, screen them with zlib at
// level 6, then re-deflate the best candidates at level 9 and also try a brute-force
// per-row filter search on the winning form (each row's five filters weighed by deflating
// the row after the bytes already chosen). The winning file is decoded back and compared
// pixel by pixel before it is accepted; anything that fails falls back to RGBA+Paeth, and
// then to a plain copy of the input. No clock, no randomness: the work is fixed, so the
// same input always gives the same bytes.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// ---------- CRC-32 (PNG chunks) ----------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- filters ----------
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filter one row of `cur` (prev = row above or null) into `out`, all length = stride.
function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredictor(a, b, c);
    }
  }
}

// Cost of a filtered row for the minimum-sum heuristic: bytes read as signed, absolute, summed.
function signedCost(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Cost for the pairs heuristic: how many distinct neighbouring byte pairs the row holds.
function pairsCost(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Build the filtered raw stream (filter byte + row, per row) for `samples`.
// choice is a fixed filter 0..4, or 'minsum' / 'pairs' to pick per row (lowest type wins ties).
function buildFiltered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRowInto(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let bestType = 0;
    let bestCost = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trials[t]);
      stamp++;
      const cost = choice === 'minsum' ? signedCost(trials[t]) : pairsCost(trials[t], seen, stamp);
      if (cost < bestCost) {
        bestCost = cost;
        bestType = t;
      }
    }
    raw[at] = bestType;
    raw.set(trials[bestType], at + 1);
  }
  return raw;
}

// Brute-force per-row filter choice: each row's five filtered forms (with filter byte) are
// deflated after the last 32 KiB already chosen (as dictionary) and the smallest kept.
// Deterministic and bounded: exactly five small deflates per row.
const BRUTE_CONTEXT = 32768;
const BRUTE_OPTS = { level: 4, memLevel: 9 };
function buildFilteredBrute(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trials.push(row);
  }
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let bestType = 0;
    let bestCost = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trials[t].subarray(1));
      const opts = before.length === 0 ? BRUTE_OPTS : { level: 4, memLevel: 9, dictionary: before };
      const cost = deflateSync(trials[t], opts).length;
      if (cost < bestCost) {
        bestCost = cost;
        bestType = t;
      }
    }
    raw.set(trials[bestType], at);
  }
  return raw;
}

// ---------- PNG decode (the accepted subset: 8-bit, non-interlaced, types 0/2/3/4/6) ----------
function decodeToRgba(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let palette = null;
  let trns = null;
  const idatParts = [];
  let sawEnd = false;
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw new Error('short chunk');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error('bad CRC in ' + type);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error('bit depth is not 8');
      colourType = data[9];
      if (!(colourType in CHANNELS)) throw new Error('colour type ' + colourType);
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('compression/filter/interlace not 0');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    } else {
      throw new Error('unexpected chunk ' + type);
    }
  }
  if (!sawEnd || idatParts.length === 0 || width === 0) throw new Error('incomplete PNG');
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('inflated size mismatch');

  // Unfilter.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredictor(a, b, c);
      }
    } else {
      throw new Error('filter type ' + ft);
    }
  }

  // Expand to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      const g = samples[s];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------- PNG encode ----------
function chunkBytes(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function encodePng(width, height, colourType, plte, trns, idat) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  const parts = [Uint8Array.from(PNG_SIGNATURE), chunkBytes('IHDR', ihdr)];
  if (plte !== null) parts.push(chunkBytes('PLTE', plte));
  if (trns !== null) parts.push(chunkBytes('tRNS', trns));
  parts.push(chunkBytes('IDAT', idat));
  parts.push(chunkBytes('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// File size of the PNG that would hold `zlibLen` IDAT bytes in this form (signature + chunks).
function fileSize(form, zlibLen) {
  let size = 8 + 25 + 12 + zlibLen + 12;
  if (form.plte !== null) size += 12 + form.plte.length;
  if (form.trns !== null) size += 12 + form.trns.length;
  return size;
}

// ---------- image analysis & candidate forms ----------
function pixelKey(r, g, b, a) {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const byKey = new Map();
  let tooMany = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!tooMany) {
      const key = pixelKey(r, g, b, a);
      const hit = byKey.get(key);
      if (hit === undefined) {
        if (byKey.size >= 256) tooMany = true;
        else byKey.set(key, { key, r, g, b, a, count: 1, first: i });
      } else {
        hit.count++;
      }
    }
  }
  return { opaque, grey, colours: tooMany ? null : [...byKey.values()] };
}

// The single fully-transparent value that could be keyed by tRNS, or -1 when there is none.
function transparentKeyOf(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return -1;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return -1;
  }
  if (key === -1) return -1;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return -1;
  }
  return key;
}

function channelSamples(rgba, colourType) {
  if (colourType === 6) return rgba;
  const n = rgba.length >>> 2;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (colourType === 0) {
      out[s] = rgba[d];
    } else if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// Palette form for one ordering. Non-opaque entries go first (by alpha) so tRNS stays short.
// Orders: 'count' (most used first), 'luminance' (dark to bright), 'scan' (first seen first).
function paletteForm(rgba, colours, order) {
  const luminance = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') {
      const d = luminance(x) - luminance(y);
      if (d !== 0) return d;
    } else if (order === 'scan') {
      if (x.first !== y.first) return x.first - y.first;
    } else if (y.count !== x.count) {
      return y.count - x.count;
    }
    return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
  });
  const indexOf = new Map();
  entries.forEach((c, i) => indexOf.set(c.key, i));
  const plte = new Uint8Array(entries.length * 3);
  let trnsLen = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) trnsLen = i + 1;
  });
  const trns = trnsLen === 0 ? null : Uint8Array.from(entries.slice(0, trnsLen), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = indexOf.get(pixelKey(rgba[d], rgba[d + 1], rgba[d + 2], rgba[d + 3]));
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns, choices: [0, 'minsum', 'pairs'] };
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    forms.push(paletteForm(rgba, colours, 'scan'));
    // A non-grey palette image is held in a third of the bytes of RGB or less: skip channel forms.
    if (!grey) return forms;
  }
  const key = opaque ? -1 : transparentKeyOf(rgba, grey);
  let colourType;
  let trns = null;
  if (grey) {
    colourType = opaque || key !== -1 ? 0 : 4;
    if (key !== -1) trns = Uint8Array.of(0, key);
  } else {
    colourType = opaque || key !== -1 ? 2 : 6;
    if (key !== -1) trns = Uint8Array.of(0, (key >>> 16) & 0xff, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  forms.push({
    colourType,
    bpp: CHANNELS[colourType],
    samples: channelSamples(rgba, colourType),
    plte: null,
    trns,
    choices: [0, 1, 2, 3, 4, 'minsum', 'pairs'],
  });
  return forms;
}

// ---------- compression ----------
const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const FINAL_OPTS = [
  { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
];

function smallestDeflate(raw, optionsList) {
  let best = null;
  for (const opts of optionsList) {
    const z = deflateSync(raw, opts);
    if (best === null || z.length < best.length) best = z;
  }
  return best;
}

// Screen every form x filter choice at level 6, re-deflate the two best at level 9, and
// brute-force the per-row filters of the winning form. The screened streams themselves
// stay in the running, so the result is never worse than the screen's own winner.
function compressImage(rgba, width, height) {
  const screened = [];
  for (const form of formsOf(rgba)) {
    for (const choice of form.choices) {
      const raw = buildFiltered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(raw, SCREEN_OPTS);
      screened.push({ form, raw, zlib, size: fileSize(form, zlib.length) });
    }
  }
  screened.sort((x, y) => x.size - y.size);

  let bestPng = null;
  let bestSize = Infinity;
  const consider = (form, idat) => {
    const size = fileSize(form, idat.length);
    if (size < bestSize) {
      bestSize = size;
      bestPng = encodePng(width, height, form.colourType, form.plte, form.trns, new Uint8Array(idat));
    }
  };
  for (const cand of screened.slice(0, 2)) {
    consider(cand.form, cand.zlib);
    consider(cand.form, smallestDeflate(cand.raw, FINAL_OPTS));
  }
  const winner = screened[0].form;
  const bruteRaw = buildFilteredBrute(winner.samples, width, height, winner.bpp);
  consider(winner, deflateSync(bruteRaw, SCREEN_OPTS));
  consider(winner, smallestDeflate(bruteRaw, FINAL_OPTS));
  return bestPng;
}

// Fallback: RGBA, every row Paeth, level 9 (the house baseline's shape, always exact).
function fallbackImage(rgba, width, height) {
  const raw = buildFiltered(rgba, width, height, 4, 4);
  const idat = deflateSync(raw, { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY });
  return encodePng(width, height, 6, null, null, new Uint8Array(idat));
}

function samePixels(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A candidate is accepted only if it decodes back to the exact same RGBA pixels.
function verified(pngBytes, rgba, width, height) {
  try {
    const back = decodeToRgba(pngBytes);
    return back.width === width && back.height === height && samePixels(back.rgba, rgba);
  } catch {
    return false;
  }
}

function answerOne(inputPath, outputPath) {
  const inputBytes = new Uint8Array(readFileSync(inputPath));
  try {
    const { width, height, rgba } = decodeToRgba(inputBytes);
    const candidate = compressImage(rgba, width, height);
    if (verified(candidate, rgba, width, height)) {
      writeFileSync(outputPath, candidate);
      return;
    }
    const fallback = fallbackImage(rgba, width, height);
    if (verified(fallback, rgba, width, height)) {
      writeFileSync(outputPath, fallback);
      return;
    }
  } catch {
    // Fall through to the copy below: the input itself is a valid exact answer.
  }
  copyFileSync(inputPath, outputPath);
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const inDir = join(INPUT_DIR, id);
  try {
    if (!statSync(inDir).isDirectory()) continue;
  } catch {
    continue;
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  answerOne(join(inDir, 'image.png'), join(OUTPUT_DIR, id, 'image.png'));
}
