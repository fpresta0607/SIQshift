import {
  activitySegmentBatchRequestSchema,
  activitySegmentBatchResponseSchema,
  APP_VERSION_HEADER,
  appVersionSchema,
} from "@siqshift/shared";
import { Hono } from "hono";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { ActivityService } from "../services/activity.js";

async function requestBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new AppError("validation_error", "Invalid request body.");
  }
}

function requestAppVersion(context: { req: { header(name: string): string | undefined } }): string | null {
  const header = context.req.header(APP_VERSION_HEADER);
  if (header === undefined) return null;
  const parsed = appVersionSchema.safeParse(header);
  if (!parsed.success) throw new AppError("validation_error", `Invalid ${APP_VERSION_HEADER} header.`);
  return parsed.data;
}

export function createActivityRoutes(service: ActivityService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post("/segments", async (context) => {
    const appVersion = requestAppVersion(context);
    const input = activitySegmentBatchRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const result = await service.upload(getAuthenticatedSubject(context), input.data.segments.map((segment) => ({
      clientId: segment.clientId,
      deviceId: segment.deviceId,
      kind: segment.kind,
      ...(segment.processName === undefined ? {} : { processName: segment.processName }),
      startedAt: new Date(segment.startedAt),
      endedAt: new Date(segment.endedAt),
    })), appVersion);
    return context.json(activitySegmentBatchResponseSchema.parse(result));
  });
  return routes;
}
