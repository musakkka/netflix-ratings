(() => {
  const DEFAULTS = { enabled: true, minImdb: 0, minRt: 0, hideUnrated: false, mode: 'hide' };
  const CARD_SELECTOR = 'a[aria-label][href*="jbv="], a[aria-label][href*="/watch/"]';
  const MAX_CONCURRENT = 6;
  const PAGE_DELAY_MS = 900;
  const MAX_PAGES_PER_ROW = 25;
  const STALE_PAGES_TO_STOP = 2;

  let settings = { ...DEFAULTS };
  const results = new Map(); // netflixId -> result, or null while loading
  const rowStates = new WeakMap();
  const queue = [];
  let active = 0;
  let harvesting = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function netflixId(anchor) {
    const href = anchor.getAttribute('href') || '';
    return href.match(/[?&]jbv=(\d+)/)?.[1] || href.match(/\/watch\/(\d+)/)?.[1] || null;
  }

  // The element to remove so a grid closes up around the gap.
  function cardContainer(anchor) {
    const known = anchor.closest('[data-virtual-slot], .slider-item');
    if (known) return known;
    let node = anchor;
    while (node.parentElement && node.parentElement.children.length === 1) node = node.parentElement;
    return node;
  }

  function rowOf(anchor) {
    return anchor.closest('.carousel-row') || anchor.closest('[data-uia="carousel-scroller"]')?.parentElement || null;
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const { id, title, episodic } = queue.shift();
      active++;
      chrome.runtime
        .sendMessage({ type: 'lookup', id, title, episodic })
        .then((res) => {
          if (res?.result) results.set(id, res.result);
          else results.delete(id); // transient failure: retry on a later scan
          if (res?.error) console.warn('[Netflix Ratings]', title, res.error);
        })
        .catch(() => results.delete(id))
        .finally(() => {
          active--;
          scheduleRender();
          pump();
        });
    }
  }

  function shelvingActive() {
    return settings.enabled && settings.mode === 'hide' && (settings.minImdb > 0 || settings.minRt > 0 || settings.hideUnrated);
  }

  function isFiltered(r) {
    if (!settings.enabled || !r) return false;
    const hasImdb = r.found && r.imdbRating != null;
    if (!hasImdb) {
      if (settings.hideUnrated) return true;
    } else if (r.imdbRating < settings.minImdb) {
      return true;
    }
    return r.found && r.rtScore != null && r.rtScore < settings.minRt;
  }

  function badgeText(r) {
    const imdb = r.found && r.imdbRating != null ? `${r.approx ? '≈' : ''}${r.imdbRating.toFixed(1)}` : '–';
    const rt = r.found && r.rtScore != null ? `${r.rtScore}%` : '–';
    return `${imdb}|${rt}|${r.found && r.rtScore != null && r.rtScore >= 60 ? 'fresh' : 'rotten'}`;
  }

  function icon(path, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    return svg;
  }

  function logo(name, className) {
    const { viewBox, paths } = globalThis.NFR_LOGOS[name];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    for (const [d, fill] of paths) {
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute('d', d);
      shape.setAttribute('fill', fill);
      svg.append(shape);
    }
    return svg;
  }

  function score(mark, value) {
    const el = document.createElement('span');
    el.className = 'nfr-score';
    el.append(mark);
    if (value.startsWith('≈')) {
      const approx = document.createElement('span');
      approx.className = 'nfr-approx';
      approx.textContent = '≈';
      el.append(approx);
    }
    el.append(value.replace('≈', ''));
    return el;
  }

  function renderBadge(anchor, r) {
    let badge = anchor.querySelector(':scope > .nfr-badges');
    if (!settings.enabled || !r) {
      badge?.remove();
      return;
    }
    const text = badgeText(r);
    if (badge?.dataset.text === text) return;
    badge?.remove();
    badge = document.createElement('div');
    badge.className = 'nfr-badges';
    badge.dataset.text = text;
    const [imdb, rt, state] = text.split('|');
    if (imdb !== '–') badge.append(score(logo('imdb', 'nfr-logo-imdb'), imdb));
    if (rt !== '–') badge.append(score(logo(state === 'fresh' ? 'rtFresh' : 'rtRotten', 'nfr-logo-rt'), rt));
    if (imdb === '–' && rt === '–') {
      const none = document.createElement('span');
      none.className = 'nfr-none';
      none.textContent = 'Unrated';
      badge.append(none);
    }
    const parts = [];
    if (imdb !== '–') parts.push(`IMDb ${imdb}`);
    if (rt !== '–') parts.push(`Rotten Tomatoes ${rt}`);
    if (r.found) parts.push(`${r.approx ? 'Closest match' : 'Matched'}: ${r.matched}${r.year ? ` (${r.year})` : ''}`);
    badge.title = parts.length ? parts.join(' · ') : 'No rating found';
    if (getComputedStyle(anchor).position === 'static') anchor.classList.add('nfr-anchor');
    anchor.append(badge);
  }

  function setClass(el, name, on) {
    if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
  }

  function rowState(row) {
    let state = rowStates.get(row);
    if (!state) {
      state = { items: new Map(), cards: new Map(), shelf: null, track: null, pages: 0, stale: 0, done: false };
      rowStates.set(row, state);
    }
    return state;
  }

  function updateArrows(shelf, track) {
    setClass(shelf, 'nfr-at-start', track.scrollLeft <= 1);
    setClass(shelf, 'nfr-at-end', track.scrollLeft + track.clientWidth >= track.scrollWidth - 1);
  }

  // Lines the shelf up with Netflix's row heading, whatever gutter this page uses.
  function alignShelf(row, shelf) {
    const heading = row.querySelector('h2, h3, [role="heading"]');
    if (!heading) return;
    const gutter = `${Math.round(heading.getBoundingClientRect().left - row.getBoundingClientRect().left)}px`;
    if (shelf.style.getPropertyValue('--nfr-gutter') !== gutter) shelf.style.setProperty('--nfr-gutter', gutter);
  }

  function buildShelf(state) {
    const shelf = document.createElement('div');
    shelf.className = 'nfr-shelf';
    const track = document.createElement('div');
    track.className = 'nfr-track';
    const arrow = (side, direction, path) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `nfr-arrow nfr-arrow-${side}`;
      button.append(icon(path));
      button.setAttribute('aria-label', direction > 0 ? 'Scroll right' : 'Scroll left');
      button.addEventListener('click', () => track.scrollBy({ left: direction * track.clientWidth * 0.9 }));
      return button;
    };
    shelf.append(track, arrow('left', -1, 'M10 3 5 8l5 5'), arrow('right', 1, 'M6 3l5 5-5 5'));
    track.addEventListener('scroll', () => updateArrows(shelf, track), { passive: true });
    state.shelf = shelf;
    state.track = track;
  }

  function buildCard(item) {
    const card = document.createElement('a');
    card.className = 'nfr-card';
    card.href = item.href;
    card.setAttribute('aria-label', item.title);
    if (item.image) {
      const img = document.createElement('img');
      img.src = item.image;
      img.alt = '';
      img.loading = 'lazy';
      card.append(img);
    } else {
      const label = document.createElement('span');
      label.className = 'nfr-card-title';
      label.textContent = item.title;
      card.append(label);
    }
    return card;
  }

  function renderShelf(row, state) {
    const scroller = row.querySelector('[data-uia="carousel-scroller"]');
    if (!scroller) return false;
    setClass(row, 'nfr-shelved', true);
    if (!state.shelf) buildShelf(state);
    if (!state.shelf.isConnected) scroller.before(state.shelf);

    const wanted = [];
    for (const item of state.items.values()) {
      const r = results.get(item.id);
      if (!r || isFiltered(r)) continue;
      let card = state.cards.get(item.id);
      if (!card) {
        card = buildCard(item);
        state.cards.set(item.id, card);
      }
      renderBadge(card, r);
      wanted.push(card);
    }
    const current = [...state.track.children];
    if (current.length !== wanted.length || current.some((el, i) => el !== wanted[i])) {
      state.track.replaceChildren(...wanted);
    }
    const nothingPending = [...state.items.values()].every((item) => results.get(item.id));
    const finishedEmpty = state.done && nothingPending && wanted.length === 0;
    setClass(row, 'nfr-hidden', finishedEmpty);
    // Collapsed rather than display:none so Netflix's row can keep paging meanwhile.
    setClass(row, 'nfr-empty', wanted.length === 0 && !finishedEmpty);
    alignShelf(row, state.shelf);
    updateArrows(state.shelf, state.track);
    return true;
  }

  function clearShelves() {
    for (const row of document.querySelectorAll('.nfr-shelved')) {
      const state = rowStates.get(row);
      state?.shelf?.remove();
      row.classList.remove('nfr-shelved', 'nfr-hidden', 'nfr-empty');
    }
  }

  function render() {
    const shelving = shelvingActive();
    if (!shelving) clearShelves();

    const rows = new Set();
    for (const anchor of document.querySelectorAll(CARD_SELECTOR)) {
      if (anchor.closest('.nfr-shelf') || anchor.matches('.playLink, [data-uia="play-button"]')) continue;
      const id = netflixId(anchor);
      const title = anchor.getAttribute('aria-label')?.trim();
      if (!id || !title) continue;

      if (settings.enabled && !results.has(id)) {
        results.set(id, null);
        queue.push({ id, title, episodic: anchor.dataset.uia === 'episodic-card' });
      }
      const r = results.get(id) ?? null;
      renderBadge(anchor, r);

      const row = rowOf(anchor);
      const container = cardContainer(anchor);
      if (shelving && row) {
        const state = rowState(row);
        if (!state.items.has(id)) {
          const src = anchor.querySelector('img')?.currentSrc || anchor.querySelector('img')?.src || '';
          state.items.set(id, { id, title, href: anchor.href, image: src.startsWith('http') ? src : null });
        }
        rows.add(row);
        setClass(container, 'nfr-hidden', false);
        setClass(container, 'nfr-dim', false);
      } else {
        const filtered = isFiltered(r);
        setClass(container, 'nfr-hidden', filtered && settings.mode === 'hide');
        setClass(container, 'nfr-dim', filtered && settings.mode === 'dim');
      }
    }
    for (const row of rows) renderShelf(row, rowState(row));
    renderEpisodes();
    pump();
    if (shelving) harvest();
  }

  // --- Episode scores in the details panel ---

  const episodeData = new Map(); // "netflixId:season" -> { episode: { rating, votes } }, null while loading

  function panelTitleId() {
    return new URLSearchParams(location.search).get('jbv') || location.pathname.match(/\/title\/(\d+)/)?.[1] || null;
  }

  // Only numbered seasons line up with IMDb. Single-season shows have no season menu.
  function panelSeason(selector) {
    const menu = selector.querySelector('.episodeSelector-dropdown');
    const label = menu?.textContent.trim();
    if (!label) return 1;
    const match = label.match(/season\s+(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  async function loadEpisodes(id, season, key) {
    let scores = {};
    try {
      let show = results.get(id);
      if (!show) show = (await chrome.runtime.sendMessage({ type: 'lookup', id, title: 'show', episodic: true }))?.result;
      // A closest-match show can number its seasons differently, so it gets no episode scores.
      if (show?.found && !show.approx) {
        const res = await chrome.runtime.sendMessage({ type: 'episodes', imdbId: show.imdbId, season });
        if (res?.error) console.warn('[Netflix Ratings]', res.error);
        scores = res?.scores || {};
      }
    } catch (err) {
      console.warn('[Netflix Ratings]', err);
    }
    episodeData.set(key, scores);
    scheduleRender();
  }

  function renderEpisodeChip(item, position, scores) {
    const image = item.querySelector('.titleCard-imageWrapper');
    if (!image) return;
    const shown = Number(item.querySelector('.titleCard-title_index')?.textContent.trim());
    const episode = scores?.[shown || position];
    let chip = image.querySelector(':scope > .nfr-badges');
    const text = episode ? episode.rating.toFixed(1) : '';
    if ((chip?.dataset.text ?? '') === text) return;
    chip?.remove();
    if (!episode) return;
    chip = document.createElement('div');
    chip.className = 'nfr-badges';
    chip.dataset.text = text;
    chip.title = `IMDb ${text} · ${episode.votes.toLocaleString()} votes`;
    chip.append(score(logo('imdb', 'nfr-logo-imdb'), text));
    image.append(chip);
  }

  function renderEpisodes() {
    const selector = document.querySelector('.detail-modal .episodeSelector');
    if (!selector) return;
    const id = panelTitleId();
    const season = panelSeason(selector);
    let scores = null;
    if (settings.enabled && id && season) {
      const key = `${id}:${season}`;
      if (!episodeData.has(key)) {
        episodeData.set(key, null);
        loadEpisodes(id, season, key);
      }
      scores = episodeData.get(key);
    }
    selector.querySelectorAll('.titleCardList--container').forEach((item, i) => renderEpisodeChip(item, i + 1, scores));
  }

  // Pages each filtered row near the viewport so the shelf can fill with titles that pass.
  function nextRowToPage() {
    for (const row of document.querySelectorAll('.nfr-shelved')) {
      const state = rowStates.get(row);
      if (!state || state.done) continue;
      if (row.getBoundingClientRect().top < window.innerHeight * 3) return row;
    }
    return null;
  }

  async function harvest() {
    if (harvesting) return;
    harvesting = true;
    try {
      while (shelvingActive()) {
        const row = nextRowToPage();
        if (!row) break;
        const state = rowStates.get(row);
        const next = row.querySelector('[data-uia="carousel-hawkins-right-button"], button[aria-label="See more titles"]');
        if (!next || next.disabled) {
          state.done = true;
          continue;
        }
        const before = state.items.size;
        next.click();
        state.pages++;
        await sleep(PAGE_DELAY_MS);
        render();
        state.stale = state.items.size === before ? state.stale + 1 : 0;
        if (state.stale >= STALE_PAGES_TO_STOP || state.pages >= MAX_PAGES_PER_ROW) state.done = true;
      }
    } finally {
      harvesting = false;
      scheduleRender();
    }
  }

  let scheduled = false;
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        render();
      } catch (err) {
        if (!chrome.runtime?.id) observer.disconnect(); // extension was reloaded
        else console.warn('[Netflix Ratings]', err);
      }
    }, 150);
  }

  const observer = new MutationObserver(scheduleRender);

  chrome.storage.sync.get(DEFAULTS).then((stored) => {
    settings = stored;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'href'],
    });
    window.addEventListener('scroll', scheduleRender, { passive: true });
    scheduleRender();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
    scheduleRender();
  });
})();
