import { inject, Injectable, InjectionToken } from '@angular/core';
import { FetchBackend, HttpBackend, HttpRequest, HttpXhrBackend } from '@angular/common/http';
import { validateBounds } from './range-adapter';

export type R10Condition = 'r10.0' | 'r10.1' | 'r10.2';
export function selectR10Condition(value: unknown): R10Condition | null {
  if (value === undefined) return null;
  if (value === 'r10.0' || value === 'r10.1' || value === 'r10.2') return value;
  throw new Error('R10_INVALID_CONDITION');
}

interface AllowedFile { id: number; ciphertextBytes: number; }
export type RangeAllowlist = ReadonlyMap<string, AllowedFile>;
export const R10_RANGE_FILES = new InjectionToken<() => RangeAllowlist>('R10_RANGE_FILES');
const ORIGIN = 'http://127.0.0.1:42187';
const OTHER_HTTP = new Set([`POST ${ORIGIN}/login`, `GET ${ORIGIN}/tree?file_limit=100&file_offset=0`, `GET ${ORIGIN}/pending-uploads`]);

export function buildRangeAllowlist(files: readonly AllowedFile[]): RangeAllowlist {
  if (files.length !== 3 || new Set(files.map(file => file.id)).size !== 3 || files.some(file =>
    !Number.isSafeInteger(file.id) || file.id <= 0 || !Number.isSafeInteger(file.ciphertextBytes) || file.ciphertextBytes <= 0)) {
    throw new Error('R10_INVALID_RANGE_ALLOWLIST');
  }
  return new Map(files.map(file => [`${ORIGIN}/files/${file.id}/download`, { ...file }]));
}

export function inspectRangeRequest(request: Pick<HttpRequest<unknown>, 'method' | 'urlWithParams' | 'headers' | 'withCredentials'>,
  files: RangeAllowlist) {
  const range = request.headers.get('Range');
  if (range === null && OTHER_HTTP.has(`${request.method} ${request.urlWithParams}`)) return null;
  const file = files.get(request.urlWithParams);
  const match = range === null ? null : /^bytes=(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(range);
  if (!file || !match || request.method !== 'GET' || !request.headers.get('Authorization') || !request.withCredentials) {
    throw new Error('R10_FORBIDDEN_HTTP_BOUNDARY');
  }
  const start = Number(match[1]), end = Number(match[2]);
  validateBounds(start, end, file.ciphertextBytes);
  return { id: file.id, start, end, total: file.ciphertextBytes, url: request.urlWithParams };
}

@Injectable()
export class R10RangeBackend implements HttpBackend {
  readonly xhr = inject(HttpXhrBackend);
  readonly fetchBackend = inject(FetchBackend);
  readonly allowlist = inject(R10_RANGE_FILES);

  handle(request: HttpRequest<unknown>) {
    return inspectRangeRequest(request, this.allowlist()) ? this.fetchBackend.handle(request) : this.xhr.handle(request);
  }
}
