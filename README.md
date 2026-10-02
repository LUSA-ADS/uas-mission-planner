# UAS Mission Planner (training edition)

A browser-based planner for UAS operator training. Students plan a **mission**, a **geofence** and **rally points** on a map and download files that load directly into **Mission Planner**. No installation is needed, and everything runs in the browser.

## Features

- **Mission:** add waypoints by clicking the map, then drag to move, reorder, insert after the selected item, and delete. You can edit command, altitude, altitude frame and parameters per item. Supported commands are Takeoff, Waypoint, Spline waypoint, Loiter (time/turns/unlimited/to altitude), Land, RTL, Delay, Change speed, Do jump, Set servo, Camera trigger distance, ROI and Land start. The planner shows leg distance and bearing, total distance and estimated flight time.
- **Geofence:** inclusion and exclusion polygons, inclusion and exclusion circles, and a return point. Vertices can be dragged, added at midpoints, or removed with a right-click.
- **Rally points:** add, drag, set altitude.
- **Checks:** altitude above the limit (default 120 m), waypoints or legs outside the fence or inside exclusion zones, self-intersecting polygons, invalid DO_JUMP targets, missing takeoff or RTL/land, and home outside the fence.
- **Import:** Mission Planner `.waypoints` files (mission, fence or rally, detected automatically), QGroundControl `.plan` files, and saved projects.
- **Save project:** a `.project.json` file students can reopen later. The current plan is also kept automatically in the browser.
- Undo with Ctrl+Z. Esc cancels a tool, Enter finishes a polygon, Delete removes the selected item.

## Exported files

All three are in the plain-text `QGC WPL 110` format that Mission Planner uses on its Plan screen:

| File | Content |
|---|---|
| `<plan>_mission.waypoints` | Line 0 = home, then mission items (altitude frame per item, default *relative to home*) |
| `<plan>_fence.waypoints` | `MAV_CMD_NAV_FENCE_*` items: 5000 return point, 5001/5002 polygon vertices, 5003/5004 circles |
| `<plan>_rally.waypoints` | `MAV_CMD_NAV_RALLY_POINT` (5100) items, altitude relative to home |

The fence format is the polygon/circle fence used by ArduPilot 4.0 and later. Fence altitude limits, the breach action and enabling the fence are **parameters** (`FENCE_ENABLE`, `FENCE_TYPE`, `FENCE_ALT_MAX`, `FENCE_ACTION` …). They are set in Mission Planner, not in the file.

### Loading in Mission Planner

1. Open the **PLAN** screen.
2. In the drop-down above the waypoint list, choose **Mission**, **Fence** or **Rally**.
3. Click **Load File** (or right-click the map → *File Load/Save*) and pick the matching file.
4. Check the plan, then **Write** it to the vehicle or SITL.

## Hosting on GitHub Pages

1. Create a public repository, e.g. `uas-mission-planner`, and push the contents of this folder to the `main` branch (`index.html` must be at the repository root).
2. In the repository, go to **Settings → Pages → Build and deployment**, set **Source** to *Deploy from a branch*, then select **Branch** `main` and folder `/ (root)`.
3. After about a minute the planner is live at `https://<your-username>.github.io/uas-mission-planner/`.

```bash
git init -b main
git add .
git commit -m "UAS mission planner"
git remote add origin https://github.com/<your-username>/uas-mission-planner.git
git push -u origin main
```

## Customising

- **Start location:** change `DEFAULT_VIEW` at the top of `js/app.js` to the training field.
- **Altitude limit and defaults:** these are in `blankState()` in `js/app.js`: default altitude, cruise speed, `maxAlt` (120 m, EU open category), rally altitude and circle radius.
- **Commands offered:** see `CMD` and `CMD_ORDER` in `js/formats.js`.

## Files

```
index.html        page layout
css/style.css     styles
js/formats.js     Mission Planner file formats + geometry (no DOM, testable in Node)
js/app.js         map and editor UI
```

Map data: Esri World Imagery, OpenStreetMap, OpenTopoMap. Map library: [Leaflet](https://leafletjs.com/) (loaded from cdnjs).
