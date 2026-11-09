// Pure title-matching and parsing logic. No browser APIs, so it can be tested in Node.

const IMDB_TYPES = new Set(['movie', 'tvMovie', 'tvSeries', 'tvMiniSeries', 'tvSpecial']);
const EDITION_SUFFIX = /\s*[:\-–—]\s*(director.?s cut|extended (cut|edition)|the series|limited series)\s*$/i;

export function normalize(title) {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
}

// Netflix decorates some titles, e.g. "The Office (U.S.)" or "X: Director's Cut".
export function titleVariants(title) {
  const variants = [title];
  const noParens = title.replace(/\s*\([^)]*\)\s*$/, '');
  if (noParens && noParens !== title) variants.push(noParens);
  const noEdition = noParens.replace(EDITION_SUFFIX, '');
  if (noEdition && noEdition !== noParens) variants.push(noEdition);
  return variants;
}

// "Monster: The Lizzie Borden Story" is listed on IMDb under "Monster".
export function subtitleBase(title) {
  const base = title.split(/\s*[:—–]\s*/)[0].trim();
  return base && base !== title && normalize(base).length >= 3 ? base : null;
}

function toCandidate(s) {
  return { id: s.id, title: s.l, year: s.y ?? null, endYear: s.ye ?? null, qid: s.qid };
}

// Looser fallback, used only after exact matching fails: the IMDb title must begin
// with the whole Netflix title (two words or more) or share at least 70% of its words.
export function fuzzyCandidates(suggestions, title) {
  const wanted = normalize(title);
  const tokens = new Set(wanted.split(' '));
  return (suggestions || [])
    .filter((s) => {
      if (!s.id?.startsWith('tt') || !IMDB_TYPES.has(s.qid) || !s.l) return false;
      const other = normalize(s.l);
      if (tokens.size >= 2 && other.startsWith(`${wanted} `)) return true;
      const otherTokens = new Set(other.split(' '));
      const shared = [...tokens].filter((t) => otherTokens.has(t)).length;
      return tokens.size >= 2 && shared / new Set([...tokens, ...otherTokens]).size >= 0.7;
    })
    .map(toCandidate);
}

export function isTvType(qid) {
  return qid === 'tvSeries' || qid === 'tvMiniSeries';
}

// Only exact (normalized) title matches count: a missing score beats a wrong one.
export function imdbCandidates(suggestions, title) {
  const wanted = normalize(title);
  return (suggestions || [])
    .filter((s) => s.id?.startsWith('tt') && IMDB_TYPES.has(s.qid) && s.l && normalize(s.l) === wanted)
    .map(toCandidate);
}

// candidates carry `votes`. meta (optional) is { isTv, startYearHint } from Netflix.
export function pickImdb(candidates, meta) {
  if (!candidates.length) return null;
  let pool = candidates;
  if (meta) {
    const sameKind = pool.filter((c) => isTvType(c.qid) === meta.isTv);
    if (sameKind.length) pool = sameKind;
    if (meta.startYearHint) {
      const sameYear = pool.filter((c) => c.year && Math.abs(c.year - meta.startYearHint) <= 1);
      if (sameYear.length) pool = sameYear;
    }
  }
  return [...pool].sort((a, b) => (b.votes || 0) - (a.votes || 0))[0];
}

export function parseNetflixMeta(html) {
  const m = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const isTv = data['@type'] === 'TVSeries';
  // dateCreated is the latest season for shows and the licence date for films,
  // so it only identifies the start year of a single-season show.
  const year = parseInt(String(data.dateCreated || ''), 10);
  const startYearHint = isTv && data.numberOfSeasons === 1 && year ? year : null;
  return { isTv, startYearHint, name: typeof data.name === 'string' ? data.name : null };
}

function attr(block, name) {
  const m = block.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : '';
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function parseRtSearch(html) {
  const rows = [];
  for (const section of html.split('<search-page-result').slice(1)) {
    const type = attr(section.slice(0, 300), 'type');
    if (type !== 'movie' && type !== 'tvSeries') continue;
    for (const row of section.split('<search-page-media-row').slice(1)) {
      const link = row.match(/<a\b[^>]*href="([^"]+)"[^>]*data-qa="info-name"[^>]*>\s*([\s\S]*?)\s*<\/a>/);
      if (!link) continue;
      // Movie rows use hyphenated attributes (start-year); TV rows do not (startyear).
      const score = attr(row, 'tomatometer-?score');
      rows.push({
        type,
        title: decodeEntities(link[2]),
        url: link[1],
        year: parseInt(attr(row, 'release-?year') || attr(row, 'start-?year'), 10) || null,
        score: score === '' ? null : Number(score),
      });
    }
  }
  return rows;
}

// Search results omit scores for TV, so those come from the show's own page.
export function parseRtPageScore(html) {
  const m = html.match(/"criticsScore":\{[^}]*?"scorePercent":"(\d+)%"/);
  return m ? Number(m[1]) : null;
}

// A Rotten Tomatoes result must agree with the chosen IMDb title on name, kind and year.
export function pickRt(rows, imdb) {
  const wantType = isTvType(imdb.qid) ? 'tvSeries' : 'movie';
  const wanted = normalize(imdb.title);
  const matches = rows.filter((r) => r.type === wantType && normalize(r.title) === wanted);
  const byYear = matches.filter((r) => r.year && imdb.year && Math.abs(r.year - imdb.year) <= 1);
  if (byYear.length) return byYear[0];
  // TV rows often omit the year; accept only when the name is unambiguous.
  if (matches.length === 1 && !matches[0].year) return matches[0];
  return null;
}
