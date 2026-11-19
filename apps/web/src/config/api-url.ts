const LOCAL_API_URL = 'http://localhost:4111';

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
};

export const resolveApiUrl = (
  mode: string,
  configuredUrl: string | undefined,
): string => {
  const url = configuredUrl?.trim();
  if (mode === 'production' && (!url || !isHttpUrl(url)))
    throw new Error(
      'VITE_API_URL must be an absolute HTTP or HTTPS URL in production',
    );

  return url && isHttpUrl(url) ? url : LOCAL_API_URL;
};

/** The agent server origin every request and the auth client talk to. */
export const apiUrl: string = import.meta.env?.VITE_API_URL ?? LOCAL_API_URL;
