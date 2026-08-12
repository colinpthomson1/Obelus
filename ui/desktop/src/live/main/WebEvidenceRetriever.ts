import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const SEARCH_ENDPOINT = new URL('https://html.duckduckgo.com/html/');
const SEARCH_RESPONSE_LIMIT_BYTES = 1_024 * 1_024;
const PAGE_RESPONSE_LIMIT_BYTES = 768 * 1_024;
const DEFAULT_SEARCH_TIMEOUT_MS = 6_000;
const DEFAULT_PAGE_TIMEOUT_MS = 7_000;
const MAX_REDIRECTS = 3;
const MAX_SEARCH_RESULTS = 10;
const MAX_INVENTORY_ITEMS = 7;
const MAX_EXCERPT_LENGTH = 1_800;
const MAX_URL_LENGTH = 2_048;

const SEARCH_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const PAGE_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term',
]);
const QUERY_STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'because',
  'before',
  'being',
  'between',
  'could',
  'does',
  'from',
  'have',
  'into',
  'larger',
  'more',
  'most',
  'other',
  'should',
  'than',
  'that',
  'their',
  'there',
  'these',
  'they',
  'this',
  'those',
  'under',
  'very',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
]);

export type WebEvidenceDepth = 'quick' | 'deep';

export interface WebEvidenceItem {
  url: string;
  canonicalUrl: string;
  publisher: string;
  title: string;
  publicationDate: null;
  accessedAt: string;
  excerpt: string;
  retrievalKind: 'search_snippet' | 'page_extract';
}

export interface WebEvidenceResult {
  provider: 'DuckDuckGo HTML';
  queryCount: number;
  requestFailures: number;
  items: WebEvidenceItem[];
}

interface SearchResult {
  title: string;
  url: URL;
  snippet: string;
  rank: number;
  entity?: string;
  queryKind?: 'claim' | 'entity_official';
}

interface SearchPlan {
  query: string;
  entity?: string;
  queryKind: 'claim' | 'entity_official';
}

interface SecureResponse {
  url: URL;
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
}

interface SecureRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Readonly<Record<string, string>>;
  body?: string;
  maxBytes: number;
  timeoutMs: number;
  contentTypes: ReadonlySet<string>;
  allowedRedirectOrigins?: ReadonlySet<string>;
}

interface ResolvedAddress {
  address: string;
  family: number;
}

interface RawRequestOptions {
  url: URL;
  address: ResolvedAddress;
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  body?: string;
  maxBytes: number;
  timeoutMs: number;
}

type ResolveHost = (hostname: string) => Promise<ResolvedAddress[]>;
type RawHttpsRequest = (options: RawRequestOptions) => Promise<SecureResponse>;

export interface SecureWebTransportOptions {
  resolveHost?: ResolveHost;
  rawRequest?: RawHttpsRequest;
}

export interface WebEvidenceRetrieverOptions {
  now?: () => number;
  transport?: Pick<SecureWebTransport, 'request'>;
  searchTimeoutMs?: number;
  pageTimeoutMs?: number;
}

export class WebEvidenceRetriever {
  private readonly now: () => number;
  private readonly transport: Pick<SecureWebTransport, 'request'>;
  private readonly searchTimeoutMs: number;
  private readonly pageTimeoutMs: number;

  constructor(options: WebEvidenceRetrieverOptions = {}) {
    this.now = options.now ?? Date.now;
    this.transport = options.transport ?? new SecureWebTransport();
    this.searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.pageTimeoutMs = options.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  }

  async retrieve(claim: string, depth: WebEvidenceDepth): Promise<WebEvidenceResult> {
    const plans = webSearchPlansForClaim(claim, depth, new Date(this.now()).getUTCFullYear());
    const responses = await Promise.allSettled(plans.map((plan) => this.search(plan)));
    const discovered = deduplicateSearchResults(
      responses.flatMap((response) => (response.status === 'fulfilled' ? response.value : []))
    );
    const accessedAt = new Date(this.now()).toISOString();
    const selected = selectSearchResults(
      discovered,
      plans.flatMap((plan) => (plan.entity ? [plan.entity] : []))
    );

    if (depth === 'quick') {
      return {
        provider: 'DuckDuckGo HTML',
        queryCount: plans.length,
        requestFailures: responses.filter((response) => response.status === 'rejected').length,
        items: selected.flatMap((result) => searchSnippetEvidence(result, accessedAt)),
      };
    }

    const extracted = await Promise.allSettled(
      selected.map((result) => this.extractPage(result, claim, accessedAt))
    );
    return {
      provider: 'DuckDuckGo HTML',
      queryCount: plans.length,
      requestFailures:
        responses.filter((response) => response.status === 'rejected').length +
        extracted.filter((response) => response.status === 'rejected').length,
      items: selected.flatMap((result, index) => {
        const page = extracted[index];
        return page?.status === 'fulfilled' && page.value
          ? [page.value]
          : searchSnippetEvidence(result, accessedAt);
      }),
    };
  }

  private async search(plan: SearchPlan): Promise<SearchResult[]> {
    const body = new URLSearchParams({ q: plan.query, kl: 'us-en' }).toString();
    const response = await this.transport.request(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'ObelusDesktop/1.45 evidence-search',
      },
      body,
      maxBytes: SEARCH_RESPONSE_LIMIT_BYTES,
      timeoutMs: this.searchTimeoutMs,
      contentTypes: SEARCH_CONTENT_TYPES,
      allowedRedirectOrigins: new Set([SEARCH_ENDPOINT.origin]),
    });
    if (response.url.origin !== SEARCH_ENDPOINT.origin || response.url.pathname !== '/html/') {
      throw webEvidenceError('The evidence search provider redirected outside its allowlist.');
    }
    if (response.statusCode !== 200) {
      throw webEvidenceError('The evidence search provider is unavailable.');
    }
    const html = new TextDecoder().decode(response.body);
    const results = parseDuckDuckGoResults(html);
    if (results.length > 0) {
      return results.map((result) => ({
        ...result,
        entity: plan.entity,
        queryKind: plan.queryKind,
      }));
    }
    if (isRecognizedNoResultsPage(html)) return [];
    throw webEvidenceError(
      'The evidence search provider returned a challenge or an unrecognized response.'
    );
  }

  private async extractPage(
    result: SearchResult,
    claim: string,
    accessedAt: string
  ): Promise<WebEvidenceItem | undefined> {
    const response = await this.transport.request(result.url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        'User-Agent': 'ObelusDesktop/1.45 evidence-reader',
      },
      maxBytes: PAGE_RESPONSE_LIMIT_BYTES,
      timeoutMs: this.pageTimeoutMs,
      contentTypes: PAGE_CONTENT_TYPES,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) return undefined;
    const extracted = extractRelevantPageText(
      new TextDecoder().decode(response.body),
      claim,
      result.snippet
    );
    if (!extracted) return undefined;
    const canonicalUrl = canonicalizePublicUrl(response.url).toString();
    return {
      url: canonicalUrl,
      canonicalUrl,
      publisher: publisherForUrl(response.url),
      title: result.title,
      publicationDate: null,
      accessedAt,
      excerpt: extracted,
      retrievalKind: 'page_extract',
    };
  }
}

export class SecureWebTransport {
  private readonly resolveHost: ResolveHost;
  private readonly rawRequest: RawHttpsRequest;

  constructor(options: SecureWebTransportOptions = {}) {
    this.resolveHost = options.resolveHost ?? resolvePublicAddresses;
    this.rawRequest = options.rawRequest ?? requestPinnedHttps;
  }

  async request(initialUrl: URL, options: SecureRequestOptions): Promise<SecureResponse> {
    let url = canonicalizePublicUrl(initialUrl);
    let method = options.method ?? 'GET';
    let body = options.body;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const addresses = await this.resolveHost(url.hostname);
      if (addresses.length === 0 || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
        throw webEvidenceError('An evidence request was blocked because its host is not public.');
      }
      const response = await this.rawRequest({
        url,
        address: addresses[0],
        method,
        headers: safeRequestHeaders(options.headers ?? {}),
        body,
        maxBytes: options.maxBytes,
        timeoutMs: options.timeoutMs,
      });
      if (!REDIRECT_STATUSES.has(response.statusCode)) {
        assertAllowedContentType(response.headers, options.contentTypes);
        if (response.body.byteLength > options.maxBytes) {
          throw webEvidenceError('An evidence response exceeded the allowed size.');
        }
        return response;
      }
      if (redirectCount === MAX_REDIRECTS) {
        throw webEvidenceError('An evidence request exceeded the redirect limit.');
      }
      const location = firstHeader(response.headers.location);
      if (!location) throw webEvidenceError('An evidence provider returned an invalid redirect.');
      url = canonicalizePublicUrl(new URL(location, url));
      if (options.allowedRedirectOrigins && !options.allowedRedirectOrigins.has(url.origin)) {
        throw webEvidenceError('An evidence request was blocked from redirecting to another host.');
      }
      if (
        response.statusCode === 303 ||
        ((response.statusCode === 301 || response.statusCode === 302) && method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
      }
    }
    throw webEvidenceError('An evidence request exceeded the redirect limit.');
  }
}

export function webQueriesForClaim(
  claim: string,
  depth: WebEvidenceDepth,
  asOfYear = new Date().getUTCFullYear()
): string[] {
  return webSearchPlansForClaim(claim, depth, asOfYear).map((plan) => plan.query);
}

function webSearchPlansForClaim(
  claim: string,
  depth: WebEvidenceDepth,
  asOfYear: number
): SearchPlan[] {
  const bounded = boundedClaim(claim);
  if (!bounded) return [];
  const comparison = /\b(?:bigger|larger|smaller|greater|less|more|fewer)\b/i.test(bounded);
  const company =
    /\b(?:business|companies|company|corporation|revenue|employees|market cap)\b/i.test(bounded);
  const metricTerms = company
    ? 'revenue employees annual report official data'
    : comparison
      ? 'size measurement comparison official data'
      : 'authoritative source official data';
  const plans: SearchPlan[] = [
    { query: `${bounded} ${metricTerms}`.slice(0, 420), queryKind: 'claim' },
  ];
  const entities = company ? comparisonEntities(bounded) : [];
  if (entities.length === 2) {
    plans.push(
      ...entities.map(
        (entity): SearchPlan => ({
          query:
            `${entity} official corporate site investor relations revenue employees ${asOfYear}`.slice(
              0,
              420
            ),
          entity,
          queryKind: 'entity_official',
        })
      )
    );
  } else if (depth === 'deep') {
    plans.push({
      query: `${bounded} primary source evidence`.slice(0, 420),
      queryKind: 'claim',
    });
  }
  const unique = new Map(plans.map((plan) => [plan.query, plan]));
  return [...unique.values()];
}

function comparisonEntities(claim: string): string[] {
  const match = /^(.{1,120}?)\s+(?:is|are|was|were)\s+.{1,120}?\bthan\s+(.{1,120}?)[.!?]?$/i.exec(
    claim
  );
  if (!match) return [];
  return [match[1] ?? '', match[2] ?? ''].map(normalizeComparisonEntity).filter(Boolean);
}

function normalizeComparisonEntity(value: string): string {
  const normalized = value
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const fragments = normalized.split(/\s*,\s*/);
  if (fragments.length < 2) return normalized;

  let entityStart = fragments.length - 1;
  while (entityStart > 0 && isOrganizationSuffix(fragments[entityStart] ?? '')) {
    entityStart -= 1;
  }
  return fragments.slice(entityStart).join(', ');
}

function isOrganizationSuffix(value: string): boolean {
  return /^(?:co(?:mpany)?|corp(?:oration)?|inc(?:orporated)?|l\.?l\.?c|l\.?l\.?p|l\.?p|ltd|limited|p\.?c|plc)\.?$/i.test(
    value
  );
}

export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorPattern = /<a\b([^>]{0,4096})>([\s\S]{0,12000}?)<\/a>/gi;
  let pending: SearchResult | undefined;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null && results.length < MAX_SEARCH_RESULTS) {
    const attributes = match[1] ?? '';
    const className = attributeValue(attributes, 'class');
    if (className.split(/\s+/).includes('result__a')) {
      const rawUrl = attributeValue(attributes, 'href');
      const title = stripHtml(match[2] ?? '').slice(0, 500);
      const url = safeSearchResultUrl(rawUrl);
      if (!url || !title) {
        pending = undefined;
        continue;
      }
      pending = { title, url, snippet: '', rank: results.length };
      results.push(pending);
      continue;
    }
    if (pending && className.split(/\s+/).includes('result__snippet')) {
      pending.snippet = stripHtml(match[2] ?? '').slice(0, MAX_EXCERPT_LENGTH);
      pending = undefined;
    }
  }
  return results;
}

function isRecognizedNoResultsPage(html: string): boolean {
  return (
    /class\s*=\s*(["'])[^"']*\bresult--no-result\b[^"']*\1/i.test(html) &&
    /<h1\b[^>]*>\s*No results found for\b/i.test(html)
  );
}

export function canonicalizePublicUrl(value: URL): URL {
  const url = new URL(value.toString());
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.toString().length > MAX_URL_LENGTH
  ) {
    throw webEvidenceError('An evidence URL was blocked by the public HTTPS policy.');
  }
  url.hash = '';
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!isSafePublicHostname(hostname)) {
    throw webEvidenceError('An evidence URL was blocked because its host is not public.');
  }
  url.hostname = hostname;
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
  return url;
}

export function isPublicIpAddress(value: string): boolean {
  const version = isIP(value);
  if (version === 4) return isPublicIpv4(value);
  if (version !== 6) return false;
  const normalized = value.toLowerCase().split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  if (mapped) return isPublicIpv4(mapped[1]);
  const segments = expandIpv6(normalized);
  if (!segments) return false;
  const first = segments[0] ?? 0;
  const second = segments[1] ?? 0;
  if (segments.slice(0, 5).every((segment) => segment === 0) && segments[5] === 0xffff) {
    const high = segments[6] ?? 0;
    const low = segments[7] ?? 0;
    return isPublicIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  if (
    segments.every((segment) => segment === 0) ||
    (segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1)
  )
    return false;
  if (segments.slice(0, 6).every((segment) => segment === 0)) return false;
  if (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  )
    return false;
  if (first === 0x0100 && segments.slice(1).every((segment) => segment === 0)) return false;
  if (first === 0x0064 && second === 0xff9b) return false;
  if (first === 0x2001 && second < 0x0200) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  if (first === 0x2002) return false;
  return true;
}

function isPublicIpv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function expandIpv6(value: string): number[] | undefined {
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return undefined;
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  const parsed = parts.map((part) =>
    /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : -1
  );
  return parsed.length === 8 && parsed.every((part) => part >= 0) ? parsed : undefined;
}

async function resolvePublicAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family }));
}

function requestPinnedHttps(options: RawRequestOptions): Promise<SecureResponse> {
  return new Promise((resolve, reject) => {
    const headers = {
      ...options.headers,
      Host: options.url.host,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    };
    const request = httpsRequest(
      {
        host: options.address.address,
        family: options.address.family,
        port: 443,
        servername: options.url.hostname,
        path: `${options.url.pathname}${options.url.search}`,
        method: options.method,
        headers,
      },
      (response) => {
        const declaredLength = Number(firstHeader(response.headers['content-length']));
        if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
          response.destroy();
          reject(webEvidenceError('An evidence response exceeded the allowed size.'));
          return;
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > options.maxBytes) {
            response.destroy(webEvidenceError('An evidence response exceeded the allowed size.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const body = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve({
            url: options.url,
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body,
          });
        });
      }
    );
    const timer = setTimeout(
      () => request.destroy(webEvidenceError('An evidence request timed out.')),
      options.timeoutMs
    );
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function safeRequestHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const allowed = new Set(['accept', 'accept-language', 'content-type', 'user-agent']);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => allowed.has(name.toLowerCase()))
  );
}

function assertAllowedContentType(
  headers: IncomingHttpHeaders,
  allowed: ReadonlySet<string>
): void {
  const raw = firstHeader(headers['content-type']);
  const contentType = raw?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || !allowed.has(contentType)) {
    throw webEvidenceError('An evidence response used a blocked content type.');
  }
}

function safeSearchResultUrl(rawValue: string): URL | undefined {
  if (!rawValue) return undefined;
  try {
    const decoded = decodeHtmlEntities(rawValue);
    const candidate = new URL(decoded, SEARCH_ENDPOINT);
    let target = candidate;
    if (
      (candidate.hostname === 'duckduckgo.com' || candidate.hostname === 'www.duckduckgo.com') &&
      candidate.pathname === '/l/'
    ) {
      const wrapped = candidate.searchParams.get('uddg');
      if (!wrapped) return undefined;
      target = new URL(wrapped);
    }
    return canonicalizePublicUrl(target);
  } catch {
    return undefined;
  }
}

function deduplicateSearchResults(results: readonly SearchResult[]): SearchResult[] {
  const unique = new Map<string, SearchResult>();
  for (const result of results) {
    const key = result.url.toString();
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, result);
      continue;
    }
    const richer = result.snippet.length > existing.snippet.length ? result : existing;
    const tagged = result.entity ? result : existing;
    unique.set(key, {
      ...richer,
      entity: tagged.entity,
      queryKind: tagged.queryKind,
      rank: Math.min(existing.rank, result.rank),
    });
  }
  return [...unique.values()];
}

function selectSearchResults(
  results: readonly SearchResult[],
  entities: readonly string[]
): SearchResult[] {
  const uniqueEntities = [...new Set(entities)];
  const ranked = rankSearchResults(
    results.filter(
      (result) => !uniqueEntities.some((entity) => isKnownEntityCollision(result, entity))
    )
  );
  const selected: SearchResult[] = [];
  const selectedUrls = new Set<string>();
  const add = (result: SearchResult | undefined) => {
    if (!result || selectedUrls.has(result.url.toString())) return;
    selected.push(result);
    selectedUrls.add(result.url.toString());
  };
  for (const entity of uniqueEntities) {
    add(
      ranked.find(
        (result) => result.entity === entity && isEntityAlignedFirstPartyResult(result, entity)
      )
    );
  }
  for (const entity of uniqueEntities) {
    add(
      ranked.find(
        (result) =>
          result.entity === entity &&
          resultMatchesEntity(result, entity) &&
          /\d/.test(result.snippet)
      )
    );
  }
  for (const result of ranked) {
    if (selected.length >= MAX_INVENTORY_ITEMS) break;
    add(result);
  }
  return selected.slice(0, MAX_INVENTORY_ITEMS);
}

function rankSearchResults(results: readonly SearchResult[]): SearchResult[] {
  return [...results].sort((left, right) => {
    const authority = resultQualityScore(right) - resultQualityScore(left);
    return (
      authority || left.rank - right.rank || left.url.toString().localeCompare(right.url.toString())
    );
  });
}

function resultQualityScore(result: SearchResult): number {
  const hostname = result.url.hostname;
  if (result.entity && isEntityAlignedFirstPartyResult(result, result.entity)) {
    return 180 + (hasInvestorOrReportSignal(result) ? 20 : 0) + Math.max(0, 10 - result.rank);
  }
  if (
    /\.(?:gov|mil)$/.test(hostname) ||
    hostname === 'europa.eu' ||
    hostname.endsWith('.europa.eu')
  ) {
    return 130 + (result.entity && resultMatchesEntity(result, result.entity) ? 15 : 0);
  }
  if (/\.(?:gov\.uk|gc\.ca|edu\.au)$/.test(hostname)) return 120;
  if (/\.edu$/.test(hostname)) return 110;
  if (hostname === 'wikipedia.org' || hostname.endsWith('.wikipedia.org')) return 60;
  const relevance = result.entity && resultMatchesEntity(result, result.entity) ? 12 : 0;
  const quantitative = /\d/.test(result.snippet) ? 5 : 0;
  return 40 + relevance + quantitative + Math.max(0, 10 - result.rank);
}

function isEntityAlignedFirstPartyResult(result: SearchResult, entity: string): boolean {
  const hostname = compactWords(result.url.hostname.replace(/^www\./, ''));
  const tokens = entityTokens(entity);
  if (tokens.length === 0 || !tokens.every((token) => hostname.includes(token))) return false;
  return (
    hasInvestorOrReportSignal(result) || /\b(?:corporate site|official site)\b/i.test(result.title)
  );
}

function hasInvestorOrReportSignal(result: SearchResult): boolean {
  const labels = result.url.hostname.toLowerCase().split('.');
  return (
    labels.some((label) =>
      ['about', 'corporate', 'investor', 'investors', 'ir', 'newsroom'].includes(label)
    ) ||
    /\/(?:about|company|corporate|earnings|investor|investors|news-release|sec-filings)(?:[/-]|$)/i.test(
      result.url.pathname
    ) ||
    /\b(?:annual report|corporate site|earnings release|investor relations|sec filing)\b/i.test(
      result.title
    )
  );
}

function resultMatchesEntity(result: SearchResult, entity: string): boolean {
  const haystack = compactWords(`${result.title} ${result.snippet} ${result.url.hostname}`);
  const tokens = entityTokens(entity);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function isKnownEntityCollision(result: SearchResult, entity: string): boolean {
  if (compactWords(entity) !== 'barnesnoble') return false;
  return /\bbarnes\s*(?:&|and)\s*noble\s+education\b/i.test(`${result.title} ${result.snippet}`);
}

function entityTokens(value: string): string[] {
  const ignored = new Set([
    'and',
    'company',
    'corporation',
    'inc',
    'incorporated',
    'limited',
    'the',
  ]);
  return (
    value
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}]{3,}/gu)
      ?.filter((token) => !ignored.has(token)) ?? []
  );
}

function compactWords(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, '');
}

function searchSnippetEvidence(result: SearchResult, accessedAt: string): WebEvidenceItem[] {
  if (!result.snippet) return [];
  const canonicalUrl = result.url.toString();
  return [
    {
      url: canonicalUrl,
      canonicalUrl,
      publisher: publisherForUrl(result.url),
      title: result.title,
      publicationDate: null,
      accessedAt,
      excerpt: result.snippet,
      retrievalKind: 'search_snippet',
    },
  ];
}

function publisherForUrl(url: URL): string {
  if (url.hostname === 'nasa.gov' || url.hostname.endsWith('.nasa.gov')) return 'NASA';
  if (url.hostname === 'nih.gov' || url.hostname.endsWith('.nih.gov')) {
    return 'National Institutes of Health';
  }
  if (url.hostname === 'sec.gov' || url.hostname.endsWith('.sec.gov')) {
    return 'U.S. Securities and Exchange Commission';
  }
  return url.hostname.replace(/^www\./, '');
}

function extractRelevantPageText(html: string, claim: string, snippet: string): string {
  const meta = extractMetaDescription(html);
  const preferred = firstTagContents(html, 'article') || firstTagContents(html, 'main') || html;
  const text = stripHtml(
    preferred
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(
        /<(?:script|style|template|noscript|svg|nav|header|footer|form)\b[\s\S]*?<\/(?:script|style|template|noscript|svg|nav|header|footer|form)>/gi,
        ' '
      )
      .replace(/<br\s*\/?>/gi, '. ')
      .replace(/<\/(?:p|li|h[1-6]|section|div)>/gi, '. ')
  );
  const candidates = sentenceCandidates([snippet, meta, text]);
  const keywords = queryKeywords(claim);
  candidates.sort((left, right) => sentenceScore(right, keywords) - sentenceScore(left, keywords));
  const selected: string[] = [];
  let length = 0;
  for (const sentence of candidates) {
    if (selected.length >= 8) break;
    const addition = (selected.length ? 1 : 0) + sentence.length;
    if (length + addition > MAX_EXCERPT_LENGTH) continue;
    if (sentenceScore(sentence, keywords) <= 0 && selected.length >= 2) continue;
    selected.push(sentence);
    length += addition;
  }
  return selected.join(' ').slice(0, MAX_EXCERPT_LENGTH);
}

function sentenceCandidates(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    for (const part of value.split(/(?<=[.!?])\s+|\n+/)) {
      const sentence = part.replace(/\s+/g, ' ').trim().slice(0, 700);
      if (sentence.length < 20) continue;
      const key = sentence.toLocaleLowerCase('en-US');
      if (!unique.has(key)) unique.set(key, sentence);
    }
  }
  return [...unique.values()].slice(0, 1_000);
}

function queryKeywords(claim: string): Set<string> {
  return new Set(
    boundedClaim(claim)
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}]{3,}/gu)
      ?.filter((word) => !QUERY_STOP_WORDS.has(word)) ?? []
  );
}

function sentenceScore(sentence: string, keywords: ReadonlySet<string>): number {
  const normalized = sentence.toLocaleLowerCase('en-US');
  let score = /\d/.test(sentence) ? 2 : 0;
  for (const keyword of keywords) {
    if (normalized.includes(keyword)) score += 4;
  }
  return score;
}

function extractMetaDescription(html: string): string {
  const tags = html.match(/<meta\b[^>]{0,4096}>/gi) ?? [];
  for (const tag of tags) {
    const name = attributeValue(tag, 'name').toLowerCase();
    const property = attributeValue(tag, 'property').toLowerCase();
    if (name === 'description' || property === 'og:description') {
      return decodeHtmlEntities(attributeValue(tag, 'content')).replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function firstTagContents(html: string, tagName: 'article' | 'main'): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  return pattern.exec(html)?.[1] ?? '';
}

function attributeValue(attributes: string, name: string): string {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  return pattern.exec(attributes)?.[2] ?? '';
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '…',
    ldquo: '“',
    lsquo: '‘',
    lt: '<',
    mdash: '—',
    nbsp: ' ',
    ndash: '–',
    quot: '"',
    rdquo: '”',
    rsquo: '’',
  };
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/gi,
    (entity, decimal, hexadecimal, name) => {
      const codePoint = decimal
        ? Number.parseInt(decimal, 10)
        : hexadecimal
          ? Number.parseInt(hexadecimal, 16)
          : undefined;
      if (codePoint !== undefined) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return entity;
        }
      }
      return named[String(name).toLowerCase()] ?? entity;
    }
  );
}

function isSafePublicHostname(hostname: string): boolean {
  if (
    !hostname ||
    hostname.length > 253 ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.lan')
  ) {
    return false;
  }
  const labels = hostname.split('.');
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    )
  );
}

function boundedClaim(value: string): string {
  return [...value.normalize('NFKC')]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function webEvidenceError(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'web_evidence_unavailable',
    retryable: true,
  });
}
