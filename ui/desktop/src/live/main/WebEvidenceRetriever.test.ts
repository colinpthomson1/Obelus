import { describe, expect, it, vi } from 'vitest';
import {
  SecureWebTransport,
  WebEvidenceRetriever,
  canonicalizePublicUrl,
  isPublicIpAddress,
  parseDuckDuckGoResults,
  webQueriesForClaim,
} from './WebEvidenceRetriever';

const accessedAtMs = Date.parse('2026-08-10T18:00:00.000Z');

function response(
  url: string,
  body: string,
  options: { statusCode?: number; contentType?: string; location?: string } = {}
) {
  return {
    url: new URL(url),
    statusCode: options.statusCode ?? 200,
    headers: {
      'content-type': options.contentType ?? 'text/html; charset=utf-8',
      ...(options.location ? { location: options.location } : {}),
    },
    body: new TextEncoder().encode(body),
  };
}

describe('WebEvidenceRetriever', () => {
  it('turns broad web results into a citation inventory that refutes the Moon comparison', async () => {
    const html = `
      <a class="result__a" href="https://example.com/opinion">An opinion</a>
      <a class="result__snippet">A generic discussion without measurements.</a>
      <a rel="nofollow" class="result__a" href="https://science.nasa.gov/moon/by-the-numbers/?utm_source=search#size">Compare Earth and the Moon - NASA Science</a>
      <a class="result__snippet">The Moon is 3.7 times smaller than Earth, with a diameter of 3,475 kilometers.</a>
    `;
    const request = vi.fn(
      async (_url: URL, _options: Parameters<SecureWebTransport['request']>[1]) =>
        response('https://html.duckduckgo.com/html/', html)
    );
    const retriever = new WebEvidenceRetriever({
      now: () => accessedAtMs,
      transport: { request },
    });

    const result = await retriever.retrieve('The Moon is larger than the Earth', 'quick');

    expect(result).toMatchObject({
      provider: 'DuckDuckGo HTML',
      queryCount: 1,
      requestFailures: 0,
    });
    expect(result.items[0]).toEqual({
      url: 'https://science.nasa.gov/moon/by-the-numbers/',
      canonicalUrl: 'https://science.nasa.gov/moon/by-the-numbers/',
      publisher: 'NASA',
      title: 'Compare Earth and the Moon - NASA Science',
      publicationDate: null,
      accessedAt: '2026-08-10T18:00:00.000Z',
      excerpt: 'The Moon is 3.7 times smaller than Earth, with a diameter of 3,475 kilometers.',
      retrievalKind: 'search_snippet',
    });
    const submittedBody = request.mock.calls[0]?.[1].body as string;
    expect(new URLSearchParams(submittedBody).get('q')).toBe(
      'The Moon is larger than the Earth size measurement comparison official data'
    );
    expect(submittedBody).not.toContain('meeting');
  });

  it('deep mode extracts relevant text and falls back to the snippet when a page fails', async () => {
    const searchHtml = `
      <a class="result__a" href="https://science.nasa.gov/moon/by-the-numbers/">NASA measurements</a>
      <a class="result__snippet">NASA reports that Earth is substantially larger than the Moon.</a>
      <a class="result__a" href="https://example.org/blocked">Blocked source</a>
      <a class="result__snippet">The Moon is smaller than Earth.</a>
    `;
    const request = vi.fn(async (url: URL) => {
      if (url.hostname === 'html.duckduckgo.com') {
        return response(url.toString(), searchHtml);
      }
      if (url.hostname === 'science.nasa.gov') {
        return response(
          url.toString(),
          '<html><main><p>The Moon has a diameter of 3,475 kilometers.</p><p>Earth has a diameter of 12,756 kilometers.</p><p>Unrelated navigation copy.</p></main></html>'
        );
      }
      throw new Error('blocked');
    });
    const retriever = new WebEvidenceRetriever({
      now: () => accessedAtMs,
      transport: { request },
    });

    const result = await retriever.retrieve('The Moon is larger than the Earth', 'deep');

    expect(result.queryCount).toBe(2);
    expect(result.requestFailures).toBe(1);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.retrievalKind).toBe('page_extract');
    expect(result.items[0]?.excerpt).toContain('Moon has a diameter of 3,475 kilometers');
    expect(result.items[0]?.excerpt).toContain('Earth has a diameter of 12,756 kilometers');
    expect(result.items[1]).toMatchObject({
      publisher: 'example.org',
      retrievalKind: 'search_snippet',
      excerpt: 'The Moon is smaller than Earth.',
    });
  });

  it('does not misclassify every comparison as a company query', () => {
    expect(webQueriesForClaim('The Moon is larger than the Earth', 'quick', 2026)).toEqual([
      'The Moon is larger than the Earth size measurement comparison official data',
    ]);
    expect(
      webQueriesForClaim('Barnes & Noble is a bigger company than Amazon', 'quick', 2026)
    ).toEqual([
      'Barnes & Noble is a bigger company than Amazon revenue employees annual report official data',
      'Barnes & Noble official corporate site investor relations revenue employees 2026',
      'Amazon official corporate site investor relations revenue employees 2026',
    ]);
  });

  it('reserves authoritative entity-aligned sources for Barnes & Noble and Amazon', async () => {
    const comparisonResults = `
      <a class="result__a" href="https://scaleclaims.org/amazon-barnes-noble">Company scale rankings</a>
      <a class="result__snippet">An uncited ranking says Amazon and Barnes & Noble differ in size.</a>
      <a class="result__a" href="https://www.zippia.com/barnes-noble/revenue/">Barnes & Noble revenue</a>
      <a class="result__snippet">Barnes & Noble revenue is estimated at $1.6 billion.</a>
    `;
    const barnesAndNobleResults = `
      <a class="result__a" href="https://investor.bned.com/annual-report">Barnes & Noble Education annual report</a>
      <a class="result__snippet">Barnes & Noble Education reported $1.7 billion in revenue.</a>
      <a class="result__a" href="https://www.barnesandnobleinc.com/about-bn/">About Barnes & Noble | B&N, INC</a>
      <a class="result__snippet">Barnes & Noble, Inc. is the largest U.S. retail bookseller with approximately 700 bookstores.</a>
      <a class="result__a" href="https://compworth.com/company/barnes-and-noble">Barnes and Noble revenue estimate</a>
      <a class="result__snippet">Barnes and Noble has estimated revenue of $180.5 million and 1,200 employees.</a>
    `;
    const amazonResults = `
      <a class="result__a" href="https://makerstations.io/amazon-statistics">Amazon employee statistics</a>
      <a class="result__snippet">A third-party estimate lists 1.5 million Amazon employees.</a>
      <a class="result__a" href="https://ir.aboutamazon.com/overview/default.aspx">Amazon.com, Inc. - Overview</a>
      <a class="result__snippet">Amazon announced first-quarter net sales of $181.5 billion.</a>
      <a class="result__a" href="https://corporatefacts.org/amazon">Amazon official-looking facts</a>
      <a class="result__snippet">An unaffiliated organization describes Amazon's revenue.</a>
    `;
    const request = vi.fn(
      async (_url: URL, options: Parameters<SecureWebTransport['request']>[1]) => {
        const query = new URLSearchParams(options.body).get('q') ?? '';
        const html = query.startsWith('Barnes & Noble is')
          ? comparisonResults
          : query.startsWith('Barnes & Noble official')
            ? barnesAndNobleResults
            : amazonResults;
        return response('https://html.duckduckgo.com/html/', html);
      }
    );
    const retriever = new WebEvidenceRetriever({
      now: () => accessedAtMs,
      transport: { request },
    });

    const result = await retriever.retrieve(
      'Barnes & Noble is a bigger company than Amazon',
      'quick'
    );

    expect(result.items).toHaveLength(7);
    expect(result.items.slice(0, 2).map((item) => item.canonicalUrl)).toEqual([
      'https://www.barnesandnobleinc.com/about-bn/',
      'https://ir.aboutamazon.com/overview/default.aspx',
    ]);
    expect(result.items.some((item) => item.canonicalUrl.includes('investor.bned.com'))).toBe(
      false
    );
    expect(result.items.findIndex((item) => item.publisher === 'scaleclaims.org')).toBeGreaterThan(
      result.items.findIndex((item) => item.publisher === 'ir.aboutamazon.com')
    );
  });

  it('drops a stray transcript fragment before a company comparison entity', async () => {
    const claim = 'Earth, Barnes & Noble is a bigger company than Amazon.';
    const barnesAndNobleResults = `
      <a class="result__a" href="https://www.barnesandnobleinc.com/about-bn/">About Barnes & Noble | B&N, INC</a>
      <a class="result__snippet">Barnes & Noble, Inc. is the largest U.S. retail bookseller with approximately 700 bookstores.</a>
    `;
    const amazonResults = `
      <a class="result__a" href="https://ir.aboutamazon.com/overview/default.aspx">Amazon.com, Inc. - Overview</a>
      <a class="result__snippet">Amazon announced first-quarter net sales of $181.5 billion.</a>
    `;
    const request = vi.fn(
      async (_url: URL, options: Parameters<SecureWebTransport['request']>[1]) => {
        const query = new URLSearchParams(options.body).get('q') ?? '';
        const html = query.startsWith('Barnes & Noble official')
          ? barnesAndNobleResults
          : query.startsWith('Amazon official')
            ? amazonResults
            : '<div class="result results_links result--no-result">No results found</div>';
        return response('https://html.duckduckgo.com/html/', html);
      }
    );
    const retriever = new WebEvidenceRetriever({
      now: () => accessedAtMs,
      transport: { request },
    });

    expect(webQueriesForClaim(claim, 'quick', 2026)).toEqual([
      'Earth, Barnes & Noble is a bigger company than Amazon. revenue employees annual report official data',
      'Barnes & Noble official corporate site investor relations revenue employees 2026',
      'Amazon official corporate site investor relations revenue employees 2026',
    ]);
    expect(
      webQueriesForClaim('Barnes & Noble, Inc. is a bigger company than Amazon', 'quick', 2026)
    ).toContain(
      'Barnes & Noble, Inc official corporate site investor relations revenue employees 2026'
    );

    const result = await retriever.retrieve(claim, 'quick');

    expect(request).toHaveBeenCalledTimes(3);
    expect(
      request.mock.calls
        .map(([, options]) => new URLSearchParams(options.body).get('q'))
        .filter((query) => query?.includes('official corporate site'))
    ).toEqual([
      'Barnes & Noble official corporate site investor relations revenue employees 2026',
      'Amazon official corporate site investor relations revenue employees 2026',
    ]);
    expect(result.items.map((item) => item.canonicalUrl)).toEqual([
      'https://www.barnesandnobleinc.com/about-bn/',
      'https://ir.aboutamazon.com/overview/default.aspx',
    ]);
  });

  it('classifies an HTTP 200 challenge as a retryable provider request failure', async () => {
    const challenge = `
      <!doctype html>
      <html>
        <form id="anomaly-modal" action="//duckduckgo.com/anomaly.js">
          <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
        </form>
      </html>
    `;
    const retriever = new WebEvidenceRetriever({
      now: () => accessedAtMs,
      transport: {
        request: async () => response('https://html.duckduckgo.com/html/', challenge),
      },
    });

    await expect(retriever.retrieve('The Moon is larger than the Earth', 'quick')).resolves.toEqual(
      {
        provider: 'DuckDuckGo HTML',
        queryCount: 1,
        requestFailures: 1,
        items: [],
      }
    );
  });

  it('recognizes DuckDuckGo explicit no-results markup as a successful empty search', async () => {
    const noResults = `
      <!doctype html>
      <html>
        <div class="result results_links result--no-result">
          <h1>No results found for <strong>site:invalid.invalid obelus-test</strong></h1>
        </div>
      </html>
    `;
    const retriever = new WebEvidenceRetriever({
      now: () => accessedAtMs,
      transport: {
        request: async () => response('https://html.duckduckgo.com/html/', noResults),
      },
    });

    await expect(retriever.retrieve('site:invalid.invalid obelus-test', 'quick')).resolves.toEqual({
      provider: 'DuckDuckGo HTML',
      queryCount: 1,
      requestFailures: 0,
      items: [],
    });
  });

  it('treats unknown HTTP 200 markup with no results as a request failure', async () => {
    const retriever = new WebEvidenceRetriever({
      now: () => accessedAtMs,
      transport: {
        request: async () =>
          response(
            'https://html.duckduckgo.com/html/',
            '<!doctype html><html><p>Search layout changed.</p></html>'
          ),
      },
    });

    const result = await retriever.retrieve('A nonempty claim', 'quick');

    expect(result.requestFailures).toBe(1);
    expect(result.items).toEqual([]);
  });
});

describe('DuckDuckGo result parsing', () => {
  it('unwraps redirects, decodes entities, rejects HTTP and strips tracking parameters', () => {
    const html = `
      <a class='result__a' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nasa.gov%2Fmoon%3Futm_source%3Dddg%26id%3D1&amp;rut=secret'>Moon &amp; Earth</a>
      <a class='result__snippet'>The Moon is &lt;strong&gt;smaller&lt;/strong&gt; than Earth&#x27;s globe.</a>
      <a class='result__a' href='http://127.0.0.1/private'>Private</a>
      <a class='result__snippet'>Must not be returned.</a>
    `;

    expect(parseDuckDuckGoResults(html)).toEqual([
      {
        title: 'Moon & Earth',
        url: new URL('https://www.nasa.gov/moon?id=1'),
        snippet: "The Moon is <strong>smaller</strong> than Earth's globe.",
        rank: 0,
      },
    ]);
  });
});

describe('SecureWebTransport', () => {
  it('pins the validated public DNS address and validates every redirect target', async () => {
    const resolveHost = vi.fn(async (hostname: string) =>
      hostname === 'source.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '142.250.72.14', family: 4 }]
    );
    const rawRequest = vi
      .fn()
      .mockResolvedValueOnce(
        response('https://source.example/start', '', {
          statusCode: 302,
          location: 'https://target.example/final',
        })
      )
      .mockResolvedValueOnce(response('https://target.example/final', 'evidence'));
    const transport = new SecureWebTransport({ resolveHost, rawRequest });

    const result = await transport.request(new URL('https://source.example/start'), {
      maxBytes: 100,
      timeoutMs: 1_000,
      contentTypes: new Set(['text/html']),
    });

    expect(result.url.toString()).toBe('https://target.example/final');
    expect(resolveHost).toHaveBeenCalledWith('source.example');
    expect(resolveHost).toHaveBeenCalledWith('target.example');
    expect(rawRequest.mock.calls[0]?.[0].address.address).toBe('93.184.216.34');
    expect(rawRequest.mock.calls[1]?.[0].address.address).toBe('142.250.72.14');
  });

  it('does not send cookies, credentials, or referrers to evidence hosts', async () => {
    const rawRequest = vi.fn(async (options) => response(options.url.toString(), 'evidence'));
    const transport = new SecureWebTransport({
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      rawRequest,
    });

    await transport.request(new URL('https://public.example/evidence'), {
      headers: {
        Accept: 'text/html',
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        Referer: 'https://private.example/meeting',
      },
      maxBytes: 100,
      timeoutMs: 1_000,
      contentTypes: new Set(['text/html']),
    });

    expect(rawRequest.mock.calls[0]?.[0].headers).toEqual({ Accept: 'text/html' });
  });

  it('blocks private, loopback, link-local, mixed public/private DNS, and redirect rebinding', async () => {
    for (const address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '::1', 'fc00::1']) {
      const rawRequest = vi.fn();
      const transport = new SecureWebTransport({
        resolveHost: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
        rawRequest,
      });
      await expect(
        transport.request(new URL('https://public.example/path'), {
          maxBytes: 100,
          timeoutMs: 1_000,
          contentTypes: new Set(['text/html']),
        })
      ).rejects.toThrow('host is not public');
      expect(rawRequest).not.toHaveBeenCalled();
    }

    const mixed = new SecureWebTransport({
      resolveHost: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      rawRequest: vi.fn(),
    });
    await expect(
      mixed.request(new URL('https://public.example/path'), {
        maxBytes: 100,
        timeoutMs: 1_000,
        contentTypes: new Set(['text/html']),
      })
    ).rejects.toThrow('host is not public');

    const redirectRequest = vi.fn().mockResolvedValueOnce(
      response('https://public.example/path', '', {
        statusCode: 302,
        location: 'https://metadata.internal/latest',
      })
    );
    const rebinding = new SecureWebTransport({
      resolveHost: async (hostname) => [
        {
          address: hostname === 'metadata.internal' ? '169.254.169.254' : '93.184.216.34',
          family: 4,
        },
      ],
      rawRequest: redirectRequest,
    });
    await expect(
      rebinding.request(new URL('https://public.example/path'), {
        maxBytes: 100,
        timeoutMs: 1_000,
        contentTypes: new Set(['text/html']),
      })
    ).rejects.toThrow('host is not public');
    expect(redirectRequest).toHaveBeenCalledTimes(1);
  });

  it('does not forward a private search body across a cross-origin redirect', async () => {
    const rawRequest = vi.fn(async () =>
      response('https://html.duckduckgo.com/html/', '', {
        statusCode: 307,
        location: 'https://collector.example/search',
      })
    );
    const transport = new SecureWebTransport({
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      rawRequest,
    });

    await expect(
      transport.request(new URL('https://html.duckduckgo.com/html/'), {
        method: 'POST',
        body: 'q=sensitive+spoken+claim',
        maxBytes: 100,
        timeoutMs: 1_000,
        contentTypes: new Set(['text/html']),
        allowedRedirectOrigins: new Set(['https://html.duckduckgo.com']),
      })
    ).rejects.toThrow('redirecting to another host');
    expect(rawRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized bodies, blocked content types, credentials, ports, and non-HTTPS URLs', async () => {
    const resolveHost = async () => [{ address: '93.184.216.34', family: 4 }];
    const oversized = new SecureWebTransport({
      resolveHost,
      rawRequest: async () => response('https://public.example/', '123456'),
    });
    await expect(
      oversized.request(new URL('https://public.example/'), {
        maxBytes: 5,
        timeoutMs: 1_000,
        contentTypes: new Set(['text/html']),
      })
    ).rejects.toThrow('exceeded the allowed size');

    const binary = new SecureWebTransport({
      resolveHost,
      rawRequest: async () =>
        response('https://public.example/', 'data', { contentType: 'application/octet-stream' }),
    });
    await expect(
      binary.request(new URL('https://public.example/'), {
        maxBytes: 100,
        timeoutMs: 1_000,
        contentTypes: new Set(['text/html']),
      })
    ).rejects.toThrow('blocked content type');

    for (const url of [
      'http://public.example/',
      'https://user:pass@public.example/',
      'https://public.example:8443/',
      'https://localhost/',
    ]) {
      expect(() => canonicalizePublicUrl(new URL(url))).toThrow();
    }
  });
});

describe('IP classification', () => {
  it.each([
    ['8.8.8.8', true],
    ['127.0.0.1', false],
    ['100.64.0.1', false],
    ['192.0.2.1', false],
    ['198.51.100.1', false],
    ['203.0.113.1', false],
    ['2606:4700:4700::1111', true],
    ['::1', false],
    ['fe80::1', false],
    ['fc00::1', false],
    ['2001:db8::1', false],
    ['::ffff:7f00:1', false],
    ['::ffff:0808:0808', true],
    ['::7f00:1', false],
    ['64:ff9b::7f00:1', false],
    ['2002:7f00:1::', false],
    ['not-an-ip', false],
  ])('classifies %s as public=%s', (address, expected) => {
    expect(isPublicIpAddress(address)).toBe(expected);
  });
});
