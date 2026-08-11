/** Maximum application-level block used for Drive HTTP transfer requests. */
export const DRIVE_TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;

/** Total wait budgets, explicitly selected by the request owner. */
export const DRIVE_CONTROL_REQUEST_DEADLINE_MS = 30_000;
export const DRIVE_CHUNK_REQUEST_DEADLINE_MS = 5 * 60_000;
