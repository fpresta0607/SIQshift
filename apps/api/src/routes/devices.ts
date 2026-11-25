import { deviceListFiltersSchema, deviceListResponseSchema } from "@siqshift/shared";
import { Hono } from "hono";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { DeviceRepository } from "../repositories.js";

export function createDeviceRoutes(repository: DeviceRepository): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get("/", async (context) => {
    const filters = deviceListFiltersSchema.safeParse(context.req.query());
    if (!filters.success) throw new AppError("validation_error", "Invalid device filters.");
    const subject = getAuthenticatedSubject(context);
    const userId = filters.data.userId ?? subject.userId;
    if (userId !== subject.userId && subject.role !== "admin") {
      throw new AppError("forbidden", "Only a workspace administrator can read a teammate's devices.");
    }
    const records = await repository.listForUser(subject.organizationId, userId);
    return context.json(deviceListResponseSchema.parse({
      devices: records.map((record) => ({
        id: record.id,
        appVersion: record.appVersion,
        lastSeenAt: record.lastSeenAt.toISOString(),
      })),
    }));
  });
  return routes;
}
