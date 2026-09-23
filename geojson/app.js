// ---------------------------------------------------------------------------
// Config — change these if your repo/folder differs
// ---------------------------------------------------------------------------
const GH_OWNER = "adarsh-s-kamatagi";
const GH_REPO = "NeuralCorridor";
const GH_BRANCH = "main";
const DATA_DIR = "data"; // folder (relative to repo root) that holds your .geojson files

document.getElementById("data-dir-label").textContent = DATA_DIR + "/";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const logEl = document.getElementById("log");
function log(msg, kind) {
  const line = document.createElement("div");
  if (kind) line.className = kind + "-line";
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Shared base styles, keyed by geometry type — used for loaded GeoJSON and
// shapes drawn with the toolbar, so everything looks consistent (and can be
// dimmed/restored consistently in focus mode) no matter which file, or how
// many files, it came from.
const POINT_STYLE = { radius: 5, color: "#7a1f14", weight: 1, fillColor: "#d1392a", fillOpacity: 0.9 };
const LINE_STYLE = { color: "#2a4b9b", weight: 3, opacity: 0.9 };
const POLY_STYLE = { color: "#2a4b9b", weight: 2, opacity: 0.9, fillColor: "#2a4b9b", fillOpacity: 0.15 };

function styleForType(geomType) {
  if (geomType === "Point" || geomType === "MultiPoint") return { ...POINT_STYLE };
  if (geomType === "LineString" || geomType === "MultiLineString") return { ...LINE_STYLE };
  return { ...POLY_STYLE }; // Polygon, MultiPolygon, Rectangle, etc.
}

// ---------------------------------------------------------------------------
// Tabs (repo / upload)
// ---------------------------------------------------------------------------
document.querySelectorAll(".source-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".source-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".source-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
  });
});

// ---------------------------------------------------------------------------
// Map + editable layer setup (Leaflet + Leaflet-Geoman)
// ---------------------------------------------------------------------------
const map = L.map("map", { preferCanvas: true }).setView([20, 0], 2);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

// In a flex/CSS layout like this one, Leaflet can sometimes measure its
// container before the layout has finished settling, which leaves the map
// blank. Force a re-measure a few times early on, and again on resize.
setTimeout(() => map.invalidateSize(), 0);
window.addEventListener("load", () => map.invalidateSize());
window.addEventListener("resize", () => map.invalidateSize());
if (window.ResizeObserver) {
  new ResizeObserver(() => map.invalidateSize()).observe(document.querySelector(".map-pane"));
}

map.pm.addControls({
  position: "topleft",
  drawMarker: true,
  drawPolyline: true,
  drawPolygon: true,
  drawRectangle: true,
  drawCircle: false,
  drawCircleMarker: false,
  drawText: false,
  editMode: true,
  dragMode: true,
  cutPolygon: false,
  removalMode: true,
});

// Every feature from every loaded source (plus hand-drawn shapes) lives in
// this single FeatureGroup, so editing/export always covers everything
// that's currently on the map.
let editLayer = L.featureGroup().addTo(map);
let selectedLayer = null;
let focusMode = false;

// sourceKey -> { label } for every file currently contributing features to
// the map (repo files use "repo:<path>", uploads use a unique per-upload
// key). Hand-drawn shapes use the fixed key "drawn" and aren't tracked here
// since there's nothing to toggle them by.
const sourcesInfo = new Map();

const mapEl = document.getElementById("map");
const badgeEl = document.getElementById("current-file-badge");

document.getElementById("focus-toggle").addEventListener("change", (e) => {
  focusMode = e.target.checked;
  updateFocusVisuals();
});

function bindFeatureInteractions(layer) {
  if (!layer.feature) layer.feature = { type: "Feature", properties: {} };
  if (!layer.feature.properties) layer.feature.properties = {};
  layer.on("click", (e) => {
    L.DomEvent.stop(e); // don't let it bubble to the map's own click (deselect) handler
    selectFeature(layer);
  });
}

function selectFeature(layer) {
  selectedLayer = layer;
  renderPropsPanel(layer);
  updateFocusVisuals();
}

// Clicking empty map background clears the selection (feature clicks stop
// propagation above, so this only fires for genuine background clicks).
map.on("click", () => {
  if (selectedLayer) selectFeature(null);
});

// Dim every non-selected shape (and the basemap) so the selected feature
// stands out, without literally blurring anything.
function updateFocusVisuals() {
  const active = focusMode && !!selectedLayer;
  mapEl.classList.toggle("map-focus", active);

  editLayer.eachLayer((lyr) => {
    if (!lyr._baseStyle) return;
    if (!active) {
      lyr.setStyle(lyr._baseStyle);
      return;
    }
    if (lyr === selectedLayer) {
      lyr.setStyle({ ...lyr._baseStyle, color: "#b08b2e", opacity: 1, fillOpacity: Math.max(lyr._baseStyle.fillOpacity || 0, 0.55), weight: (lyr._baseStyle.weight || 2) + 2 });
      if (lyr.bringToFront) lyr.bringToFront();
    } else {
      lyr.setStyle({ opacity: 0.12, fillOpacity: 0.05 });
    }
  });
}

// "Focus on the entire map" — zoom/pan to fit everything currently loaded.
function fitToData() {
  const layers = editLayer.getLayers();
  if (!layers.length) {
    log("Nothing loaded yet to fit to.", "info");
    return;
  }
  map.fitBounds(editLayer.getBounds(), { maxZoom: 16, padding: [20, 20] });
}
document.getElementById("fit-all-btn").addEventListener("click", fitToData);

document.getElementById("clear-all-btn").addEventListener("click", () => {
  editLayer.clearLayers();
  sourcesInfo.clear();
  selectFeature(null);
  updateBadge();
  renderFileList(getFilteredRepoFiles()); // uncheck every repo file row
  log("Cleared everything from the map.", "info");
});

// New shapes drawn with the toolbar
map.on("pm:create", (e) => {
  let layer = e.layer;

  // Match newly-drawn shapes to the same styling used for loaded data
  // (small red dots for points, accent-colored lines/polygons), instead of
  // Leaflet-Geoman's default look.
  const geomType = e.shape === "Marker" ? "Point" : e.shape === "Line" ? "LineString" : "Polygon";
  const style = styleForType(geomType);

  if (e.shape === "Marker") {
    const latlng = layer.getLatLng();
    layer.remove();
    layer = L.circleMarker(latlng, style);
  } else {
    layer.setStyle(style);
  }
  layer._baseStyle = style;
  layer._sourceKey = "drawn";

  editLayer.addLayer(layer);
  bindFeatureInteractions(layer);
  selectFeature(layer);
  log("Added new " + e.shape, "info");
});

map.on("pm:remove", () => {
  if (selectedLayer && !editLayer.hasLayer(selectedLayer)) selectFeature(null);
});

// ---------------------------------------------------------------------------
// Adding/removing one source's features to/from the shared editLayer
// ---------------------------------------------------------------------------
function addFeaturesFromGeoJSON(geojsonObj, sourceKey) {
  const built = L.geoJSON(geojsonObj, {
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, styleForType("Point")),
    style: (feature) => styleForType(feature.geometry && feature.geometry.type),
    onEachFeature: (feature, lyr) => {
      lyr._baseStyle = styleForType(feature.geometry && feature.geometry.type);
      lyr._sourceKey = sourceKey;
      bindFeatureInteractions(lyr);
    },
  });
  let count = 0;
  built.eachLayer((lyr) => {
    editLayer.addLayer(lyr);
    count++;
  });
  return count;
}

function removeLayersForSource(sourceKey) {
  const toRemove = [];
  editLayer.eachLayer((lyr) => {
    if (lyr._sourceKey === sourceKey) toRemove.push(lyr);
  });
  toRemove.forEach((lyr) => {
    if (lyr === selectedLayer) selectFeature(null);
    editLayer.removeLayer(lyr);
  });
}

function updateBadge() {
  const total = editLayer.getLayers().length;
  if (total === 0) {
    badgeEl.textContent = "No file loaded yet.";
    return;
  }
  const labels = [...sourcesInfo.values()].map((s) => escapeHtml(s.label));
  const prefix = labels.length ? labels.join(", ") : "Hand-drawn shapes";
  badgeEl.innerHTML = `<strong>${prefix}</strong> — ${total} feature${total === 1 ? "" : "s"}`;
}

// Keep the export filename in sync with what's loaded, but only while the
// person hasn't typed their own filename in.
let lastAutoFilename = "";
function maybeSetExportDefault() {
  const el = document.getElementById("export-filename");
  if (el.value.trim() !== "" && el.value !== lastAutoFilename) return; // they customized it — leave it alone
  const labels = [...sourcesInfo.values()].map((s) => s.label);
  const next = labels.length === 1 ? labels[0] : labels.length > 1 ? "combined.geojson" : "edited.geojson";
  el.value = next;
  lastAutoFilename = next;
}

// ---------------------------------------------------------------------------
// Source 1: browse & multi-select files already in the repo (GitHub Git Trees API)
// ---------------------------------------------------------------------------
const fileListEl = document.getElementById("file-list");
const fileSearchEl = document.getElementById("file-search");
let repoFiles = []; // [{path, name}]

function getFilteredRepoFiles() {
  const q = fileSearchEl.value.trim().toLowerCase();
  return q ? repoFiles.filter((f) => f.path.toLowerCase().includes(q)) : repoFiles;
}

async function fetchRepoFileList() {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/trees/${GH_BRANCH}?recursive=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const data = await res.json();
    repoFiles = (data.tree || [])
      .filter((f) => f.type === "blob" && f.path.startsWith(DATA_DIR + "/") && f.path.toLowerCase().endsWith(".geojson"))
      .map((f) => ({ path: f.path, name: f.path.split("/").pop() }));
    renderFileList(repoFiles);
    log(`Found ${repoFiles.length} .geojson file(s) under ${DATA_DIR}/`, repoFiles.length ? "ok" : "info");
  } catch (err) {
    fileListEl.innerHTML = `<div class="file-row" style="cursor:default;">Couldn't load file list (${escapeHtml(err.message)}). Check the repo/branch/folder settings at the top of app.js.</div>`;
    log("Repo file list failed: " + err.message, "bad");
  }
}

function renderFileList(files) {
  if (files.length === 0) {
    fileListEl.innerHTML = `<div class="file-row" style="cursor:default;">No .geojson files found under ${escapeHtml(DATA_DIR)}/ yet.</div>`;
    return;
  }
  fileListEl.innerHTML = "";
  files.forEach((f) => {
    const sourceKey = "repo:" + f.path;
    const isLoaded = sourcesInfo.has(sourceKey);

    const row = document.createElement("label"); // label so clicking anywhere toggles the checkbox
    row.className = "file-row" + (isLoaded ? " selected" : "");
    row.innerHTML = `
      <span class="file-row-main">
        <input type="checkbox" ${isLoaded ? "checked" : ""} />
        <span>${escapeHtml(f.name)}</span>
      </span>
      <span class="file-path">${escapeHtml(f.path)}</span>`;

    const checkbox = row.querySelector("input");
    checkbox.addEventListener("change", () => toggleRepoFile(f, checkbox.checked, row));
    fileListEl.appendChild(row);
  });
}

fileSearchEl.addEventListener("input", () => renderFileList(getFilteredRepoFiles()));

async function toggleRepoFile(f, checked, rowEl) {
  const sourceKey = "repo:" + f.path;

  if (!checked) {
    removeLayersForSource(sourceKey);
    sourcesInfo.delete(sourceKey);
    rowEl.classList.remove("selected");
    updateBadge();
    maybeSetExportDefault();
    log(`Removed ${f.path} from the map`, "info");
    return;
  }

  rowEl.classList.add("selected");
  log(`Fetching ${f.path} …`, "info");
  const rawUrl = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${f.path}`;
  try {
    const res = await fetch(rawUrl);
    if (!res.ok) throw new Error(`raw fetch returned ${res.status}`);
    const geojson = await res.json();
    const count = addFeaturesFromGeoJSON(geojson, sourceKey);
    sourcesInfo.set(sourceKey, { label: f.name });
    updateBadge();
    maybeSetExportDefault();
    fitToData();
    log(`Loaded ${count} feature(s) from ${f.path}`, "ok");
  } catch (err) {
    rowEl.classList.remove("selected");
    const cb = rowEl.querySelector("input");
    if (cb) cb.checked = false;
    log(`Failed to load ${f.path}: ${err.message}`, "bad");
  }
}

fetchRepoFileList();

// ---------------------------------------------------------------------------
// Source 2: upload one or more local files not yet in the repo
// ---------------------------------------------------------------------------
const fileInputEl = document.getElementById("file-input");
const dropEl = document.getElementById("upload-drop");

function handleFiles(fileList) {
  Array.from(fileList || []).forEach((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const geojson = JSON.parse(reader.result);
        const sourceKey = "upload:" + file.name + ":" + Date.now() + ":" + Math.random();
        const count = addFeaturesFromGeoJSON(geojson, sourceKey);
        sourcesInfo.set(sourceKey, { label: file.name });
        updateBadge();
        maybeSetExportDefault();
        fitToData();
        log(`Loaded ${count} feature(s) from uploaded ${file.name}`, "ok");
      } catch (err) {
        log(`Couldn't parse ${file.name}: ${err.message}`, "bad");
      }
    };
    reader.onerror = () => log(`Couldn't read ${file.name}`, "bad");
    reader.readAsText(file);
  });
}

fileInputEl.addEventListener("change", (e) => handleFiles(e.target.files));

["dragover", "dragleave", "drop"].forEach((evt) => {
  dropEl.addEventListener(evt, (e) => e.preventDefault());
});
dropEl.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

// ---------------------------------------------------------------------------
// Properties panel
// ---------------------------------------------------------------------------
const propsPanelEl = document.getElementById("props-panel");

function renderPropsPanel(layer) {
  if (!layer || !layer.feature) {
    propsPanelEl.innerHTML = `<div class="props-empty">Click a feature on the map to edit its properties.</div>`;
    return;
  }
  const props = layer.feature.properties || {};
  propsPanelEl.innerHTML = "";

  const entries = Object.entries(props);
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "props-empty";
    empty.textContent = "No properties yet — add one below.";
    propsPanelEl.appendChild(empty);
  } else {
    entries.forEach(([k, v]) => propsPanelEl.appendChild(makePropRow(layer, k, v)));
  }

  const addBtn = document.createElement("button");
  addBtn.className = "run-btn secondary";
  addBtn.textContent = "+ Add property";
  addBtn.style.marginTop = "6px";
  addBtn.addEventListener("click", () => {
    propsPanelEl.insertBefore(makePropRow(layer, "", ""), addBtn);
  });
  propsPanelEl.appendChild(addBtn);
}

function makePropRow(layer, key, value) {
  const row = document.createElement("div");
  row.className = "props-row";

  const keyInput = document.createElement("input");
  keyInput.className = "prop-key";
  keyInput.placeholder = "key";
  keyInput.value = key;

  const valInput = document.createElement("input");
  valInput.className = "prop-val";
  valInput.placeholder = "value";
  valInput.value = value === undefined ? "" : value;

  const delBtn = document.createElement("button");
  delBtn.textContent = "Remove";
  delBtn.addEventListener("click", () => {
    if (key) delete layer.feature.properties[key];
    row.remove();
  });

  function commit() {
    const props = layer.feature.properties;
    if (key && key !== keyInput.value) delete props[key];
    key = keyInput.value;
    if (key) props[key] = valInput.value;
  }
  keyInput.addEventListener("change", commit);
  valInput.addEventListener("change", commit);

  row.appendChild(keyInput);
  row.appendChild(valInput);
  row.appendChild(delBtn);
  return row;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
document.getElementById("export-btn").addEventListener("click", () => {
  const geojson = editLayer.toGeoJSON();
  const filename = document.getElementById("export-filename").value.trim() || "edited.geojson";
  const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  log(`Exported ${geojson.features.length} feature(s) to ${filename}`, "ok");
});
