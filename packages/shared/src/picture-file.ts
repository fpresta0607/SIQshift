import { pictureTypeOf } from "./picture.js";

/** The side a profile picture is stored at: sharp at twice the largest avatar, and a few dozen kilobytes as a JPEG. */
const PICTURE_SIDE = 256;
const PICTURE_QUALITY = 0.86;
const UNREADABLE = "That picture could not be read. Try another.";

/** Why a picked file cannot become a profile picture, in words a member reads. */
export class PictureFileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PictureFileError";
  }
}

const bytesOf = (blob: Blob): Promise<Uint8Array<ArrayBuffer>> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const { result } = reader;
      if (result === null || typeof result === "string") reject(new PictureFileError(UNREADABLE));
      else resolve(new Uint8Array(result));
    };
    reader.onerror = () => reject(new PictureFileError(UNREADABLE));
    reader.readAsArrayBuffer(blob);
  });

/**
 * A picked file as the bytes to send: refused unless its own leading bytes say
 * JPEG, PNG or WebP, then cropped to its middle square and drawn at 256 pixels
 * as a JPEG, far under the server's cap.
 */
export const readPictureFile = async (file: Blob): Promise<Uint8Array<ArrayBuffer>> => {
  if (pictureTypeOf(await bytesOf(file.slice(0, 12))) === null) {
    throw new PictureFileError("Pick a JPG, PNG or WebP picture.");
  }
  const image = await createImageBitmap(file).catch(() => Promise.reject(new PictureFileError(UNREADABLE)));
  const side = Math.min(image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = PICTURE_SIDE;
  canvas.height = PICTURE_SIDE;
  const context = canvas.getContext("2d");
  if (context === null) throw new PictureFileError(UNREADABLE);
  context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, PICTURE_SIDE, PICTURE_SIDE);
  image.close();
  const drawn = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PICTURE_QUALITY));
  if (drawn === null) throw new PictureFileError(UNREADABLE);
  return bytesOf(drawn);
};

/** Bytes as a data URL: besides the apps' own files, the one image source their content policies allow. */
export const pictureDataUrl = (bytes: Uint8Array, type: string): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${type};base64,${btoa(binary)}`;
};
