/** Only credential-free HTTPS and SSH transports are accepted by web setup. */
export function repositoryUrl(value: string): string {
  const url = value.trim();
  const invalid = () => {
    throw new Error(
      'Invalid repository URL. Use an HTTPS or SSH Git URL without a password or token.',
    );
  };
  if (!url || url.length > 2048 || /[\s\x00-\x1f\x7f]/.test(url)) return invalid();
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./~-]+$/.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (
      !['https:', 'ssh:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname === '/' ||
      !parsed.pathname ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol === 'https:' && parsed.username) ||
      (parsed.username && !/^[a-zA-Z0-9._-]+$/.test(parsed.username))
    )
      return invalid();
    return url;
  } catch {
    return invalid();
  }
}
