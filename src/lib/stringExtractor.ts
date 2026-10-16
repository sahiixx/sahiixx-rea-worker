export interface ExtractedString { value: string; offset: number; encoding: 'ASCII' | 'UTF16LE'; length: number; categories: string[]; confidence: number; }
const PATTERNS: Record<string, RegExp> = {
  GENERIC_API_KEY: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/i,
  NZP_LIVE: /nzp_live_[a-z0-9]{16}/,
  BAYUT: /(?:bayut|dubizzle|property_finder)[_\-]?(?:key|token|api)[\s:=]+[a-zA-Z0-9_\-]{10,}/i,
  GH_TOKEN: /ghp_[a-zA-Z0-9]{36}/,
  URL: /https?:\/\/[^
\s"']+/g,
  IP: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  DUBAI_RE: /(?:dubai|bayut|dubizzle|property|finder|emirate|dewa|rera)[a-z0-9_\-]*/i,
  ENDPOINT: /(?:\/api\/|\/v1\/|endpoint|\/graphql)[a-z0-9\/\_\-]*/i,
};
export function extractStrings(bytes: Uint8Array, minLen = 4): ExtractedString[] {
  const results: ExtractedString[] = [];
  // ASCII scan
  let current = '';
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 32 && b <= 126) {
      if (current === '') start = i;
      current += String.fromCharCode(b);
    } else {
      if (current.length >= minLen) {
        const cats = categorize(current);
        const conf = cats.length > 0 ? 0.9 : Math.max(0.5, Math.min(0.8, current.length / 100));
        results.push({ value: current, offset: start, encoding: 'ASCII', length: current.length, categories: cats, confidence: conf });
      }
      current = '';
      start = 0;
    }
  }
  if (current.length >= minLen) {
    const cats = categorize(current);
    const conf = cats.length > 0 ? 0.9 : Math.max(0.5, Math.min(0.8, current.length / 100));
    results.push({ value: current, offset: start, encoding: 'ASCII', length: current.length, categories: cats, confidence: conf });
  }
  // UTF-16LE scan
  current = '';
  start = 0;
  for (let i = 0; i < bytes.length - 1; i += 2) {
    const low = bytes[i]; const high = bytes[i+1];
    if (high === 0 && low >= 32 && low <= 126) {
      if (current === '') start = i;
      current += String.fromCharCode(low);
    } else {
      if (current.length >= minLen) {
        const cats = categorize(current);
        results.push({ value: current, offset: start, encoding: 'UTF16LE', length: current.length, categories: cats, confidence: 0.7 });
      }
      current = '';
    }
  }
  if (current.length >= minLen) {
    const cats = categorize(current);
    results.push({ value: current, offset: start, encoding: 'UTF16LE', length: current.length, categories: cats, confidence: 0.7 });
  }
  return results.sort((a,b) => b.confidence - a.confidence || b.length - a.length).slice(0, 500);
}
function categorize(s: string): string[] {
  const cats: string[] = [];
  for (const [name, regex] of Object.entries(PATTERNS)) { if (new RegExp(regex.source, regex.flags).test(s)) cats.push(name); }
  if (/(?:password|secret|encrypt|xor|obfuscate|bypass)/i.test(s)) cats.push('SUSPICIOUS');
  if (s.length > 40 && /^[a-zA-Z0-9_\-]+$/.test(s)) cats.push('POTENTIAL_KEY');
  return cats;
}
export function detectXorObfuscation(strings: ExtractedString[]): { pattern: string; example: string } | null {
  for (const s of strings) { if (s.value.includes('^') && /b\s*\^\s*i\s*\^/.test(s.value)) return { pattern: 'b ^ i ^ 0xAA', example: s.value }; }
  return null;
}
