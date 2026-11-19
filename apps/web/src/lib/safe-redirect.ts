/** Accept only application-local absolute paths. */
export const safeRedirect = (value: string | undefined): string => {
  if (
    !value?.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  ) {
    return '/';
  }

  return value;
};
