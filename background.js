import {
  normalize,
  titleVariants,
  subtitleBase,
  imdbCandidates,
  fuzzyCandidates,
  pickImdb,
  parseNetflixMeta,
  parseRtSearch,
  parseRtPageScore,
  pickRt,
} from './match.js';

const RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const EPISODES_URL = 'https://datasets.imdbws.com/title.episode.tsv.gz';
const RATINGS_MAX_AGE = 7 * 24 * 3600 * 1000;
const RATINGS_SCHEMA = 2; // bump to force a fresh download
const SHARDS = 1000;
const TTL_FOUND = 14 * 24 * 3600 * 1000;
const TTL_MISSING = 3 * 24 * 3600 * 1000;
const TTL_RT_FAILED = 3600 * 1000;

// --- IndexedDB -------------------------------------------------------------

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('netflix-ratings', 2);
    req.onupgradeneeded = () => {
      for (const store of ['shards', 'titles', 'episodes']) {
        if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(store, key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- IMDb ratings dataset --------------------------------------------------

const shardOf = (id) => Number(id.slice(2)) % SHARDS;

async function forEachLine(url, onLine) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`IMDb dataset HTTP ${res.status}`);
  const reader = res.body
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let tail = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = (tail + value).split('\n');
    tail = lines.pop();
    lines.forEach(onLine);
  }
  if (tail) onLine(tail);
}

async function downloadRatings() {
  const shards = Array.from({ length: SHARDS }, () => []);
  let count = 0;
  await forEachLine(RATINGS_URL, (line) => {
    const [id, rating, votes] = line.split('\t');
    if (!id?.startsWith('tt') || !votes) return;
    shards[shardOf(id)].push(`${id},${rating},${votes}`);
    count++;
  });
  if (count < 1000) throw new Error('IMDb dataset looks truncated');

  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction('shards', 'readwrite');
    const store = tx.objectStore('shards');
    shards.forEach((rows, i) => store.put(`;${rows.join(';')};`, i));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await chrome.storage.local.set({ ratingsUpdated: Date.now(), ratingsCount: count, ratingsSchema: RATINGS_SCHEMA });
}

let ratingsPromise;
async function ensureRatings() {
  const { ratingsUpdated, ratingsSchema } = await chrome.storage.local.get(['ratingsUpdated', 'ratingsSchema']);
  if (ratingsSchema === RATINGS_SCHEMA && ratingsUpdated && Date.now() - ratingsUpdated < RATINGS_MAX_AGE) return;
  ratingsPromise ??= downloadRatings().finally(() => {
    ratingsPromise = undefined;
  });
  try {
    await ratingsPromise;
  } catch (err) {
    if (!ratingsUpdated) throw err; // older data is still usable
    console.warn('Ratings refresh failed', err);
  }
}

async function ratingFor(id) {
  const shard = await idbGet('shards', shardOf(id));
  if (!shard) return null;
  const start = shard.indexOf(`;${id},`);
  if (start < 0) return null;
  const [, rating, votes] = shard.slice(start + 1, shard.indexOf(';', start + 1)).split(',');
  return { rating: Number(rating), votes: Number(votes) };
}

// --- IMDb episode dataset -------------------------------------------------

async function ratedTitles() {
  const d = await db();
  const shards = await new Promise((resolve, reject) => {
    const req = d.transaction('shards').objectStore('shards').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const rated = new Map();
  for (const shard of shards) {
    for (const entry of shard.split(';')) {
      if (entry) {
        const [id, rating, votes] = entry.split(',');
        rated.set(Number(id.slice(2)), `${rating},${votes}`);
      }
    }
  }
  return rated;
}

async function downloadEpisodes() {
  // A long download can outlive the service worker's idle limit without this.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    const rated = await ratedTitles();
    const shards = Array.from({ length: SHARDS }, () => []);
    let count = 0;
    await forEachLine(EPISODES_URL, (line) => {
      const [id, parent, season, episode] = line.split('\t');
      if (!id?.startsWith('tt') || !/^\d+$/.test(season) || !/^\d+$/.test(episode)) return;
      const score = rated.get(Number(id.slice(2)));
      if (!score) return;
      shards[shardOf(parent)].push(`${parent},${season},${episode},${score}`);
      count++;
    });
    if (count < 1000) throw new Error('IMDb episode dataset looks truncated');
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction('episodes', 'readwrite');
      const store = tx.objectStore('episodes');
      shards.forEach((rows, i) => store.put(`;${rows.join(';')};`, i));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await chrome.storage.local.set({ episodesUpdated: Date.now() });
  } finally {
    clearInterval(keepAlive);
  }
}

let episodesPromise;
async function ensureEpisodes() {
  await ensureRatings();
  const { episodesUpdated } = await chrome.storage.local.get('episodesUpdated');
  if (episodesUpdated && Date.now() - episodesUpdated < RATINGS_MAX_AGE) return;
  episodesPromise ??= downloadEpisodes().finally(() => {
    episodesPromise = undefined;
  });
  try {
    await episodesPromise;
  } catch (err) {
    if (!episodesUpdated) throw err; // older data is still usable
    console.warn('Episode data refresh failed', err);
  }
}

async function episodeScores(imdbId, season) {
  await ensureEpisodes();
  const shard = await idbGet('episodes', shardOf(imdbId));
  const scores = {};
  const prefix = `;${imdbId},${season},`;
  for (let at = shard ? shard.indexOf(prefix) : -1; at >= 0; at = shard.indexOf(prefix, at + 1)) {
    const [, , episode, rating, votes] = shard.slice(at + 1, shard.indexOf(';', at + 1)).split(',');
    scores[episode] = { rating: Number(rating), votes: Number(votes) };
  }
  return scores;
}

// --- Lookups ---------------------------------------------------------------

async function fetchOk(url, as) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return as === 'json' ? res.json() : res.text();
}

async function suggest(query) {
  const q = encodeURIComponent(query.toLowerCase().replace(/%/g, ' percent').replace(/[/#?]/g, ' ').trim());
  if (!q) return [];
  const data = await fetchOk(`https://v3.sg.media-imdb.com/suggestion/x/${q}.json`, 'json');
  return data.d || [];
}

async function findImdb(title, netflixId, episodic) {
  let meta = null;
  let metaLoaded = false;
  const loadMeta = async () => {
    if (!metaLoaded) {
      metaLoaded = true;
      try {
        meta = parseNetflixMeta(await fetchOk(`https://www.netflix.com/title/${netflixId}`));
      } catch (err) {
        console.warn('Netflix metadata unavailable', err);
      }
    }
    return meta;
  };
  const choose = async (candidates) => {
    await Promise.all(candidates.map(async (c) => Object.assign(c, await ratingFor(c.id))));
    if (candidates.length > 1) await loadMeta();
    return pickImdb(candidates, meta);
  };
  const exact = async (name) => {
    for (const variant of titleVariants(name)) {
      const candidates = imdbCandidates(await suggest(variant), variant);
      if (candidates.length) return choose(candidates);
    }
    return null;
  };

  // Episode cards are labelled with the episode name, so the show name comes from Netflix.
  const names = episodic ? [] : [title];
  const netflixName = (await (episodic ? loadMeta() : null))?.name;
  if (episodic && netflixName) names.push(netflixName);
  for (const name of names) {
    const hit = await exact(name);
    if (hit) return hit;
  }
  const canonical = (await loadMeta())?.name;
  if (canonical && !names.includes(canonical)) {
    names.push(canonical);
    const hit = await exact(canonical);
    if (hit) return hit;
  }
  for (const name of names) {
    const base = subtitleBase(name);
    const hit = base && (await exact(base));
    if (hit) return { ...hit, approx: true };
    for (const variant of titleVariants(name)) {
      const candidates = fuzzyCandidates(await suggest(variant), variant);
      if (candidates.length) return { ...(await choose(candidates)), approx: true };
    }
  }
  return null;
}

async function findRt(imdb) {
  const q = encodeURIComponent(imdb.title);
  const html = await fetchOk(`https://www.rottentomatoes.com/search?search=${q}`);
  const rt = pickRt(parseRtSearch(html), imdb);
  if (rt && rt.score == null && rt.type === 'tvSeries') {
    rt.score = parseRtPageScore(await fetchOk(rt.url));
  }
  return rt;
}

async function resolveTitle(title, netflixId, episodic) {
  await ensureRatings();
  const imdb = await findImdb(title, netflixId, episodic);
  if (!imdb) return { result: { found: false }, ttl: TTL_MISSING };

  const result = {
    found: true,
    matched: imdb.title,
    year: imdb.year,
    imdbId: imdb.id,
    imdbRating: imdb.rating ?? null,
    imdbVotes: imdb.votes ?? null,
    approx: !!imdb.approx,
    rtScore: null,
    rtUrl: null,
  };
  let ttl = TTL_FOUND;
  try {
    const rt = await findRt(imdb);
    result.rtScore = rt?.score ?? null;
    result.rtUrl = rt?.url ?? null;
  } catch (err) {
    console.warn('Rotten Tomatoes lookup failed', err);
    ttl = TTL_RT_FAILED;
  }
  return { result, ttl };
}

const inflight = new Map();

async function lookup(title, netflixId, episodic) {
  const key = `v4:${netflixId}:${normalize(title)}`; // bump to discard old cached matches
  const cached = await idbGet('titles', key);
  if (cached && cached.expires > Date.now()) return cached.result;
  if (!inflight.has(key)) {
    const job = resolveTitle(title, netflixId, episodic)
      .then(async ({ result, ttl }) => {
        await idbPut('titles', key, { result, expires: Date.now() + ttl });
        return result;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return inflight.get(key);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const job =
    msg?.type === 'lookup'
      ? lookup(msg.title, msg.id, !!msg.episodic).then((result) => ({ result }))
      : msg?.type === 'episodes'
        ? episodeScores(msg.imdbId, msg.season).then((scores) => ({ scores }))
        : null;
  if (!job) return false;
  job.then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  ensureEpisodes().catch((err) => console.warn('Initial IMDb download failed', err));
});
