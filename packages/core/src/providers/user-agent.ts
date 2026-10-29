const PROMA_REPO_URL = 'https://github.com/brattmian794-lang/pi-agent'

let _promaVersion = '0.0.0'

export function setPromaVersion(version: string): void {
  _promaVersion = version
}

export function getPromaVersion(): string {
  return _promaVersion
}

export function getPromaUserAgent(version?: string): string {
  const v = version ?? _promaVersion
  return `pi-agent/${v} (+${PROMA_REPO_URL})`
}
