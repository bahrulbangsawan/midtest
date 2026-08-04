import { ToolError } from './errors.ts';

/**
 * Address handling shared by every path that can open a browser.
 *
 * It lives in its own module, and the check it exposes is invoked from
 * `SessionManager.start` rather than from either tool handler, because `start_session`
 * and `run_scenario` are two doors into the same room: a copy of this logic in each
 * handler is a copy free to drift, and a third caller added later would arrive with no
 * check at all. `start` is the one place every session must pass through.
 */

/** Schemes a session may open. */
const SKEMA_DIIZINKAN = ['http:', 'https:', 'file:'] as const;

/**
 * A URL is only a URL if it has content. A blank or whitespace-only value must read as
 * *absent* so the caller gets the missing-address refusal that fits, rather than being
 * handed to `page.goto('')`.
 */
export function bersihkanUrl(url: string | undefined): string | undefined {
  const dipangkas = url?.trim();
  return dipangkas ? dipangkas : undefined;
}

/**
 * Prove an address is openable *before* anything launches a browser to find out.
 *
 * `WebDeviceAdapter.open` launches Chrome and only then calls `page.goto(opts.url)`, so
 * without this check a typo costs a browser process, and the raw Puppeteer failure that
 * comes back is not a `ToolError` — `toToolResult` files any stranger under `INTERNAL`
 * and prints "Do not retry. Report this to the user and ask how to proceed." That is the
 * wrong advice for the one failure the caller can actually fix by trying again with a
 * corrected value.
 *
 * Returns the trimmed address so callers pass on exactly what was validated.
 */
export function pastikanUrlSesi(url: string): string {
  const dipangkas = bersihkanUrl(url);
  if (dipangkas === undefined) {
    throw new ToolError(
      'INVALID_URL',
      'the url is empty or only whitespace. Pass an absolute address including its ' +
        'scheme, e.g. "https://example.com", or omit url entirely to open a session ' +
        'without navigating.',
    );
  }

  let terurai: URL;
  try {
    terurai = new URL(dipangkas);
  } catch {
    // Overwhelmingly the scheme: `new URL('example.com')` throws exactly like
    // `new URL('not a url')` does, and a bare host is the mistake an agent actually makes.
    throw new ToolError(
      'INVALID_URL',
      `"${dipangkas}" is not a valid absolute URL, so no browser was opened. It needs a ` +
        'scheme: write "https://example.com", not "example.com". Fix the value and call ' +
        'again.',
    );
  }

  if (!(SKEMA_DIIZINKAN as readonly string[]).includes(terurai.protocol)) {
    throw new ToolError(
      'INVALID_URL',
      `"${dipangkas}" uses the "${terurai.protocol}" scheme, which a session cannot open, ` +
        `so no browser was opened. Use ${SKEMA_DIIZINKAN.join(', ')} — e.g. ` +
        '"https://example.com". Fix the value and call again.',
    );
  }

  return dipangkas;
}
