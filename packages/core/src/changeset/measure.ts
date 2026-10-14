/**
 * How `validateLength` measures a string: in grapheme clusters, code points or UTF-8 bytes.
 *
 * @module
 */

let segmenter: Intl.Segmenter | undefined;

/**
 * The number of grapheme clusters (what a reader sees as one character) in `text`.
 * Text of ASCII characters other than a carriage return is counted without segmenting:
 * each such character is one cluster.
 */
export function graphemes(text: string): number {
  let simple = true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // A carriage return followed by a line feed is one cluster.
    if (code >= 0x80 || code === 0x0d) {
      simple = false;
      break;
    }
  }
  if (simple) return text.length;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

/** The number of Unicode code points in `text`; a lone surrogate counts as one. */
export function codepoints(text: string): number {
  let count = text.length;
  for (let i = 0; i < text.length - 1; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        count--;
        i++;
      }
    }
  }
  return count;
}

/** The length of `text` in UTF-8 bytes; a lone surrogate counts as the 3 bytes of U+FFFD. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}
