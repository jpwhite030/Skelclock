/**
 * Backend client.
 *
 * The transport for the offline queue plus the handful of reads the clock
 * screen needs. Every call carries the Supabase access token; a 401 means the
 * session lapsed and the caller sends the worker back to the login screen.
 */

import Constants from 'expo-constants';

import type { IngestOutcomeDto, QueuedEvent, Transport } from './queue';

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

export interface WorkerHomeDto {
  employeeId: string;
  employeeName: string;
  workDate: string;
  clockState: 'off' | 'working' | 'on_break';
  timesheetId: string | null;
  timesheetStatus: string | null;
  assignedJob: {
    id: string;
    jobNumber: string;
    customerName: string | null;
    siteName: string | null;
    siteAddress: string | null;
    latitude: number | null;
    longitude: number | null;
    geofenceRadiusM: number;
    scheduledStart: string | null;
  } | null;
  currentJobId: string | null;
  currentActivityId: string | null;
  minutesWorked: number;
  hoursWorkedLabel: string;
  breakMinutes: number;
}

export interface JobOption {
  id: string;
  jobNumber: string;
  siteName: string | null;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number;
}

export interface ActivityOption {
  id: string;
  code: string;
  name: string;
  isTravel: boolean;
}

/** Who the current token belongs to, as the server resolves it. */
export interface MeDto {
  appUserId: string;
  employeeId: string | null;
  fullName: string | null;
  role: 'worker' | 'supervisor' | 'admin';
}

/** A geofence-raised clock event awaiting the worker's confirmation. */
export interface PendingSuggestionDto {
  id: string;
  eventType: 'clock_in' | 'clock_out';
  jobId: string | null;
  siteName: string | null;
  deviceTime: string;
}

export class ApiClient implements Transport {
  constructor(private readonly getToken: () => Promise<string | null>) {}

  private async request<T>(
    path: string,
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

    return (await response.json()) as T;
  }

  /** Transport for the offline queue. */
  async submit(events: QueuedEvent[]): Promise<IngestOutcomeDto[]> {
    const { outcomes } = await this.request<{ outcomes: IngestOutcomeDto[] }>(
      '/api/events',
      {
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
          })),
        }),
      },
    );
    return outcomes;
  }

  me(): Promise<MeDto> {
    return this.request<MeDto>('/api/me');
  }

  home(workDate: string): Promise<WorkerHomeDto> {
    return this.request<WorkerHomeDto>(`/api/home?date=${encodeURIComponent(workDate)}`);
  }

  jobs(): Promise<JobOption[]> {
    return this.request<JobOption[]>('/api/jobs');
  }

  activities(): Promise<ActivityOption[]> {
    return this.request<ActivityOption[]>('/api/activities');
  }

  confirmTimesheet(timesheetId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/timesheets/${timesheetId}/confirm`, {
      method: 'POST',
    });
  }

  /** Geofence-raised events waiting on this worker to confirm or dismiss. */
  pendingSuggestions(): Promise<PendingSuggestionDto[]> {
    return this.request<PendingSuggestionDto[]>('/api/events/suggested');
  }

  confirmSuggestion(eventId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/events/${eventId}/confirm`, {
      method: 'POST',
    });
  }

  dismissSuggestion(eventId: string, reason: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/events/${eventId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }
}
