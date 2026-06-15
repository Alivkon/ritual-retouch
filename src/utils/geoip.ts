interface GeoResult { country: string; city: string }

const cache = new Map<string, GeoResult>();

function isPrivate(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
    || ip.startsWith('10.') || ip.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || ip.startsWith('::ffff:127.');
}

export async function resolveGeoIps(ips: string[]): Promise<Map<string, GeoResult>> {
  const toFetch = [...new Set(ips)].filter(ip => !isPrivate(ip) && !cache.has(ip));

  if (toFetch.length > 0) {
    try {
      const res = await fetch('http://ip-api.com/batch?fields=query,status,country,city', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toFetch.slice(0, 100).map(ip => ({ query: ip }))),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json() as Array<{ query: string; status: string; country?: string; city?: string }>;
      for (const row of data) {
        cache.set(row.query, row.status === 'success'
          ? { country: row.country ?? '', city: row.city ?? '' }
          : { country: '', city: '' });
      }
    } catch {
      for (const ip of toFetch) cache.set(ip, { country: '', city: '' });
    }
  }

  const out = new Map<string, GeoResult>();
  for (const ip of ips) {
    out.set(ip, isPrivate(ip) ? { country: 'local', city: '' } : (cache.get(ip) ?? { country: '', city: '' }));
  }
  return out;
}
