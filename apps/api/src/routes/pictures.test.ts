import { PICTURE_MAX_BYTES } from "@siqshift/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import type { AuthenticatedSubject, AuthenticatedUser } from "../auth.js";
import { parseEnv } from "../env.js";
import type { PictureRecord, PictureRepository } from "../repositories.js";
import { createTestAuth } from "../test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  otherOrganization: "1e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  teammate: "e2c7e513-b094-4d4c-ae55-21790ae019a4",
  outsider: "e3c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://siqshift:password@localhost:5432/siqshift",
  AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
  NODE_ENV: "test",
});
const people: AuthenticatedUser[] = [
  { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization, role: "member", pictureVersion: null },
  { id: ids.teammate, email: "sam@example.com", name: "Sam", organizationId: ids.organization, role: "member", pictureVersion: null },
  { id: ids.outsider, email: "riley@example.com", name: "Riley", organizationId: ids.otherOrganization, role: "member", pictureVersion: null },
];
const samples = {
  jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  webp: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]),
};

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeaders: Record<"user" | "teammate" | "outsider", string>;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  bearerHeaders = {
    user: await auth.bearer(ids.user),
    teammate: await auth.bearer(ids.teammate),
    outsider: await auth.bearer(ids.outsider),
  };
});

/** Both tables in one place: a save or a remove moves the member's version with the picture, as the real transaction does. */
class MemoryPictures implements PictureRepository {
  public readonly pictures = new Map<string, PictureRecord>();
  public constructor(private readonly members: Map<string, AuthenticatedUser>) {}
  public async save(subject: AuthenticatedSubject, picture: PictureRecord) {
    this.pictures.set(subject.userId, picture);
    this.setVersion(subject.userId, picture.version);
  }
  public async remove(subject: AuthenticatedSubject) {
    this.pictures.delete(subject.userId);
    this.setVersion(subject.userId, null);
  }
  public async find(subject: AuthenticatedSubject, userId: string) {
    if (this.members.get(userId)?.organizationId !== subject.organizationId) return null;
    return this.pictures.get(userId) ?? null;
  }
  private setVersion(userId: string, pictureVersion: string | null) {
    const member = this.members.get(userId);
    if (member !== undefined) this.members.set(userId, { ...member, pictureVersion });
  }
}

function createTestApp() {
  const members = new Map(people.map((person) => [person.id, person]));
  const pictures = new MemoryPictures(members);
  const app = createApp({
    config,
    keys,
    accounts: {
      resolve: async (identity) => {
        const member = members.get(identity.authUserId);
        if (member === undefined) throw new Error("Unknown member");
        return member;
      },
    },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    pictureRepository: pictures,
  });
  return { app, pictures };
}

function upload(app: ReturnType<typeof createTestApp>["app"], authorization: string, body: Uint8Array, contentType = "image/png") {
  return app.request("http://api.test/me/picture", { method: "PUT", headers: { authorization, "content-type": contentType }, body });
}

/** A PNG signature padded with zeros to exactly `size` bytes. */
function pngOfSize(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(samples.png);
  return bytes;
}

/** The version a picture upload answered with, which every other read names it by. */
async function versionFrom(response: Response): Promise<string> {
  const { user } = (await response.json()) as { user: { pictureVersion: string } };
  return user.pictureVersion;
}

describe("picture routes", () => {
  it.each([
    { type: "image/jpeg", bytes: samples.jpeg },
    { type: "image/png", bytes: samples.png },
    { type: "image/webp", bytes: samples.webp },
  ])("stores a $type upload by its bytes, whatever its header says, and serves it for good under the version it answers with", async ({ type, bytes }) => {
    const { app } = createTestApp();

    const response = await upload(app, bearerHeaders.user, bytes, "application/octet-stream");
    const { user } = (await response.json()) as { user: { pictureVersion: string } };
    const read = await app.request(`http://api.test/users/${ids.user}/picture?v=${user.pictureVersion}`, {
      headers: { authorization: bearerHeaders.teammate },
    });

    expect(response.status).toBe(200);
    expect(user).toEqual({
      id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization, role: "member", pictureVersion: expect.any(String),
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe(type);
    expect(read.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    { label: "the current version", query: (version: string) => `?v=${version}`, cacheControl: "private, max-age=31536000, immutable" },
    { label: "no version", query: () => "", cacheControl: "private, no-cache" },
    { label: "a stale version", query: () => "?v=0000000000000000", cacheControl: "private, no-cache" },
  ])("serves a teammate's picture under $label with its type, tag and caching", async ({ query, cacheControl }) => {
    const { app } = createTestApp();
    const version = await versionFrom(await upload(app, bearerHeaders.user, samples.png));

    const response = await app.request(`http://api.test/users/${ids.user}/picture${query(version)}`, {
      headers: { authorization: bearerHeaders.teammate },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("etag")).toBe(`"${version}"`);
    expect(response.headers.get("cache-control")).toBe(cacheControl);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(samples.png);
  });

  it.each([
    { label: "an empty body", bytes: new Uint8Array(0) },
    { label: "plain text", bytes: new TextEncoder().encode("not a picture at all") },
    { label: "a GIF", bytes: new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000") },
    { label: "an SVG", bytes: new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>") },
  ])("refuses $label sent as image/png and stores nothing", async ({ bytes }) => {
    const { app, pictures } = createTestApp();

    const response = await upload(app, bearerHeaders.user, bytes, "image/png");
    const me = await app.request("http://api.test/me", { headers: { authorization: bearerHeaders.user } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "validation_error", message: "A picture must be a JPEG, PNG or WebP image." },
    });
    expect(pictures.pictures.size).toBe(0);
    await expect(me.json()).resolves.toMatchObject({ user: { pictureVersion: null } });
  });

  it("refuses a picture one byte over the cap and stores nothing", async () => {
    const { app, pictures } = createTestApp();

    const response = await upload(app, bearerHeaders.user, pngOfSize(PICTURE_MAX_BYTES + 1));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: { code: "validation_error", message: "Request body is too large." } });
    expect(pictures.pictures.size).toBe(0);
  });

  it("accepts a picture of exactly the cap", async () => {
    const { app, pictures } = createTestApp();

    const response = await upload(app, bearerHeaders.user, pngOfSize(PICTURE_MAX_BYTES));

    expect(response.status).toBe(200);
    expect(pictures.pictures.get(ids.user)?.bytes.length).toBe(PICTURE_MAX_BYTES);
  });

  it.each([
    { method: "PUT", path: "/me/picture" },
    { method: "DELETE", path: "/me/picture" },
    { method: "GET", path: `/users/${ids.user}/picture` },
  ])("requires a bearer token to $method $path", async ({ method, path }) => {
    const { app } = createTestApp();

    const response = await app.request(`http://api.test${path}`, { method, ...(method === "PUT" ? { body: samples.png } : {}) });

    expect(response.status).toBe(401);
  });

  it.each([
    { label: "another organization's member", userId: ids.outsider },
    { label: "a member without a picture", userId: ids.teammate },
    { label: "an unknown user", userId: "f9c7e513-b094-4d4c-ae55-21790ae019a4" },
    { label: "a malformed id", userId: "not-a-user" },
  ])("answers 404 for $label", async ({ userId }) => {
    const { app } = createTestApp();
    await upload(app, bearerHeaders.outsider, samples.jpeg);

    const response = await app.request(`http://api.test/users/${userId}/picture`, { headers: { authorization: bearerHeaders.user } });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: { code: "not_found", message: "Picture not found." } });
  });

  it("deletes the picture so the next read is a 404, and deleting again still succeeds", async () => {
    const { app } = createTestApp();
    await upload(app, bearerHeaders.user, samples.webp);

    const removed = await app.request("http://api.test/me/picture", { method: "DELETE", headers: { authorization: bearerHeaders.user } });
    const read = await app.request(`http://api.test/users/${ids.user}/picture`, { headers: { authorization: bearerHeaders.teammate } });
    const again = await app.request("http://api.test/me/picture", { method: "DELETE", headers: { authorization: bearerHeaders.user } });

    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({ user: { id: ids.user, pictureVersion: null } });
    expect(read.status).toBe(404);
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ user: { id: ids.user, pictureVersion: null } });
  });

  it("replaces the first upload with the second under a new version, so a link naming the first is no longer cached for good", async () => {
    const { app, pictures } = createTestApp();

    const firstVersion = await versionFrom(await upload(app, bearerHeaders.user, samples.jpeg));
    const secondVersion = await versionFrom(await upload(app, bearerHeaders.user, samples.png));
    const read = await app.request(`http://api.test/users/${ids.user}/picture`, { headers: { authorization: bearerHeaders.user } });
    const staleLink = await app.request(`http://api.test/users/${ids.user}/picture?v=${firstVersion}`, { headers: { authorization: bearerHeaders.user } });

    expect(secondVersion).not.toBe(firstVersion);
    expect(pictures.pictures.size).toBe(1);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("etag")).toBe(`"${secondVersion}"`);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(samples.png);
    expect(staleLink.headers.get("cache-control")).toBe("private, no-cache");
    expect(new Uint8Array(await staleLink.arrayBuffer())).toEqual(samples.png);
  });

  it("carries the version on /me: null before an upload, the one the upload answered with after", async () => {
    const { app } = createTestApp();

    const before = await app.request("http://api.test/me", { headers: { authorization: bearerHeaders.user } });
    const version = await versionFrom(await upload(app, bearerHeaders.user, samples.jpeg));
    const after = await app.request("http://api.test/me", { headers: { authorization: bearerHeaders.user } });

    await expect(before.json()).resolves.toMatchObject({ user: { id: ids.user, pictureVersion: null } });
    expect(version).toEqual(expect.any(String));
    await expect(after.json()).resolves.toMatchObject({ user: { id: ids.user, pictureVersion: version } });
  });
});
