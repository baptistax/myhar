export const DEFAULT_NETWORK_QUIET_TIMEOUT_SECONDS = 15;

export function parseNetworkQuietTimeoutSeconds(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function isNetworkQuietMode(mode) {
  return mode === 'refresh' || mode === 'url-list';
}
