/** `GET /api/v1/health` (public): overall status only (FR-OPS-007). */
export interface HealthResponse {
  status: 'ok' | 'degraded';
}
