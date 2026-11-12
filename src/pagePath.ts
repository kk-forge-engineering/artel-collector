// Shapes the page and the referrer an event carries, so an e-mail address, an IP address or a URL in them never leaves
// the browser. The intake masks the page and refuses such a referrer itself too, so the rules here need not match its
// own to the character.

/** The length of a page path the intake keeps. */
const MAX_PAGE_LENGTH = 256;
/** The length of a referrer host the intake keeps. */
const MAX_REFERRER_LENGTH = 128;
/** What the collector sends in place of a segment that holds an address. */
const ADDRESS_SEGMENT = ":address";
/** The base `URL` reads a page against, so a page given as a path reads too. */
const PAGE_BASE = "https://page.invalid";
/** The most times the collector decodes a segment, so an address escaped twice, as `%2540`, still shows. */
const MAX_DECODING_PASSES = 2;
/** The at sign and its look-alikes U+FF20 and U+FE6B. */
const AT_SIGN = /[@＠﹫]/u;
const IPV4 = /(?<!\d)\d{1,3}(?:\.\d{1,3}){3}(?!\d)/;
const IPV6_FULL = /(?:[\da-f]{1,4}:){7}[\da-f]{1,4}/i;
const NON_WORD = /[^\w:]+/;
const HEX_AND_COLONS = /^[\da-f:]+$/i;
/** A scheme and `://`, as in `next=https://site.com`. */
const SCHEME_SLASHES = /[\da-z+.-]:\/\//i;
/** A special scheme and its colon. A browser reads `https:site.com` as a URL even without `//` after the colon. */
const SPECIAL_SCHEME = /(?<![\da-z])(?:https?|wss?|ftp|file):/i;
/** A scheme and its colon at the end of a segment. An empty segment after it makes `scheme://`. */
const SCHEME_END = /[\da-z+.-]:$/i;
/** A path parameter: the first `;` of a segment and the rest of it. */
const PATH_PARAMETER = /;.*/s;
/** A `%` that lost one or both of its hex digits to the cut. */
const CUT_ESCAPE = /%[\da-f]?$/i;
const ESCAPE_RUN = /(?:%[\da-f]{2})+/gi;
const ASCII_ESCAPE = /%[0-7][\da-f]/gi;
/** The escapes of the last character a path ends in: a UTF-8 lead byte and the continuation bytes after it. */
const LAST_ENCODED_CHARACTER = /(?:%[c-f][\da-f])?(?:%[89ab][\da-f]){0,3}$/i;

/**
 * Returns the path of a page given as a path or a URL, cut to 256 characters, or undefined where `URL` fails or the
 * path lacks a leading `/`. The function drops each `;` path parameter, which can carry a session ID. A segment with an
 * address becomes `:address`, and a URL turns the rest into one `:address`.
 */
export function pagePath(page: string): string | undefined {
  let path: string;
  try {
    path = new URL(page, PAGE_BASE).pathname;
  } catch {
    return undefined;
  }
  return path.startsWith("/") ? cut(withoutAddresses(path)) : undefined;
}

/** Returns the path cut to 256 characters, never inside an escape or inside the escapes of one UTF-8 character. */
function cut(path: string): string {
  if (path.length <= MAX_PAGE_LENGTH) {
    return path;
  }
  const kept = path.slice(0, MAX_PAGE_LENGTH).replace(CUT_ESCAPE, "");
  const lastCharacter = LAST_ENCODED_CHARACTER.exec(kept)?.[0] ?? "";
  return isWholeCharacter(lastCharacter) ? kept : kept.slice(0, kept.length - lastCharacter.length);
}

/** Tells whether escapes spell one whole UTF-8 character, or are none. */
function isWholeCharacter(escapes: string): boolean {
  try {
    decodeURIComponent(escapes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the lowercased host of a referrer URL, or undefined for no URL, no host, a host past 128 characters, an IP
 * address or a host with an `@`. The IP check relies on `URL`, which writes each IPv4 form as four decimal numbers and
 * an IPv6 address in brackets.
 */
export function referrerHost(referrer: string): string | undefined {
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const isIp = host.startsWith("[") || /^\d+$/.test(host.slice(host.lastIndexOf(".") + 1));
  // The check decodes the host, since `URL` leaves an at sign or a look-alike escaped in the host of a scheme other
  // than http or https.
  const isAddress = isIp || AT_SIGN.test(decodedOrSame(host));
  return host === "" || host.length > MAX_REFERRER_LENGTH || isAddress ? undefined : host;
}

/**
 * Returns the path with `:address` for each segment that holds an address, and one `:address` for the rest of the path
 * from a segment that starts a URL.
 */
function withoutAddresses(path: string): string {
  const segments = path.split("/");
  const kept: string[] = [];
  let length = 0;
  for (const [index, whole] of segments.entries()) {
    // The loop stops past the 256 characters the cut keeps, so a long page costs little.
    if (length > MAX_PAGE_LENGTH) {
      break;
    }
    const segment = whole.replace(PATH_PARAMETER, "");
    const texts = decodings(segment);
    if (startsUrl(texts, segments[index + 1])) {
      return [...kept, ADDRESS_SEGMENT].join("/");
    }
    const sent = texts.some(holdsAddress) ? ADDRESS_SEGMENT : segment;
    kept.push(sent);
    length += sent.length + 1;
  }
  return kept.join("/");
}

/**
 * Tells whether a segment, given as written and decoded, starts a URL: it holds a scheme and `://` or a special scheme,
 * or it ends in a scheme's colon before an empty segment.
 */
function startsUrl(texts: readonly string[], next: string | undefined): boolean {
  const [written = ""] = texts;
  return (
    texts.some((text) => SCHEME_SLASHES.test(text) || SPECIAL_SCHEME.test(text)) ||
    (next === "" && SCHEME_END.test(written))
  );
}

/** Returns the segment as written and after each decoding pass, until a pass changes nothing or the passes run out. */
function decodings(segment: string): string[] {
  const texts = [segment];
  let text = segment;
  for (let pass = 0; pass < MAX_DECODING_PASSES; pass++) {
    const decoded = decodedOrSame(text);
    if (decoded === text) {
      break;
    }
    texts.push(decoded);
    text = decoded;
  }
  return texts;
}

/**
 * Returns the text with each run of escapes decoded once. In a run that is not valid UTF-8, only the ASCII escapes
 * decode.
 */
function decodedOrSame(text: string): string {
  return text.replaceAll(ESCAPE_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      // The catch decodes the ASCII escapes of a run that is not UTF-8, so an `@` beside a stray byte, as in `%E9%40`,
      // still shows.
      return run.replaceAll(ASCII_ESCAPE, (escape) =>
        String.fromCodePoint(Number.parseInt(escape.slice(1), 16)),
      );
    }
  });
}

/**
 * Tells whether the text holds an e-mail address or an IP address. An at sign or a look-alike counts as an e-mail
 * address.
 */
function holdsAddress(text: string): boolean {
  return AT_SIGN.test(text) || IPV4.test(text) || IPV6_FULL.test(text) || holdsShortIpv6(text);
}

/**
 * Tells whether a word of the text is a short IPv6 address, hex digits and colons with a `::`, such as `fe80::1` or
 * `::1`.
 */
function holdsShortIpv6(text: string): boolean {
  return text.split(NON_WORD).some((word) => word.includes("::") && HEX_AND_COLONS.test(word));
}
