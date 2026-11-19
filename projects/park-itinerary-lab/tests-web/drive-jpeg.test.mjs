import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../drive-album/Jpeg.gs', import.meta.url), 'utf8');
const gas = vm.createContext({fail_(code) { throw new Error(code); }});
vm.runInContext(script, gas);
const clean = input => Buffer.from(gas.sanitizeJpeg_(Int8Array.from(input)));

// Solid RGB (150, 120, 90) at 2 × 3 pixels, baseline JPEG generated with Pillow.
const rgb = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwg' +
  'IyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo' +
  'KCgoKCgoKCgoKCgoKCj/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAUEAEAAAAAAAAAAAAA' +
  'AAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIAEE3//2Q==', 'base64'
);
const segment = (marker, payload) => Buffer.concat([
  Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload,
]);
function replaceSegment(bytes, marker, transform) {
  const start = bytes.indexOf(Buffer.from([0xff, marker]));
  assert.ok(start >= 0);
  const end = start + 2 + bytes.readUInt16BE(start + 2);
  return Buffer.concat([bytes.subarray(0, start), transform(Buffer.from(bytes.subarray(start, end))), bytes.subarray(end)]);
}

test('strips JPEG app metadata and comments while preserving baseline image and signed bytes', () => {
  const pixels = replaceSegment(rgb, 0xe0, () => Buffer.alloc(0));
  const added = Buffer.concat([rgb.subarray(0, 2), segment(0xe1, Buffer.from('Exif\0\0GPS')),
    segment(0xe2, Buffer.from('profile')), segment(0xfe, Buffer.from('owner')), rgb.subarray(2)]);
  assert.deepEqual(clean(added), pixels);
  assert.deepEqual(clean(pixels), pixels);
  assert.equal(gas.sanitizeJpeg_(Array.from(added))[0], -1);
});

test('rejects missing frame, quantizers, tables, empty scan, unsupported frame and invalid dimensions', () => {
  const stripped = (code) => replaceSegment(rgb, code, () => Buffer.alloc(0));
  for (const code of [0xc0, 0xdb, 0xc4, 0xda]) assert.throws(() => clean(stripped(code)), /invalid/);
  const changeFrame = (offset, value) => replaceSegment(rgb, 0xc0, buf => {buf[offset] = value; return buf;});
  for (const bytes of [changeFrame(1, 0xc2), changeFrame(7, 9), changeFrame(10, 0), changeFrame(11, 0),
    replaceSegment(rgb, 0xdb, b => {b[5] = 0; return b;}),
    replaceSegment(rgb, 0xc4, b => {b[5] = 4; return b;}),
    replaceSegment(rgb, 0xda, b => {b[8] = 0xff; return b;})]) assert.throws(() => clean(bytes), /invalid/);
  const scan = rgb.indexOf(Buffer.from([255, 218]));
  const entropy = scan + 2 + rgb.readUInt16BE(scan + 2);
  assert.throws(() => clean(Buffer.concat([rgb.subarray(0, entropy), Buffer.from([255, 217])])), /invalid/);
});

test('rejects trailing data, embedded markers in scan, restart without interval, truncation and oversized inputs', () => {
  for (const bytes of [rgb.subarray(0, rgb.length - 1), Buffer.concat([rgb, Buffer.from('extra')]),
    Buffer.concat([rgb.subarray(0, -2), segment(0xe1, Buffer.from('GPS')), rgb.subarray(-2)]),
    Buffer.concat([rgb.subarray(0, -2), Buffer.from([255, 208, 127, 255, 217])]),
    Buffer.from([255, 216, 255, 233, 1, 5, 255, 217]), Buffer.alloc(1024 * 1024 + 1)]) {
    assert.throws(() => clean(bytes), /invalid/);
  }
});
