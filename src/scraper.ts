/**
 * Scraper module for fetching HTML content from a URL.
 */

/**
 * Fetches HTML content from the given URL using Deno's native fetch API.
 *
 * @param url The URL to fetch HTML from.
 * @param options Optional request options. Supports a `cookie` string that, if
 *   provided, is sent as the `Cookie` request header.
 * @returns The HTML content as a string.
 * @throws Error if the fetch fails or the response is not OK.
 */
export async function fetchHtml(
  url: string,
  options?: { cookie?: string },
): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  if (options?.cookie) {
    headers["Cookie"] = options.cookie;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch HTML from ${url}: ${response.status} ${response.statusText}`,
    );
  }

  return await response.text();
}
