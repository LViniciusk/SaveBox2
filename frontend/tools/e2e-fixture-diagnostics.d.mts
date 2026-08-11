export function fixtureFailureCode(stderr: string): string | undefined;
export function formatFixtureFailure(command: 'provision' | 'cleanup', stderr: string): string;
export function parseFixtureResponse(command: 'provision' | 'cleanup', output: string): number[];
