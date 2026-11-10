/**
 * Magic-byte image detection shared by the server upload guards and the
 * browser's saved-document re-read, so both sides agree on what a photo is.
 *
 * HEIF/AVIF carry their codec in the `ftyp` brand list: iPhone photos often use
 * the generic `mif1`/`msf1` major brand and put `heic` (or `avif`) in the
 * compatible brands that follow, so the whole box has to be inspected.
 */

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIF_BRANDS = new Set([...HEIC_BRANDS, ...AVIF_BRANDS, "mif1", "msf1"]);

/** Identify an image from its leading bytes; anything else returns null. */
export function sniffImageBytes(head: Uint8Array): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return "image/png";
  }
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  if (head.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (head.length >= 12 && ascii(4, 8) === "ftyp") {
    const mime = ftypMime(head, ascii);
    if (mime) return mime;
  }
  if (head.length >= 14 && ascii(0, 2) === "BM") {
    // A real BMP starts with a 14-byte file header: the reserved bytes are zero
    // and both the declared file size and the pixel-array offset are plausible.
    const size = (head[2] | (head[3] << 8) | (head[4] << 16) | (head[5] << 24)) >>> 0;
    const offset = (head[10] | (head[11] << 8) | (head[12] << 16) | (head[13] << 24)) >>> 0;
    if (head[6] === 0 && head[7] === 0 && head[8] === 0 && head[9] === 0 && size >= 54 && offset >= 54) {
      return "image/bmp";
    }
  }
  if (head.length >= 4 && ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a))) {
    return "image/tiff";
  }
  return null;
}

/**
 * Read the `ftyp` box brands. A generic `mif1`/`msf1` major brand is resolved
 * by scanning the compatible brands that follow the minor version.
 */
function ftypMime(head: Uint8Array, ascii: (start: number, end: number) => string): string | null {
  const major = ascii(8, 12);
  if (!HEIF_BRANDS.has(major)) return null;
  if (AVIF_BRANDS.has(major)) return "image/avif";

  if (major === "mif1" || major === "msf1") {
    // A box size of 0 means "until the end of the file"; otherwise the declared
    // size bounds the compatible-brand list. Never read past the declared box.
    const declared = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
    const end = declared === 0 ? head.length : Math.min(head.length, declared);
    let heic = false;
    for (let offset = 16; offset + 4 <= end; offset += 4) {
      const brand = ascii(offset, offset + 4);
      if (AVIF_BRANDS.has(brand)) return "image/avif";
      if (HEIC_BRANDS.has(brand)) heic = true;
    }
    // If the brand list continues past the bytes we have, an AVIF brand may be
    // beyond the window. Do not guess HEIC: reject instead of mislabelling.
    if (declared === 0 || declared > head.length) return null;
    // A generic mif1/msf1 container without a HEIC brand may hold another codec
    // (for example JPEG 2000); only a real HEIC brand makes it a HEIC photo.
    return heic ? "image/heic" : null;
  }
  return "image/heic";
}
