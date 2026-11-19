// The album accepts a single baseline JPEG scan from a resized canvas.
// Application segments can contain GPS, thumbnails or names. Keep only codec data.
function sanitizeJpeg_(bytes) {
  if (!bytes || bytes.length < 4 || bytes.length > 1024 * 1024) fail_('invalid');
  const data = Uint8Array.from(bytes);
  const word = at => data[at] * 256 + data[at + 1];
  if (word(0) !== 0xffd8) fail_('invalid');

  const clean = [0xff, 0xd8];
  const quantizers = new Set();
  const huffman = new Set();
  const components = new Map();
  let restartInterval = 0;
  let pos = 2;
  while (pos + 3 < data.length) {
    const markerStart = pos;
    if (data[pos++] !== 0xff) fail_('invalid');
    while (data[pos] === 0xff) pos++;
    const marker = data[pos++];
    const length = word(pos);
    const start = pos + 2;
    const end = pos + length;
    if (!Number.isInteger(end) || length < 2 || end > data.length) fail_('invalid');
    pos = end;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) continue;

    switch (marker) {
      case 0xdb: { // 8-bit quantization tables
        if (start === end || (end - start) % 65 !== 0) fail_('invalid');
        for (let at = start; at < end; at += 65) {
          if (data[at] > 3) fail_('invalid');
          for (let i = at + 1; i < at + 65; i++) {
            if (data[i] === 0) fail_('invalid');
          }
          quantizers.add(data[at]);
        }
        break;
      }
      case 0xc4: // Huffman tables
        jpegReadHuffman_(data, start, end, huffman);
        break;
      case 0xc0: { // baseline start of frame
        const height = word(start + 1);
        const width = word(start + 3);
        const count = data[start + 5];
        if (components.size || data[start] !== 8 || !(width >= 1 && width <= 2048) ||
            !(height >= 1 && height <= 2048) || ![1, 3].includes(count) || length !== 8 + 3 * count) fail_('invalid');
        let blocks = 0;
        for (let at = start + 6; at < end; at += 3) {
          const id = data[at];
          const horizontal = data[at + 1] >> 4;
          const vertical = data[at + 1] & 15;
          if (components.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4) fail_('invalid');
          components.set(id, data[at + 2]);
          blocks += horizontal * vertical;
        }
        if (blocks > 10) fail_('invalid');
        break;
      }
      case 0xdd: // restart interval
        if (length !== 4) fail_('invalid');
        restartInterval = word(start);
        break;
      case 0xda: { // one baseline interleaved scan, spanning all frame components
        const count = data[start];
        if (!count || count !== components.size || length !== 6 + 2 * count ||
            data[end - 3] !== 0 || data[end - 2] !== 63 || data[end - 1] !== 0) fail_('invalid');
        const seen = new Set();
        for (let at = start + 1; at < end - 3; at += 2) {
          const id = data[at];
          const tables = data[at + 1];
          if (seen.has(id) || !quantizers.has(components.get(id)) ||
              !huffman.has(tables >> 4) || !huffman.has(16 + (tables & 15))) fail_('invalid');
          seen.add(id);
        }
        jpegCheckScanEnd_(data, end, restartInterval);
        for (let at = markerStart; at < data.length; at++) clean.push(data[at]);
        // Apps Script Utilities.newBlob accepts Java-style signed bytes.
        return clean.map(value => value > 127 ? value - 256 : value);
      }
      default:
        fail_('invalid');
    }
    for (let at = markerStart; at < end; at++) clean.push(data[at]);
  }
  fail_('invalid');
}

function jpegReadHuffman_(data, start, end, tables) {
  if (start === end) fail_('invalid');
  let at = start;
  while (at < end) {
    if (at + 17 > end) fail_('invalid');
    const id = data[at++];
    if (![0, 1, 2, 3, 16, 17, 18, 19].includes(id)) fail_('invalid');
    let slots = 1;
    let symbols = 0;
    for (let i = 0; i < 16; i++) {
      const count = data[at++];
      slots = slots * 2 - count;
      if (slots < 1) fail_('invalid');
      symbols += count;
    }
    if (!symbols || symbols > 256 || at + symbols > end) fail_('invalid');
    for (let i = 0; i < symbols; i++) {
      const symbol = data[at++];
      if (id < 16) {
        if (symbol > 11) fail_('invalid');
      } else if (symbol !== 0 && symbol !== 0xf0 && ((symbol & 15) === 0 || (symbol & 15) > 10)) {
        fail_('invalid');
      }
    }
    tables.add(id);
  }
}

function jpegCheckScanEnd_(data, start, restartInterval) {
  let pos = start;
  let hasData = false;
  let restart = 0;
  while (pos < data.length) {
    if (data[pos++] !== 0xff) {
      hasData = true;
      continue;
    }
    while (data[pos] === 0xff) pos++;
    const marker = data[pos++];
    if (marker === 0) {
      hasData = true;
    } else if (restartInterval && marker === 0xd0 + restart && hasData) {
      restart = (restart + 1) % 8;
      hasData = false;
    } else if (marker === 0xd9 && hasData && pos === data.length) {
      return;
    } else {
      fail_('invalid');
    }
  }
  fail_('invalid');
}
