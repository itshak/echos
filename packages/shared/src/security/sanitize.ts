const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function sanitizeHtml(input: string): string {
  // Strip all HTML tags
  let clean = input.replace(/<[^>]*>/g, '');
  // Decode named entities
  clean = clean.replace(/&nbsp;/g, ' ');
  clean = clean.replace(/&amp;/g, '&');
  clean = clean.replace(/&lt;/g, '<');
  clean = clean.replace(/&gt;/g, '>');
  clean = clean.replace(/&quot;/g, '"');
  // Decode numeric entities (decimal e.g. &#39; and hex e.g. &#x27;)
  // Only decode valid Unicode code points, excluding surrogates (0xD800-0xDFFF)
  clean = clean.replace(/&#(\d+);/g, (match, code: string) => {
    const codePoint = parseInt(code, 10);
    if (codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) return match;
    return String.fromCodePoint(codePoint);
  });
  clean = clean.replace(/&#x([0-9a-fA-F]+);/g, (match, code: string) => {
    const codePoint = parseInt(code, 16);
    if (codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) return match;
    return String.fromCodePoint(codePoint);
  });
  // Re-escape for safety
  clean = clean.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
  return clean.trim();
}

export function escapeXml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => XML_ENTITIES[char] ?? char);
}
