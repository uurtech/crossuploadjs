import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniff, typeAllowed, narrowTypes } from '../src/sniff.js';

const b = (...bytes) => Buffer.from(bytes);

test('recognises common document and image types from bytes', () => {
  assert.equal(sniff(Buffer.from('%PDF-1.7\n')).mime, 'application/pdf');
  assert.equal(sniff(b(0xff, 0xd8, 0xff, 0xe0)).mime, 'image/jpeg');
  assert.equal(sniff(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).mime, 'image/png');
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')).mime, 'image/webp');
  assert.equal(sniff(Buffer.concat([b(0, 0, 0, 0x18), Buffer.from('ftypheic')])).mime, 'image/heic');
  assert.equal(sniff(b(0x50, 0x4b, 0x03, 0x04), 'cv.docx').mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('the name never decides the type', () => {
  const r = sniff(Buffer.from('<!DOCTYPE html><script>alert(1)</script>'), 'invoice.pdf');
  assert.equal(r.mime, 'text/html');
  assert.equal(r.dangerous, true);
});

test('executables, scripts, HTML and SVG are dangerous', () => {
  assert.equal(sniff(Buffer.from('MZ\x90\0')).dangerous, true);
  assert.equal(sniff(b(0x7f, 0x45, 0x4c, 0x46)).dangerous, true);
  assert.equal(sniff(Buffer.from('#!/bin/sh\nrm -rf /')).dangerous, true);
  assert.equal(sniff(Buffer.from('﻿  <svg xmlns="http://www.w3.org/2000/svg"></svg>')).dangerous, true);
  assert.equal(sniff(Buffer.from('<?xml version="1.0"?><svg></svg>')).dangerous, true);
});

test('allow-list accepts exact types, wildcards and extensions', () => {
  assert.ok(typeAllowed('image/png', ['image/*']));
  assert.ok(typeAllowed('application/pdf', ['.pdf']));
  assert.ok(!typeAllowed('application/zip', ['image/*', 'application/pdf']));
});

test('a session can narrow but never widen the server types', () => {
  const defaults = ['image/jpeg', 'image/png', 'application/pdf'];
  assert.deepEqual(narrowTypes(['application/pdf'], defaults), ['application/pdf']);
  assert.deepEqual(narrowTypes(['application/pdf', 'application/zip'], defaults), ['application/pdf']);
  assert.equal(narrowTypes(['application/zip'], defaults), null);
  assert.deepEqual(narrowTypes(undefined, defaults), defaults);
});
