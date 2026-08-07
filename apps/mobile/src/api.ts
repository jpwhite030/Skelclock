/**
 * Backend client.
 *
 * The transport for the offline queue plus the handful of reads the clock
 * screen needs. Every call carries the Supabase access token; a 401 means the
 * session lapsed and the caller sends the worker back to the login screen.
 *
 * Every response is parsed against the same zod schema apps/web validates its
 * response with (@skelclock/contracts) — if a route ever stops matching the
 * contract, this throws on the very next fetch in dev rather than the app
 * quietly misreading a field on a worker's phone.
 */

import Constants from 'expo-constants';
import { z } from 'zod';

import {
  activitiesResponseSchema,
  deviceCheckinResponseSchema,
  geofenceConsentResponseSchema,
  ingestResponseSchema,
  jobsResponseSchema,
  pendingSuggestionsResponseSchema,
  suggestionActionResponseSchema,
  timesheetActionResponseSchema,
  workerHomeSchema,
  type ActivityDto,
  type DeviceCheckinRequestDto,
  type GeofenceConsentRequestDto,
  type IngestOutcomeDto,
  type JobDto,
  type PendingSuggestionDto,
  type WorkerHomeDto,
} from '@skelclock/contracts';

import type { QueuedEvent, Transport } from './queue';

export type { ActivityDto, JobDto, PendingSuggestionDto, WorkerHomeDto };
// Kept as the names the rest of the mobile app already imports.
export type ActivityOption = ActivityDto;
export type JobOption = JobDto;

const BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  process.env.EXPO_PUBLIC_API_URL ??
  'http://localhost:3000';

/** Short, because a worker standing in the rain should not wait on a hang. */
const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when retrying might work — the queue keeps the event if so. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient implements Transport {
  constructor(private readonly getToken: () => Promise<string | null>) {}

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const token = await this.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      });
    } catch (cause) {
      // Aborts and DNS failures land here. Both are "no reception" as far as
      // the queue is concerned, so they must throw rather than return.
      throw new ApiError(
        cause instanceof Error && cause.name === 'AbortError'
          ? 'Request timed out'
          : 'No connection',
        0,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      throw new ApiError('Your session has expired. Sign in again.', 401, false);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ApiError(
        body || `Request failed (${response.status})`,
        response.status,
        // 5xx and 429 are worth retrying; a 4xx will fail identically forever.
        response.status >= 500 || response.status === 429,
      );
    }

    const json = await response.json();
    // A route that stops matching the contract is a bug worth surfacing
    // loudly, not a malformed-JSON case — so this is not caught as ApiError.
    return schema.parse(json);
  }

  /** Transport for the offline queue. */
  async submit(events: QueuedEvent[]): Promise<IngestOutcomeDto[]> {
    const { outcomes } = await this.request('/api/events', ingestResponseSchema, {
      method: 'POST',
      body: JSON.stringify({
        events: events.map((e) => ({
          idempotencyKey: e.idempotencyKey,
          employeeId: e.employeeId,
          eventType: e.eventType,
          deviceTime: e.deviceTime,
          jobId: e.jobId,
          workActivityId: e.workActivityId,
          latitude: e.latitude,
          longitude: e.longitude,
          gpsAccuracyM: e.gpsAccuracyM,
          outsideReason: e.outsideReason,
          clockMethod: e.clockMethod,
          wasOffline: e.wasOffline,
          deviceId: e.deviceId,
          candidateJobIds: e.candidateJobIds,
        })),
      }),
    });
    return outcomes;
  }

  home(workDate: string): Promise<WorkerHomeDto> {
    return this.request(`/api/home?date=${encodeURIComponent(workDate)}`, workerHomeSchema);
  }

  jobs(): Promise<JobDto[]> {
    return this.request('/api/jobs', jobsResponseSchema);
  }

  activities(): Promise<ActivityDto[]> {
    return this.request('/api/activities', activitiesResponseSchema);
  }

  confirmTimesheet(timesheetId: string) {
    return this.request(`/api/timesheets/${timesheetId}`, timesheetActionResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ action: 'confirm' }),
    });
  }

  /** Geofence-raised events waiting on this worker to confirm or dismiss. */
  pendingSuggestions(): Promise<PendingSuggestionDto[]> {
    return this.request('/api/events/suggested', pendingSuggestionsResponseSchema);
  }

  /** jobId only matters for an ambiguous suggestion — picking which of the
   * candidate sites the worker meant. */
  confirmSuggestion(eventId: string, jobId?: string) {
    return this.request(`/api/events/${eventId}/confirm`, suggestionActionResponseSchema, {
      method: 'POST',
      body: JSON.stringify(jobId ? { jobId } : {}),
    });
  }

  dismissSuggestion(eventId: string, reason: string) {
    return this.request(`/api/events/${eventId}/reject`, suggestionActionResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  /** A check-in, not a registration — safe and cheap to call often. */
  checkinDevice(input: DeviceCheckinRequestDto) {
    return this.request('/api/device', deviceCheckinResponseSchema, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** The audit trail behind the notice a worker agrees to before auto-detect starts. */
  recordGeofenceConsent(input: GeofenceConsentRequestDto) {
    return this.request('/api/geofence-consent', geofenceConsentResponseSchema, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
}
