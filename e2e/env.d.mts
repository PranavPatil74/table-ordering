export const E2E_PORT: number;
export const FAKE_SUPABASE_PORT: number;
export const E2E_PUBLIC_PORT: number;
export const E2E_DIST_DIR: string;
export const E2E_ENV: Record<string, string>;
export const E2E_PUBLIC_ENV: Record<string, string>;
export const E2E_PASSWORD: string;
export const E2E_ACCOUNTS: {
  readonly counter: string;
  readonly manager: string;
  readonly inactive: string;
  readonly noProfile: string;
  readonly limited: string;
  readonly outage: string;
};
export const PROJECT_ROOT: string;
export function declaredEnvNames(root?: string): Set<string>;
export function isolatedEnv(
  overrides: Record<string, string>,
  options?: { base?: Record<string, string | undefined>; root?: string },
): Record<string, string>;
export function requireProjectRoot(root?: string): void;
export const MARKER_FILE: string;
export const MARKER_KIND: string;
