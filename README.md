# Road Drafter

Sketch street redesigns (roundabouts, lane changes, bike lanes, traffic calming) on aerial imagery,
then export to Figma as an SVG with one named layer per element.

## Run it

```sh
python3 -m http.server 8765
```

Open http://localhost:8765. It has to be served from localhost (opening `index.html` as a file won't
load the JavaScript modules or allow Copy SVG).

## Finding a place

Type an address, paste a Google Maps link, or type `lat, lng`. Intersections
("E Colfax Ave & Washington St, Denver") also work, but they rely on free public servers that are often
busy, so they can be slow or fail. Pasting a Google Maps link is the most reliable way.

## Tools

| Group | Tools |
|---|---|
| Intersections | Roundabout, mini-roundabout, raised intersection, diagonal diverter |
| Streets | Road segment (lane-by-lane recipe), patch / remove (repaint or repave an area) |
| Traffic calming | Bumpout, chicane, speed hump / table / cushions, refuge island |
| Markings | Crosswalk, lane arrows, bike marking (sharrow) |
| Streetscape | Tree, parklet |
| Analysis | Note, measure, turning check (fire truck, bus, delivery truck, car) |

- **Connecting roads:** with the Road segment tool, start or end on an orange dot (a roundabout leg,
  a raised intersection side, or another road's end). Connected pieces stay attached when you move
  them, and roundabout legs take the road's width.
- **Roundabout legs:** drag the orange squares to aim each leg down its street. Each leg has its own
  width and an automatic crosswalk with a refuge in the splitter island.
- **Lanes:** pick a preset or build your own. Give a lane an end width to taper it, e.g. a turn lane
  from 10 ft to 0 while a median grows from 0 to 10 ft. Markings (yellow center lines, dashed lane
  lines, curbs, buffer hatching, flex posts) are drawn automatically.
- **Automatic crosswalks:** roundabout legs, road ends, raised intersections, refuge islands and bumpouts.
- **Design guide check:** warnings when a dimension falls outside common FHWA / NACTO / MUTCD ranges.
  These are typical ranges, not an engineering review.

## Imagery

- **USGS NAIP** (default): free, no key, US only, about 30–60 cm per pixel.
- **USGS NAIP Plus:** mixes in sharper city imagery where USGS has it.
- **Esri World Imagery:** often sharper in cities. Needs a free ArcGIS Location Platform key.
- **Custom tile server:** many cities and counties publish sharp aerial photos as
  `.../MapServer/tile/{z}/{y}/{x}` URLs.
- **Map screenshot:** paste (Ctrl+V), drop, or choose a screenshot (for example from Google Maps).
  Line it up with Move, and set its scale with Calibrate scale by clicking both ends of the
  screenshot's scale bar. Keep Google's logo and attribution visible in the screenshot.

## Comparing and planning

- **Design options:** keep several alternatives for the same place (the ⋯ menu next to Design in the header).
- **Item list:** with nothing selected, the right panel lists everything in the current option. Click an entry to select it.
- **Before / after slider** and proposal opacity in the View panel. Press H to hide the proposal.
- **Quantities and cost:** rough areas of asphalt, concrete, landscaping and paint, with editable
  placeholder unit prices.
- **Cross-sections:** each road shows its cross-section and can download it as an SVG.
- **Project files:** Save / Open a `.json` file with everything, including the screenshot. Work is also
  saved in the browser automatically.

## Code

- `js/main.js`: app state, editing, panels, export
- `js/types/points.js`: click-to-place elements
- `js/types/paths.js`: road segments, patches, measure, turning check
- `js/types/index.js`: element registry and toolbar icons
- `js/geo.js`: map math and path geometry
- `js/imagery.js`, `js/search.js`: imagery sources and search
