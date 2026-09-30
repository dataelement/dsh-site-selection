# Store Site Selection Workbench

[简体中文](README.md) | **English**

A DSH (DeepSeek Harness) plugin. **Click anywhere on a real 3D city map and get a site analysis for that point instantly.**
Describe what you want to DSH in plain language and it searches with the same model, in bulk, and writes candidates into your list. Pick a location you like and pull in the shops for rent around it. Record your site visits and the conversation on the right always knows which point you have selected.

## Features

- **Click to score.** Any point on the map is analyzed in milliseconds: three dimension scores, a percentile for every metric, risk flags and the customer mix.
- **Scores by format.** A coffee shop and a pharmacy score differently at the same point. The baseline is the location distribution of existing stores of the same format in this city.
- **Search in plain language.** "Within 200 m of a metro exit, lots of restaurants, no more than 3 competitors, find 10." DSH turns it into a query and runs it on the same data.
- **Two-level list: locations → listings.** Judge the location first, then see what is for rent there. A listing you pull in is attached to the nearest location automatically. Map, list and detail all draw listings in their own tan color so they never blend with locations.
- **Listings layer.** Overlay shops for rent on the map with one click, labeled with rent (CNY/㎡/day). Opening a location lists the shops within 400 m.
- **Candidate list.** Every metric of every point side by side, sorted by score. Click a row to locate it on the map.
- **3D city base map.** Real road network, land use, building footprints and heights, drawn on canvas. No tiles, no API key, works offline.
- **Site-visit loop.** To visit → visited → in review → signed / rejected, each step one click in the list. Decisions are recorded and can be reverted.
- **Add a city with one command.** `fetch-city.mjs` builds the dataset. Restart and it is ready, no code changes.

## Desktop workbench adapter (1.2.2)

Requires DSH Desktop exposing `desktopWorkbenches.register`, `isActive`, and `ownsSession`. Once the provider plugin is installed, add and open Store Site Selection from Workbench Market. Desktop owns pinning, repository identity, switching, and session ownership. The runtime ID is `wb-dataelement-dsh-site-selection`; the market entry declares `legacyWorkbenchIds: [site-selection]` so Desktop can migrate state, favorites, and session ownership from older local installations.

The business panel occupies 65% on the left and the native conversation remains the single Agent input. Public navigation, settings, modes, models, tools and permissions stay under Desktop and the current native session. Creating a business project asks Desktop to create and open a workbench-owned native session. Opening an existing business project does not create a session.

Open the workbench to select, create and edit a business project immediately. Creating a project opens a native session and fills its draft with the onboarding prompt for review; it does not send the prompt. Existing projects remain browsable and editable without a session. A business project is independent of a native workspace folder. Several sessions can share a business project; each session remembers its own selection in `.desktop-session-projects.json` in the data root. Without a session, the last business selection is stored in localStorage for the current Desktop origin. A new session inherits that selection; explicit existing session mappings take precedence. Legacy project.sessionId is a selection hint only and cannot revive old sessions or workspaces.

Switching workbenches or sessions preserves mounted business iframes. Only messages from the active owned session and its exact same-origin frame can append to the native draft, without replacing text or sending it. Save business form changes before leaving the entire workbench page or restarting.

```bash
npm run check
npm pack --dry-run
```

The package contains client/server code, city data, and samples. `workbench.json` remains only for older tooling; the current market contract uses `package.json`, runtime registration, and genuine screenshots in this repository. The host plugin installer loads the provider, after which Desktop can merge it with the market entry. Public listing still requires a separate directory pull request to `awesome-dsh-workbench`.

The current market metadata draft lives at [`docs/market-entry.yml`](docs/market-entry.yml). It supports source review and the later directory submission; Desktop does not read it as runtime configuration.

## Screenshots

![3D map and site candidates](docs/screenshots/site-map.png)

![Site detail and scoring evidence](docs/screenshots/site-detail.png)

![Reference baseline and metric distribution](docs/screenshots/site-reference.png)

## Data and capability boundaries

Maps, scoring, candidate/listing/project CRUD and site visit records remain available. Bundled city data supports offline maps; simulated commercial data remains labeled separately. “Ask DSH” adds project paths and selection context to the current draft; file access still needs native session tools and authorization and does not expand workspace permissions. Deleting a business project moves it to .trash without deleting DSH sessions or workspaces. Removing the workbench entry does not erase business data.

All API and iframe asset routes use the host connection request authentication gate. Writes require same-origin JSON. File reads reject symlink escape from the business project. The bridge checks origin, source window, business project and active session/workbench ownership.

## Quick start

Open the workbench → project dropdown → pick a sample:

| Sample | Scenario | Candidates |
|---|---|---|
| **Specialty café · Jing'an** | Opening a first specialty café around Jing'an / West Nanjing Road, Shanghai | 5, scored 82 → 31 |
| **Tea brand · Chaoyang** | A tea brand entering Beijing with 3 stores in Chaoyang | 5, scored 76 → 27 |

The sample points are real commercial addresses chosen by the workbench's own model from city data, with deliberately spread scores. Fields you only learn by negotiating (floor area, rent) are left blank, never invented.

Then click anywhere on the map, or just tell DSH on the right:

> Find 10 locations within 200 m of a metro exit, with plenty of restaurants nearby but no more than 3 tea shops of the same kind.

It turns the request into a query expression, runs it with the workbench's own model and data, reads the results to you, and **writes them into the list only after you approve**. Once locations are found it also reports nearby shops for rent.

Open a location you like and the shops for rent within 400 m are listed underneath. Click "Adopt" to attach one to that location.
After a visit say "I've seen A and C, pass." It updates the status, records your words, and later queries exclude them automatically.

## Candidate flow

Every candidate takes four steps: **to visit → visited → in review → signed / rejected**. A new candidate starts as "to visit". There is no "screening" state that nobody actually operates.

- **Advance in the list.** Hover a row and "Visited / Review / Decide" plus a step-back "‹" appear on the right. No need to open the detail.
- **See the stage at a glance.** Rows carry colored tags for visited / in review / signed / rejected, and rejected rows show the reason inline. The filter bar splits to visit / visited / review / decided.
- **Guided decisions.** "Decide" expands the detail panel, scrolls to the decision area at the bottom and highlights it. Sign or reject with those two buttons.
- **Decisions are recorded.** A decided candidate shows a red or green banner under its name with the verdict, date and reason. The decision area becomes a full record card (time, reason tags, notes), and the "Records" page gets an entry.
- **Reversible.** "Revert decision, back to review" under the record card (or "‹" on the row) moves the candidate back, clears the decision record and keeps the reversal in the activity log.
- **Rejection needs a reason.** Signing and rejecting go through the decision flow only. Setting the status directly cannot reach "signed".

## Hand off to DSH

Four buttons at the bottom of the detail panel fill the conversation box on the right with the current candidate (coordinates, area and rent, percentiles, risks, visit notes) together with your request. Confirm and press Enter:

| Button | Purpose |
|---|---|
| Look up the trade area | Ask DSH for public information the workbench cannot see: projects under construction, metro plans, major footfall sources, local restrictions |
| Draft materials | Produce a one-page review memo draft, shown in the conversation first and saved only after you confirm |
| Send with this candidate | Ask anything with the candidate as context |
| Parse a listing (top bar) | Turn a message from an agent or landlord into a structured candidate appended to the list |

You can send without a selected candidate too. The baseline and the whole list go along, so "find 10 locations scoring above 80" needs no prior click.

## Scoring

**The baseline follows the format.** When a project sets a format (coffee, tea, full-service dining, fast food, bakery, convenience store, pharmacy, ... 25 in total), existing stores of that format in the city become the yardstick, and candidates are ranked against them by percentile.
Cities with fewer than 80 same-format samples fall back to the all-retail baseline, and the interface says so.
Where OSM coverage of a format is too thin, `thicken-formats.mjs` samples real commercial addresses according to the location traits of real stores. Formats with fewer than 8 real stores are not expanded.

Three dimensions. **Percentiles are averaged within each dimension first, then across the three dimensions.**

| Dimension | Metrics |
|---|---|
| **Footfall base** | Building floor area within 500 m, restaurants within 500 m, nearest mall |
| **Accessibility** | Nearest metro exit, bus stops within 300 m, crossings within 150 m, parking within 300 m |
| **Location quality** | Roads within 120 m, total street length within 500 m |

**Competition** and **customer mix** are shown but not scored, because neither has a "higher is better" direction.
No exhaust venting, no food-service permit obtainable, or no independent water supply and drainage: any one of these yields "not recommended" outright.

A score is a rank, not an absolute judgement. Every metric is laid out with its raw value, its position in the baseline and the baseline median.

## Real data vs. simulated data

| Layer | | Notes |
|---|---|---|
| POIs, road network, buildings, floor area | **Real** | OpenStreetMap |
| Scores, percentiles, baselines | **Real** | Computed entirely from the layer above |
| Listings, rent, footfall, mall tier | **Simulated** | `*-market.json`, generated by script |

The simulated layer demonstrates the **interface contract**. Field definitions match what domestic data vendors actually sell (each file's `vendors` names who you would buy from in reality).
Once real data is purchased it loads through the same schema and the code above it does not change.

**Simulated data never enters a score.** A unit test guards this. The whole dataset is a demo fixture, and the label appears only once, where the dataset is chosen.

## Add your own city

Beijing, Shanghai and Guangzhou ship with the plugin. Adding a city needs no code changes:

```bash
node scripts/fetch-city.mjs --id shenzhen-futian \
  --label "深圳 · 福田区" --bbox 113.90,22.50,114.10,22.60
```

This pulls POIs, roads, buildings, floor area, transit, parking and crossings from Overpass into `src/data/`.
Restart DSH and the new city appears in the project-creation dropdown.

Overpass is a free service and a district takes a while. **If it is interrupted, rerun the same command to resume.**

## Data

| | Beijing · inside 5th Ring | Shanghai · inside Outer Ring | Guangzhou · core districts |
|---|---|---|---|
| POIs | 48,896 | 58,942 | 26,011 |
| Road segments | 35,421 | 29,864 | 22,213 |
| 3D buildings | 3,011 (tallest 528 m) | 4,459 (tallest 632 m) | 4,195 (tallest 440 m) |
| Simulated listings | 2,700 | 1,900 | 1,300 |

Project files live in `~/Documents/DSH 选址项目/<project name>/`, configurable with `DSH_SITE_SELECTION_ROOT`.
Deleting a project moves it to `.trash/` in the same directory. Nothing is removed.

## Command line (used by DSH)

DSH learns the structure from `CONTEXT.md` in the project folder, then works with these scripts:

```bash
node scripts/query-sites.mjs --where "..." --limit 10      # find locations by condition
node scripts/query-listings.mjs --near-sites --radius 400  # shops for rent near each location
node scripts/query-listings.mjs --adopt lst-0123           # adopt a listing into the list, fields carried over
```

## Known limitations

- Top-tier malls are not always in OSM (Plaza 66 and HKRI Taikoo Hui in Shanghai, for example), so rent around them reads low.
- "Road convergence" uses a 120 m radius. It counts roads meeting nearby and does not mean the shop is on a corner.
- Trade areas that draw crowds through brand clustering, such as Sanlitun, are underrated. The current features cannot capture it.
- OSM POI coverage is below commercial maps. Address-level search and routing need a licensed provider.

## Development

```bash
npm run check         # syntax + 57 unit tests
npm run sample        # regenerate the two sample projects
npm run fetch-city    # add a city
npm run market        # regenerate the simulated market data
```

## License

Code is MIT ([LICENSE](./LICENSE)).

The geographic data under `src/data/` is a derivative database of OpenStreetMap, licensed **ODbL 1.0, which is share-alike**.
© OpenStreetMap contributors. Read [DATA-LICENSE.md](./DATA-LICENSE.md) before redistributing or commercializing.

## Initial draft (1.2.2)

Creating a business project opens a workbench-owned native session and prepares the original onboarding text in its draft for user review and sending; it never submits a model request. Opening an existing project does not create a session, but a pending draft may be delivered when a session is later associated. Without a native session, the text is queued until that business context has an active owned session. Delivery occurs once per session/business pair. Existing plain text is preserved; rich references and in-flight drafts defer insertion and retry when ready. Pending text and delivery records survive reload in localStorage for the current Desktop origin; clearing browser storage removes these records.
