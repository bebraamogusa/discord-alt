import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbedService } from '../services/embedService.js';

function response(status, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
  };
}

describe('embed SSRF protection', () => {
  it('rejects IPv4 and IPv6 special-use hosts directly', () => {
    const service = buildEmbedService();

    for (const url of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:192.168.1.1]/',
    ]) {
      assert.equal(service.normalizeUrl(url), null, url);
    }
  });

  it('rejects a public hostname whose DNS answer is private', async () => {
    let fetchCalls = 0;
    const service = buildEmbedService({
      lookup: async () => [{ address: '10.0.0.8', family: 4 }],
      fetchImpl: async () => {
        fetchCalls += 1;
        return response(200);
      },
    });

    await assert.rejects(service.fetchPublic('https://public.example/'), /private address/);
    assert.equal(fetchCalls, 0);
  });

  it('does not follow a public redirect into a private target', async () => {
    const fetched = [];
    const service = buildEmbedService({
      lookup: async (hostname) => {
        if (hostname === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
        return [{ address: '127.0.0.1', family: 4 }];
      },
      fetchImpl: async (url) => {
        fetched.push(url);
        return response(302, { location: 'http://private.example/secret' });
      },
    });

    await assert.rejects(service.fetchPublic('https://public.example/'), /private address/);
    assert.deepEqual(fetched, ['https://public.example/']);
  });
});
