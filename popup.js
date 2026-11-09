const DEFAULTS = { enabled: true, minImdb: 0, minRt: 0, hideUnrated: false, mode: 'hide' };
const $ = (id) => document.getElementById(id);

function showValue(input, output, format) {
  const value = Number(input.value);
  output.textContent = value === 0 ? 'Off' : format(value);
  output.classList.toggle('is-off', value === 0);
  input.style.setProperty('--fill', `${(value / Number(input.max)) * 100}%`);
}

function showValues() {
  showValue($('minImdb'), $('minImdbValue'), (v) => v.toFixed(1));
  showValue($('minRt'), $('minRtValue'), (v) => `${v}%`);
  document.body.classList.toggle('off', !$('enabled').checked);
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('enabled').checked = s.enabled;
  $('minImdb').value = s.minImdb;
  $('minRt').value = s.minRt;
  $('hideUnrated').checked = s.hideUnrated;
  document.querySelector(`input[name="mode"][value="${s.mode}"]`).checked = true;
  showValues();

  $('enabled').addEventListener('change', (e) => {
    showValues();
    chrome.storage.sync.set({ enabled: e.target.checked });
  });
  $('hideUnrated').addEventListener('change', (e) => chrome.storage.sync.set({ hideUnrated: e.target.checked }));
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', (e) => chrome.storage.sync.set({ mode: e.target.value }));
  }
  for (const key of ['minImdb', 'minRt']) {
    $(key).addEventListener('input', showValues);
    $(key).addEventListener('change', (e) => chrome.storage.sync.set({ [key]: Number(e.target.value) }));
  }

  const { ratingsUpdated, ratingsCount } = await chrome.storage.local.get(['ratingsUpdated', 'ratingsCount']);
  $('status').textContent = ratingsUpdated
    ? `${(ratingsCount / 1e6).toFixed(1)}M IMDb scores · Updated ${new Date(ratingsUpdated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : 'Downloading IMDb scores…';
}

init();
