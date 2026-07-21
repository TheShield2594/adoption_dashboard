// Weekly adoption-grants discovery job.
// Scheduled in-process by server.js (node-cron), or run manually:
//   node scripts/fetch-grants.js [--dry-run]
//
// Pipeline: scrape fixed source pages + SearXNG-discovered pages -> ask an
// OpenRouter model to extract genuinely new grant programs -> insert into
// SQLite -> post a summary to Discord.

const dns = require('node:dns').promises;
const net = require('node:net');
const db = require('../db');

const SOURCES = [
  { label: 'AdoptMatch', url: 'https://www.adoptmatch.com/adoptive-family-financial-assistance-opportunities' },
  { label: 'GovernmentGrant', url: 'https://governmentgrant.com/adoption-grants' },
  { label: 'NCFA', url: 'https://adoptioncouncil.org/article/adoption-financial-resources/' },
  { label: 'Lifesong', url: 'https://www.lifesong.org/adoption/' },
  { label: 'Nightlight', url: 'https://nightlight.org/grant-programs/' },
  { label: 'Open Hearts', url: 'https://openheartsfororphans.org/adoption-grants' },
  { label: 'Help Us Adopt', url: 'https://www.helpusadopt.org/' },
  { label: 'A Child Waits', url: 'https://www.achildwaits.org/' },
  { label: 'Gift of Adoption', url: 'https://giftofadoption.org/apply-for-a-grant/' },
  { label: 'Show Hope', url: 'https://showhope.org/' },
  { label: 'Dave Thomas', url: 'https://www.davethomasfoundation.org/' },
];

const SEARCH_QUERIES = [
  'adoption grant program apply financial assistance',
  'domestic adoption grant 2026 apply now',
  'adoption cost assistance nonprofit grant',
];

const MAX_DISCOVERED_PAGES = 8;
const MAX_CHARS_PER_PAGE = 4000;

const SEARXNG_URL = process.env.SEARXNG_URL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// ── Helpers ──────────────────────────────────────────────────────

function normalizeName(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(inc|llc|ltd|foundation|fund|program|grant)\b/g, '')
    .trim();
}

// Blocks SSRF via scraped/discovered URLs pointing at loopback, private,
// link-local (incl. cloud-metadata 169.254.169.254), or other non-public
// destinations — checked on the initial URL and on every redirect hop.

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 0) return true; // "this" network
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

async function isPublicHttpUrl(urlString) {
  let parsed;
  try { parsed = new URL(urlString); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const hostname = parsed.hostname;
  const ipVersion = net.isIP(hostname);
  if (ipVersion) {
    return ipVersion === 4 ? !isPrivateIPv4(hostname) : !isPrivateIPv6(hostname);
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return false;
  }
  if (addresses.length === 0) return false;
  return addresses.every(({ address, family }) => (family === 4 ? !isPrivateIPv4(address) : !isPrivateIPv6(address)));
}

const MAX_REDIRECTS = 5;

async function scrapePage(url) {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isPublicHttpUrl(currentUrl))) {
      throw new Error(`blocked non-public URL: ${currentUrl}`);
    }
    const resp = await fetch(currentUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AdoptionGrantsBot/1.0)' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    const location = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }
  throw new Error('too many redirects');
}

async function discoverPagesViaSearxng(existingUrls) {
  if (!SEARXNG_URL) {
    console.log('ℹ️  SEARXNG_URL not set — skipping web search discovery.');
    return [];
  }

  const seenUrls = new Set(existingUrls);
  const discovered = [];

  for (const query of SEARCH_QUERIES) {
    if (discovered.length >= MAX_DISCOVERED_PAGES) break;
    try {
      const url = `${SEARXNG_URL.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) { console.log(`  SearXNG query failed ("${query}"): HTTP ${resp.status}`); continue; }
      const json = await resp.json();
      for (const result of json.results || []) {
        if (discovered.length >= MAX_DISCOVERED_PAGES) break;
        if (!result.url || seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        if (!(await isPublicHttpUrl(result.url))) {
          console.log(`  Skipping non-public discovered URL: ${result.url}`);
          continue;
        }
        discovered.push({ label: result.title || result.url, url: result.url });
      }
    } catch (err) {
      console.log(`  SearXNG query error ("${query}"): ${err.message}`);
    }
  }

  return discovered;
}

const SYSTEM_PROMPT = `You extract structured adoption-grant program data from scraped web page text.
Only report programs that are genuinely NEW — skip anything matching a name in the provided "already known" list (case/punctuation-insensitive).
Respond with ONLY a JSON array (no prose, no markdown fences). Each item must have exactly these fields:
name, amount (display string), amountRaw (number, 0 if unknown), type (one of: grant, matching_grant, tax_credit, employer_benefit, federal_assistance, resource), focus, deadline, website, details.
If no new programs are found, respond with an empty array: []`;

function buildExtractionPrompt(pages, dedupNames) {
  const pageBlock = pages
    .map((p) => `[${p.label}] ${p.url}\n${p.text.substring(0, MAX_CHARS_PER_PAGE)}`)
    .join('\n\n---\n\n');
  return `Already known grant programs (skip these):\n${dedupNames.join(', ') || '(none)'}\n\n` +
    `Scraped pages:\n\n${pageBlock}`;
}

function parseGrantsJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try { return JSON.parse(match[0]); } catch { return []; }
  }
}

async function extractGrantsWithLLM(pages, dedupNames) {
  if (!OPENROUTER_API_KEY) {
    console.log('⚠️  OPENROUTER_API_KEY not set — skipping LLM extraction.');
    return [];
  }
  if (pages.length === 0) return [];

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildExtractionPrompt(pages, dedupNames) },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    throw new Error(`OpenRouter API error: HTTP ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '[]';
  const parsed = parseGrantsJson(content);
  return Array.isArray(parsed) ? parsed : [];
}

async function postToDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('⚠️  DISCORD_WEBHOOK_URL not set — skipping Discord post.');
    return;
  }
  const resp = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message.substring(0, 1990) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    console.log(`⚠️  Discord post failed: HTTP ${resp.status} ${await resp.text()}`);
  }
}

function buildDiscordMessage({ weekLabel, pageCount, newGrants, isDryRun }) {
  const header = `🌱 **Adoption Grants Weekly Check — ${weekLabel}**${isDryRun ? ' (dry run)' : ''}\nScanned ${pageCount} page(s).`;

  if (newGrants.length === 0) {
    return `${header}\n\nNo new grants found this week.`;
  }

  const lines = newGrants.map((g) => `• **${g.name}** — ${g.amount || 'amount unknown'} — deadline: ${g.deadline || 'unknown'}\n  ${g.website}`);
  return `${header}\n\n✅ **${newGrants.length} new grant(s) found:**\n${lines.join('\n')}`;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const weekLabel = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  const existingNames = new Set(db.getGrantNames().map(normalizeName));
  console.log(`📊 Existing grants in DB: ${existingNames.size}`);
  if (isDryRun) console.log('🏁 DRY RUN — no DB writes, no Discord post\n');

  const pages = [];

  for (const s of SOURCES) {
    process.stdout.write(`🌐 ${s.label}... `);
    try {
      const text = await scrapePage(s.url);
      pages.push({ label: s.label, url: s.url, text });
      console.log(`${(text.length / 1024).toFixed(0)}KB`);
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
  }

  const discoveredSources = await discoverPagesViaSearxng(SOURCES.map((s) => s.url));
  console.log(`🔎 SearXNG discovered ${discoveredSources.length} additional page(s)`);

  for (const s of discoveredSources) {
    process.stdout.write(`🌐 [discovered] ${s.label}... `);
    try {
      const text = await scrapePage(s.url);
      pages.push({ label: s.label, url: s.url, text });
      console.log(`${(text.length / 1024).toFixed(0)}KB`);
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
  }

  let candidates = [];
  try {
    candidates = await extractGrantsWithLLM(pages, [...existingNames]);
  } catch (err) {
    console.error('💥 LLM extraction failed:', err.message);
  }

  const seenThisRun = new Set();
  const trulyNew = [];
  for (const g of candidates) {
    if (!g || !g.name || !g.website) continue;
    const norm = normalizeName(g.name);
    if (existingNames.has(norm) || seenThisRun.has(norm)) continue;
    seenThisRun.add(norm);
    trulyNew.push(g);
  }

  console.log(`✨ ${trulyNew.length} truly new grant(s) after dedup`);

  if (!isDryRun) {
    for (const g of trulyNew) db.insertGrant(g);
    if (trulyNew.length > 0) db.setMeta('lastUpdated', new Date().toISOString().split('T')[0]);
  }

  const message = buildDiscordMessage({ weekLabel, pageCount: pages.length, newGrants: trulyNew, isDryRun });
  if (isDryRun) {
    console.log(`\n📨 Would post to Discord:\n${message}`);
  } else {
    await postToDiscord(message);
  }
}

module.exports = main;

if (require.main === module) {
  main().catch((err) => {
    console.error('💥', err);
    process.exit(1);
  });
}
