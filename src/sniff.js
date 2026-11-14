/**
 * File-type detection from the bytes, never from the name or the browser's claim.
 * `sniff(head, name)` takes the first bytes of the file (4 KB is plenty) and
 * returns { mime, dangerous }. Dangerous types are rejected regardless of policy.
 */

const ascii = (buf, start, end) => buf.subarray(start, end).toString('latin1');
const starts = (buf, bytes, offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const OFFICE_BY_EXT = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function ext(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function looksLikeMarkup(buf) {
  // Skip a UTF-8 BOM and leading whitespace, then look for HTML/SVG/XML openers.
  let text = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if (text.startsWith('<?xml')) return text.includes('<svg') || text.includes('<html') ? true : 'xml';
  return /^<(!doctype html|html|head|body|script|svg|iframe|meta|a |div|style)/.test(text);
}

function isText(buf) {
  const sample = buf.subarray(0, 1024);
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
    return true;
  } catch {
    return false;
  }
}

export function sniff(head, name = '') {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head);
  const e = ext(name);

  // Executables and scripts: always rejected.
  if (starts(b, [0x4d, 0x5a])) return { mime: 'application/x-msdownload', dangerous: true };
  if (starts(b, [0x7f, 0x45, 0x4c, 0x46])) return { mime: 'application/x-elf', dangerous: true };
  if ([[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((sig) => starts(b, sig))) {
    return { mime: 'application/x-mach-binary', dangerous: true };
  }
  if (starts(b, [0x23, 0x21])) return { mime: 'text/x-script', dangerous: true };

  if (ascii(b, 0, 5) === '%PDF-') return { mime: 'application/pdf', dangerous: false };
  if (starts(b, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', dangerous: false };
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', dangerous: false };
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { mime: 'image/gif', dangerous: false };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { mime: 'image/webp', dangerous: false };

  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', dangerous: false };
    if (HEIF_BRANDS.has(brand)) return { mime: 'image/heic', dangerous: false };
    if (brand === 'qt  ') return { mime: 'video/quicktime', dangerous: false };
    return { mime: 'video/mp4', dangerous: false };
  }

  if (starts(b, [0x50, 0x4b, 0x03, 0x04])) {
    // Office Open XML files are ZIP containers; the name decides which one.
    return { mime: OFFICE_BY_EXT[e] || 'application/zip', dangerous: false };
  }

  const markup = looksLikeMarkup(b);
  if (markup === true) return { mime: 'text/html', dangerous: true };
  if (markup === 'xml') return { mime: 'application/xml', dangerous: false };

  if (isText(b)) return { mime: e === 'csv' ? 'text/csv' : 'text/plain', dangerous: false };
  return { mime: 'application/octet-stream', dangerous: false };
}

/**
 * Does `mime` match the allow-list? Entries may be exact types ("application/pdf"),
 * wildcards ("image/*") or extensions (".pdf").
 */
const EXT_MIME = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heic',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.txt': 'text/plain',
  '.csv': 'text/csv', '.zip': 'application/zip', ...Object.fromEntries(Object.entries(OFFICE_BY_EXT).map(([k, v]) => ['.' + k, v])),
};

export function typeAllowed(mime, allowed) {
  return allowed.some((rule) => {
    const r = rule.trim().toLowerCase();
    if (r.startsWith('.')) return EXT_MIME[r] === mime;
    if (r.endsWith('/*')) return mime.startsWith(r.slice(0, -1));
    return r === mime;
  });
}

/** A session may only narrow the server defaults, never widen them. */
export function narrowTypes(requested, defaults) {
  if (!Array.isArray(requested) || requested.length === 0) return defaults;
  const known = Object.values(EXT_MIME).concat(['image/jpeg', 'image/png']);
  const kept = requested.filter((r) => {
    const rule = String(r).toLowerCase();
    if (rule.startsWith('.')) return EXT_MIME[rule] && typeAllowed(EXT_MIME[rule], defaults);
    if (rule.endsWith('/*')) return known.some((m) => m.startsWith(rule.slice(0, -1)) && typeAllowed(m, defaults));
    return typeAllowed(rule, defaults);
  });
  return kept.length ? kept : null;
}
