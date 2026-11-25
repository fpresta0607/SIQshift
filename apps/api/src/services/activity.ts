import type { ActivitySegmentBatchResponse, ActivitySegmentKind } from "@siqshift/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type { ActivitySegmentInsert, ActivitySegmentRepository, DeviceRepository } from "../repositories.js";
import { RETENTION_WINDOW_MS } from "./utc-days.js";

const futureEndToleranceMs = 30_000;
const maxSegmentSpanMs = 24 * 60 * 60 * 1_000;

export interface ActivitySegmentInput {
  clientId: string;
  deviceId: string;
  kind: ActivitySegmentKind;
  processName?: string;
  startedAt: Date;
  endedAt: Date;
}

export interface ActivityServiceDependencies {
  segments: ActivitySegmentRepository;
  devices?: DeviceRepository;
  /**
   * Called with the instants a successful upload touched, so the finished UTC
   * days among them can be folded.
   *
   * A plain callback rather than the rollup service itself: the fold reads
   * agent-session intervals, and importing it here would make this module and
   * that one import each other. The composition root supplies it and owns the
   * decision that a cache-maintenance failure must not fail an upload.
   */
  onUploaded?: (subject: AuthenticatedSubject, instants: readonly Date[]) => Promise<void>;
  clock?: () => Date;
}

export interface ActivityService {
  /** `appVersion` is the build that sent the batch; null for one too old to say. */
  upload(
    subject: AuthenticatedSubject,
    segments: ActivitySegmentInput[],
    appVersion: string | null,
  ): Promise<ActivitySegmentBatchResponse>;
}

function rejectionReason(segment: ActivitySegmentInput, now: Date): string | null {
  const start = segment.startedAt.getTime();
  const end = segment.endedAt.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "timestamps are invalid";
  if (end <= start) return "endedAt must be after startedAt";
  if (end > now.getTime() + futureEndToleranceMs) return "endedAt is too far in the future";
  if (end < now.getTime() - RETENTION_WINDOW_MS) return "endedAt is older than the retention window";
  if (end - start > maxSegmentSpanMs) return "segment spans more than 24 hours";
  return null;
}

export function createActivityService(dependencies: ActivityServiceDependencies): ActivityService {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async upload(
      subject: AuthenticatedSubject,
      segments: ActivitySegmentInput[],
      appVersion: string | null,
    ): Promise<ActivitySegmentBatchResponse> {
      const now = clock();
      const valid: ActivitySegmentInsert[] = [];
      const rejected: ActivitySegmentBatchResponse["rejected"] = [];
      for (const segment of segments) {
        const reason = rejectionReason(segment, now);
        if (reason !== null) {
          rejected.push({ clientId: segment.clientId, reason });
          continue;
        }
        valid.push({
          organizationId: subject.organizationId,
          userId: subject.userId,
          clientId: segment.clientId,
          deviceId: segment.deviceId,
          kind: segment.kind,
          processName: segment.processName ?? null,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          receivedAt: now,
        });
      }
      // Replayed client ids are ignored by the repository, so a replay counts as accepted.
      await dependencies.segments.insertBatch(valid);
      // Every segment names its machine, rejected ones included: they still prove it uploaded.
      await dependencies.devices?.recordSeen({
        organizationId: subject.organizationId,
        userId: subject.userId,
        deviceIds: [...new Set(segments.map((segment) => segment.deviceId))],
        appVersion,
        seenAt: now,
      });
      await dependencies.onUploaded?.(subject, valid.flatMap((segment) => [segment.startedAt, segment.endedAt]));
      return { accepted: valid.length, rejected };
    },
  };
}
