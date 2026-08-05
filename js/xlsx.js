// Reading an .xlsx in the browser, with no library.
//
// An xlsx is a zip of XML. Both halves of that are already in the platform: DecompressionStream
// inflates, DOMParser reads the XML. So this is about ninety lines instead of a third party
// spreadsheet library, which matters here for three reasons.
//
// CLAUDE.md allows CDN libraries, and a full spreadsheet library would be the obvious choice.
// It is the wrong one for this job. It is several hundred kilobytes to support formulas, charts,
// styles, and formats nothing here reads. It is a second CDN origin that can serve different
// bytes tomorrow, on a page that holds a session token. And it would give back exactly what this
// gives back: cell text.
//
// What this deliberately does not do: formulas (the cached value is read instead, which is what
// the trainer sees on screen), styles, dates as dates, or anything write side. A program is
// typed text in a grid.

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;

/**
 * Entry names to raw bytes. Only the deflate and stored methods, which is everything Excel and
 * Sheets actually emit.
 */
async function unzip(buffer) {
  const view = new DataView(buffer);

  // The end of central directory record is last, after a comment of unknown length, so it is
  // found by scanning backwards for its signature rather than by arithmetic.
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file, so not an xlsx either.');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = {};

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== ZIP_CENTRAL) break;
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localAt = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buffer, offset + 46, nameLen));

    // The local header repeats the name and extra fields, and its extra length can differ from
    // the central one, so the data offset has to be read from the local header rather than
    // assumed from the central directory.
    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const bytes = new Uint8Array(buffer, dataAt, compressed);

    if (method === 0) {
      files[name] = bytes;
    } else if (method === 8) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      files[name] = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    // Anything else is a compression method no spreadsheet tool emits, and is skipped rather
    // than guessed at.

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const text = (bytes) => new TextDecoder().decode(bytes);
const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');

/** 'BC7' -> 54. Spreadsheet columns are base 26 with no zero. */
export function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref);
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Every sheet in the workbook, as [{ name, rows }] where rows is an array of arrays of strings.
 *
 * Empty cells come back as empty strings and short rows are padded, so a caller can index by
 * column number without checking length. That matters because every rule in js/import-program.js
 * is written as "column 10 is Reps".
 */
export async function readWorkbook(buffer) {
  const files = await unzip(buffer);

  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    for (const si of parse(text(files['xl/sharedStrings.xml'])).getElementsByTagName('si')) {
      // A cell can be rich text, split across several runs, and the trainer sees them joined.
      shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
    }
  }

  const rels = {};
  if (files['xl/_rels/workbook.xml.rels']) {
    for (const rel of parse(text(files['xl/_rels/workbook.xml.rels'])).getElementsByTagName('Relationship')) {
      rels[rel.getAttribute('Id')] = rel.getAttribute('Target');
    }
  }

  const book = parse(text(files['xl/workbook.xml']));
  const sheets = [];

  for (const sheet of book.getElementsByTagName('sheet')) {
    const id = sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let target = rels[id] || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    if (!files[target]) continue;

    const doc = parse(text(files[target]));
    const grid = new Map();
    let maxRow = 0;
    let maxCol = 0;

    for (const c of doc.getElementsByTagName('c')) {
      const ref = c.getAttribute('r');
      if (!ref) continue;
      const type = c.getAttribute('t');
      let value = null;

      if (type === 's') {
        const v = c.getElementsByTagName('v')[0];
        if (v) value = shared[Number(v.textContent)] ?? '';
      } else if (type === 'inlineStr') {
        value = [...c.getElementsByTagName('t')].map((t) => t.textContent).join('');
      } else {
        // Includes formula cells, where <v> holds the value the trainer is looking at.
        const v = c.getElementsByTagName('v')[0];
        if (v) value = v.textContent;
      }
      if (value === null || String(value).trim() === '') continue;

      const row = Number(/(\d+)/.exec(ref)[1]);
      const col = columnIndex(ref);
      grid.set(`${row}:${col}`, String(value).trim());
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }

    const rows = [];
    for (let r = 1; r <= maxRow; r += 1) {
      const line = [];
      for (let c = 0; c <= maxCol; c += 1) line.push(grid.get(`${r}:${c}`) ?? '');
      rows.push(line);
    }
    sheets.push({ name: sheet.getAttribute('name') || `Sheet ${sheets.length + 1}`, rows });
  }

  return sheets;
}

/** True when the browser can do this at all. Safari before 16.4 and Firefox before 113 cannot. */
export function canReadWorkbooks() {
  return typeof DecompressionStream === 'function' && typeof DOMParser === 'function';
}
