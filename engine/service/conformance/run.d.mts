export const DEFAULT_FIXTURE_DIR: string;
export const FIXTURES: string[];
export function checkShape(body: unknown): string[];
export function checkPortable(expected: Record<string, unknown>, body: Record<string, unknown>): string[];
export function runAll(options: {
  url: string;
  token?: string;
  fixtureDir?: string;
  names?: string[];
  fetchImpl?: typeof fetch;
}): Promise<Array<{ name: string; failures: string[] }>>;
export function main(
  argv?: string[],
  env?: Record<string, string | undefined>,
  out?: (line: string) => void
): Promise<number>;
