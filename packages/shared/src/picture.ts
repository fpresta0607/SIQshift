/** The most bytes a profile picture may hold. The apps shrink a picture well under it before sending. */
export const PICTURE_MAX_BYTES = 131_072;

export const PICTURE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type PictureType = (typeof PICTURE_TYPES)[number];

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50];

/** The image type a file's own leading bytes declare, whatever its name or header claims; null for anything else. */
export const pictureTypeOf = (bytes: Uint8Array): PictureType | null => {
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) return "image/webp";
  return null;
};
