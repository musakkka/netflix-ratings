# Netflix Ratings

A Chrome and Brave extension that shows IMDb and Rotten Tomatoes scores on Netflix and filters out titles below a score you choose.

## Features

- IMDb and Tomatometer scores on title cards on Home, Movies and Shows.
- Minimum IMDb and Tomatometer scores, with titles below them hidden or dimmed.
- When titles are hidden, the row keeps loading more from Netflix so it stays full.
- IMDb scores for each episode in a show's details panel.

## Install

The extension is not in the Chrome Web Store, so load it from source:

1. Download or clone this repository.
2. Open `chrome://extensions` (or `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the repository folder.

The first run downloads IMDb's ratings file (about 9 MB) and episode file (about 55 MB). Both refresh weekly.

Brave has Netflix's DRM turned off by default. If playback shows error M7702-1003, turn on Widevine at `brave://settings/extensions` and relaunch.

## How it works

| File | Purpose |
| --- | --- |
| `content.js` | Finds Netflix cards, draws scores, applies the filter and builds filtered rows |
| `background.js` | Downloads and indexes IMDb data, resolves titles and caches results in IndexedDB |
| `match.js` | Title normalization, candidate matching and Rotten Tomatoes parsing |
| `popup.*` | The settings panel |
| `logos.js`, `logos/` | IMDb and Rotten Tomatoes marks |

## Privacy

There is no server, account or analytics. Your settings and cached scores stay in your browser. To look up a score, the extension sends the title's name to IMDb's search endpoint and Rotten Tomatoes, and reads Netflix's public title page.

## Known limits

- Netflix's page structure is undocumented, so a Netflix update can break the extension.
- Episodes are matched by season and episode number. A show that Netflix numbers differently from IMDb can get the wrong score.
- Episodes have no score under "See All Episodes", in seasons labelled something like "Part 1", or for shows marked "≈" (closest match).
- Episodes show IMDb scores only and are not filtered.
- Rotten Tomatoes scores are read from its public web pages, so a site change can stop them from appearing.

## Data and trademarks

This project is not affiliated with or endorsed by Netflix, IMDb or Rotten Tomatoes. Their names and logos are trademarks of their respective owners and are **not** covered by this repository's license.

The extension downloads [IMDb's non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/) directly to each user's browser, and no IMDb data is stored in this repository. Those datasets are for personal, non-commercial use, and you are responsible for following the terms of each service.

## License

The code is available under the [MIT License](LICENSE). It does not cover the logos, as explained in [NOTICE](NOTICE).
