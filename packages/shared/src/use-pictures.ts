import { useEffect, useRef, useState } from "react";

import { pictureTypeOf } from "./picture.js";
import { pictureDataUrl } from "./picture-file.js";

type PictureOwner = { id: string; pictureVersion?: string | null | undefined };

const keyOf = (id: string, version: string): string => `${id}/${version}`;

/**
 * Members' pictures as data URLs, each read once per version: a new version is
 * a new read, and a member whose bytes are no picture keeps their initials. A
 * read that fails keeps them on initials until `refreshTick` next moves - the
 * caller's own refresh, which asks again - so a server that was out of reach
 * for a moment costs one refresh rather than the rest of the session. The
 * server answers a versioned read as immutable, so even a reload costs nothing
 * it has to send again.
 */
export const usePictures = (
  owners: readonly PictureOwner[],
  read: (id: string, version: string) => Promise<Uint8Array>,
  refreshTick: number,
): ((owner: PictureOwner) => string | undefined) => {
  const [pictures, setPictures] = useState<Readonly<Record<string, string>>>({});
  const asked = useRef(new Set<string>());
  const wanted = owners.flatMap((owner) => (owner.pictureVersion == null ? [] : [[owner.id, owner.pictureVersion] as const]));
  const signature = wanted.map(([id, version]) => keyOf(id, version)).join(" ");
  useEffect(() => {
    for (const [id, version] of wanted) {
      const key = keyOf(id, version);
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      void read(id, version).then(
        (bytes) => {
          const type = pictureTypeOf(bytes);
          if (type !== null) setPictures((known) => ({ ...known, [key]: pictureDataUrl(bytes, type) }));
        },
        () => {
          asked.current.delete(key);
        },
      );
    }
    // `wanted` is rebuilt every render; its signature is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, read, refreshTick]);
  return (owner) => (owner.pictureVersion == null ? undefined : pictures[keyOf(owner.id, owner.pictureVersion)]);
};
