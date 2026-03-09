export function buildSystemKbUrl(systemId: string | undefined): string {
  if (!systemId) return ''
  return `https://rsned.github.io/spacemolt-kb/systems/${encodeURIComponent(systemId)}.html`
}
