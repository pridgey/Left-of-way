# Left Of Way

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
  a raised intersection side, or another road's end). A road started from another road's end takes its
  lanes, so the two line up. If connected roads don't line up, the Connections section offers
  **Match lanes**. Connected pieces stay attached when you move them.
- **T-intersections:** end a road on the side of another road. It snaps to that road's curb and keeps
  its own angle. It's trimmed along the curb, and both corners get curb returns that fit the angle (set
  the corner radius in its options).
- **Connections panel:** lists what each end of the road meets and which roads attach to it. Hover a
  row to outline that road on the map, or press Show to select it. If an end doesn't line up with the
  road it continues, a ⚠ marks that end on the map and the panel offers **Match lanes**.
- **Extending:** select a road and use the **+** past either end. Click it to keep drawing from that
  end, or drag it to add one point. Hold Ctrl (⌘ on Mac) and the + turns orange: it then starts a
  **new road** connected to that end, with the same lanes (click to draw it, or drag one out). Hold Shift while drawing to snap to 15° steps. The length of the
  piece you're drawing shows next to the cursor.
- **Bends:** hold Ctrl (⌘ on Mac) and drag a road to add a bend point there. Plain drags never add
  points. Alt+click a point to remove it. **Smooth curve** evens out wobbles and cuts the number of
  points; press it again to smooth more. Smoothing never moves the ends or changes the road's heading
  where it connects, and side streets stay attached at the same spot.
- **Roundabout legs:** drag the orange squares to aim each leg down its street. Each leg has its own
  width and an automatic crosswalk with a refuge in the splitter island.
- **Lanes:** the lane strip shows the road's cross-section to scale, left to right facing the road's
  arrow. Click a lane (in the strip, or click it on a selected road) to edit its type, width and
  direction. Drag a lane to reorder it. Drag the line between two lanes to trade width between them,
  so the overall width stays the same (Shift changes just one lane). With the strip focused, the arrow
  keys pick a lane, Alt+arrows move it and Delete removes it. Copy and Paste carry lanes between roads.
  **Mirror** (on by default when both sides have the same lanes) copies edits across the middle:
  widen a bike lane and the other one widens too, add a lane and its twin appears on the other side.
  Turn on **Different widths at each end** to taper lanes, e.g. a turn lane from 10 ft to 0 while a
  median grows from 0 to 10 ft. Markings (yellow center lines, dashed lane lines, curbs, buffer
  hatching, flex posts) are drawn automatically.
- **Splitting roads:** press X (or the scissors button on a selected road) and click a road to cut it
  into connected pieces, each with its own lanes. For a median opening at an intersection, cut on both
  sides, then select the middle piece and change its median to a turn lane. On connected roads, changing
  a lane's type keeps its width so the pieces still line up.
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
  placeholder unit prices. "Copy as table" pastes them into a spreadsheet or document.
- **Cross-sections:** each road shows its cross-section and can download it as an SVG.
- **Project files:** Save / Open a `.json` file with everything, including the screenshot. Work is also
  saved in the browser automatically.

## Editing

- Undo / redo: the arrow buttons in the header, or Ctrl+Z / Ctrl+Shift+Z.
- Arrow keys nudge the selected item (Shift for 10×). Esc deselects.
- Hide the side panel with the panel button in the header or the `\` key.

## In Figma

The export has one layer per element inside a group named after the design option. Notes,
measurements and turning paths go in a separate **Annotations** group so you can hide them in one click.

## Code

- `js/main.js`: app state, editing, panels, export
- `js/types/points.js`: click-to-place elements
- `js/types/paths.js`: road segments, patches, measure, turning check
- `js/types/index.js`: element registry and toolbar icons
- `js/geo.js`: map math and path geometry
- `js/imagery.js`, `js/search.js`: imagery sources and search
