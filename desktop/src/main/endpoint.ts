import path from 'node:path';
import { readLegacyConfig } from './legacyConfig';

/** The only service the app talks to. It is not a setting: the user supplies a key, nothing else. */
export const ALIA_ENDPOINT = 'https://chat.alia.atlantico.com.br/api/';

/**
 * The address to use. In production it is always ALIA_ENDPOINT. Under test (ALIA_DESKTOP_TEST=1) it can point at a fake
 * server: ALIA_TEST_ENDPOINT, or else the address in the ALIA_CONFIG file that seeds the test's settings.
 */
export function resolveEndpoint(env: NodeJS.ProcessEnv, testMode: boolean): string {
  if (!testMode) return ALIA_ENDPOINT;
  if (env.ALIA_TEST_ENDPOINT) return env.ALIA_TEST_ENDPOINT;
  if (env.ALIA_CONFIG) {
    try {
      return readLegacyConfig(path.resolve(env.ALIA_CONFIG), {}).endpointUrl;
    } catch {
      /* not a usable file: the fixed address */
    }
  }
  return ALIA_ENDPOINT;
}
