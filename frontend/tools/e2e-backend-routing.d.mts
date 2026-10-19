export type E2EEnvironment = Record<string, string | undefined>;

export interface E2ERequest {
  url(): string;
}

export interface E2ERoute {
  request(): E2ERequest;
  continue(options?: { url?: string }): Promise<void>;
}

export interface E2EPage {
  route(
    matcher: string,
    handler: (route: E2ERoute) => Promise<void>,
  ): Promise<void>;
}

export function resolveE2EBackendOrigin(environment?: E2EEnvironment): string;
export function rewriteE2EBackendRequestUrl(sourceUrl: string, backendOrigin: string): string;
export function installE2EBackendRouting(page: E2EPage, environment?: E2EEnvironment): Promise<void>;
