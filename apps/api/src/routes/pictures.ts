import { createHash } from "node:crypto";

import { meResponseSchema, PICTURE_MAX_BYTES, pictureTypeOf } from "@siqshift/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError, jsonError } from "../errors.js";
import type { PictureRepository } from "../repositories.js";

const userIdSchema = z.string().uuid();

/**
 * Profile pictures, by upload only. A member writes their own picture and no
 * one else's: the write path names no user id. The bytes leave the database on
 * the read below and nowhere else, and a read that names the current version
 * is cached for good, so a dashboard polling its members never fetches a
 * picture twice.
 */
export function createPictureRoutes(repository: PictureRepository): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();

  routes.put(
    "/me/picture",
    bodyLimit({
      maxSize: PICTURE_MAX_BYTES,
      onError: (context) => jsonError(context, new AppError("validation_error", "Request body is too large."), 413),
    }),
    async (context) => {
      // The bytes decide the type: a declared Content-Type is never trusted.
      const bytes = new Uint8Array(await context.req.arrayBuffer());
      const contentType = pictureTypeOf(bytes);
      if (contentType === null) throw new AppError("validation_error", "A picture must be a JPEG, PNG or WebP image.");
      const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      await repository.save(getAuthenticatedSubject(context), { contentType, bytes, version });
      return context.json(meResponseSchema.parse({ user: { ...context.get("authenticatedUser"), pictureVersion: version } }));
    },
  );

  routes.delete("/me/picture", async (context) => {
    await repository.remove(getAuthenticatedSubject(context));
    return context.json(meResponseSchema.parse({ user: { ...context.get("authenticatedUser"), pictureVersion: null } }));
  });

  routes.get("/users/:userId/picture", async (context) => {
    const userId = userIdSchema.safeParse(context.req.param("userId"));
    const picture = userId.success ? await repository.find(getAuthenticatedSubject(context), userId.data) : null;
    if (picture === null) throw new AppError("not_found", "Picture not found.");
    context.header("content-type", picture.contentType);
    context.header("etag", `"${picture.version}"`);
    // A URL naming the current version can never change under it; any other
    // is revalidated, so a stale link cannot pin an old picture.
    context.header(
      "cache-control",
      context.req.query("v") === picture.version ? "private, max-age=31536000, immutable" : "private, no-cache",
    );
    return context.body(new Uint8Array(picture.bytes));
  });

  return routes;
}
