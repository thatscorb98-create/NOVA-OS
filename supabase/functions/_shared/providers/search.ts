import { env } from '../supabase.ts';

/**
 * Search provider.
 *
 * Two providers are supported and the owner picks one with a function secret;
 * there is no built-in scraping and no bundled corpus. With no key configured
 * the provider reports that plainly instead of returning invented businesses.
 *
 *   SEARCH_PROVIDER=tavily  TAVILY_API_KEY=...
 *   SEARCH_PROVIDER=brave   BRAVE_SEARCH_API_KEY=...
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProviderStatus {
  configured: boolean;
  provider: string | null;
  reason: string;
}

export class ProviderNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotConfigured';
  }
}

export function searchProviderStatus(): SearchProviderStatus {
  const provider = (env('SEARCH_PROVIDER') ?? '').toLowerCase();

  if (provider === 'tavily') {
    return env('TAVILY_API_KEY')
      ? { configured: true, provider, reason: 'Tavily is configured.' }
      : { configured: false, provider, reason: 'SEARCH_PROVIDER=tavily but TAVILY_API_KEY is missing.' };
  }

  if (provider === 'brave') {
    return env('BRAVE_SEARCH_API_KEY')
      ? { configured: true, provider, reason: 'Brave Search is configured.' }
      : {
          configured: false,
          provider,
          reason: 'SEARCH_PROVIDER=brave but BRAVE_SEARCH_API_KEY is missing.',
        };
  }

  return {
    configured: false,
    provider: provider || null,
    reason: 'No search provider is configured. Set SEARCH_PROVIDER and its API key.',
  };
}

const TIMEOUT_MS = 20_000;

export async function searchBusinesses(query: string, limit: number): Promise<SearchHit[]> {
  const status = searchProviderStatus();
  if (!status.configured) throw new ProviderNotConfigured(status.reason);

  const count = Math.max(1, Math.min(Math.trunc(limit) || 10, 20));

  return status.provider === 'tavily'
    ? searchTavily(query, count)
    : searchBrave(query, count);
}

async function searchTavily(query: string, count: number): Promise<SearchHit[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env('TAVILY_API_KEY')}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: count,
      include_answer: false,
      include_raw_content: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Tavily returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const data = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };

  return (data.results ?? [])
    .filter((item) => typeof item.url === 'string')
    .map((item) => ({
      title: (item.title ?? '').trim().slice(0, 200),
      url: item.url as string,
      snippet: (item.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
    }));
}

async function searchBrave(query: string, count: number): Promise<SearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': env('BRAVE_SEARCH_API_KEY') as string,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Brave Search returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };

  return (data.web?.results ?? [])
    .filter((item) => typeof item.url === 'string')
    .map((item) => ({
      title: (item.title ?? '').trim().slice(0, 200),
      url: item.url as string,
      snippet: (item.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
    }));
}
