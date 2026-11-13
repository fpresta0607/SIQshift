import { describe, expect, it } from "vitest";

import { pictureTypeOf } from "./picture.js";

const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values);
const textBytes = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

describe("a picture's type, read from its bytes", () => {
  it.each([
    { name: "JPEG", bytes: bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00), type: "image/jpeg" },
    { name: "PNG", bytes: bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00), type: "image/png" },
    { name: "WebP", bytes: bytesOf(...textBytes("RIFF"), 1, 2, 3, 4, ...textBytes("WEBPVP8 ")), type: "image/webp" },
  ])("recognizes a $name file", ({ bytes, type }) => {
    expect(pictureTypeOf(bytes)).toBe(type);
  });

  it.each([
    { name: "an empty file", bytes: bytesOf() },
    { name: "an SVG", bytes: bytesOf(...textBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")) },
    { name: "a GIF", bytes: bytesOf(...textBytes("GIF89a")) },
    { name: "a RIFF file that is not WebP", bytes: bytesOf(...textBytes("RIFF"), 1, 2, 3, 4, ...textBytes("WAVEfmt ")) },
    { name: "a signature cut short", bytes: bytesOf(0xff, 0xd8) },
  ])("refuses $name", ({ bytes }) => {
    expect(pictureTypeOf(bytes)).toBeNull();
  });
});
