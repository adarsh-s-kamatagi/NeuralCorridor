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

const badgeEl = document.getElementById("current-file-badge");
function setBadge(name, count) {
  badgeEl.innerHTML = name
    ? `Editing: <strong>${escapeHtml(name)}</strong> — ${count} feature${count === 1 ? "" : "s"}`
    : "No file loaded yet.";
}

// Shared base styles, keyed by geometry type — used for both loaded
// GeoJSON and shapes drawn with the toolbar, so everything looks the same
// and can be dimmed/restored consistently in focus mode.
const POINT_STYLE = { radius: 5, color: "#7a1f14", weight: 1, fillColor: "#d1392a", fillOpacity: 0.9 };
const LINE_STYLE = { color: "#2a4b9b", weight: 3, opacity: 0.9 };
const POLY_STYLE = { color: "#2a4b9b", weight: 2, opacity: 0.9, fillColor: "#2a4b9b", fillOpacity: 0.15 };

function styleForType(geomType) {
  if (geomType === "Point" || geomType === "MultiPoint") return { ...POINT_STYLE };
  if (geomType === "LineString" || geomType === "MultiLineString") return { ...LINE_STYLE };
  return { ...POLY_STYLE }; // Polygon, MultiPolygon, Rectangle, etc.
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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

// Every editable feature lives in this layer group.
let editLayer = L.featureGroup().addTo(map);
let selectedLayer = null;
let currentFilename = "edited.geojson";
let focusMode = false;

const mapEl = document.getElementById("map");
document.getElementById("focus-toggle").addEventListener("change", (e) => {
  focusMode = e.target.checked;
  updateFocusVisuals();
});

function clearMap() {
  editLayer.clearLayers();
  selectedLayer = null;
  renderPropsPanel(null);
  updateFocusVisuals();
}

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

  editLayer.addLayer(layer);
  bindFeatureInteractions(layer);
  selectFeature(layer);
  log("Added new " + e.shape, "info");
});

map.on("pm:remove", () => {
  if (selectedLayer && !editLayer.hasLayer(selectedLayer)) selectFeature(null);
});

// ---------------------------------------------------------------------------
// Loading GeoJSON (from either source) onto the map
// ---------------------------------------------------------------------------
function loadGeoJSON(geojsonObj, filename) {
  clearMap();
  currentFilename = filename || "edited.geojson";
  document.getElementById("export-filename").value = currentFilename;

  const layer = L.geoJSON(geojsonObj, {
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, styleForType("Point")),
    style: (feature) => styleForType(feature.geometry && feature.geometry.type),
    onEachFeature: (feature, lyr) => {
      lyr._baseStyle = styleForType(feature.geometry && feature.geometry.type);
      bindFeatureInteractions(lyr);
    },
  });

  let count = 0;
  layer.eachLayer((lyr) => {
    editLayer.addLayer(lyr);
    count++;
  });

  if (count > 0) {
    map.fitBounds(editLayer.getBounds(), { maxZoom: 16 });
  }
  setBadge(currentFilename, count);
  log(`Loaded ${count} feature(s) from ${currentFilename}`, "ok");
}

// ---------------------------------------------------------------------------
// Source 1: browse files already in the repo (via GitHub's Git Trees API)
// ---------------------------------------------------------------------------
const fileListEl = document.getElementById("file-list");
const fileSearchEl = document.getElementById("file-search");
let repoFiles = []; // [{path, name}]

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
    const row = document.createElement("div");
    row.className = "file-row";
    row.innerHTML = `<span>${escapeHtml(f.name)}</span><span class="file-path">${escapeHtml(f.path)}</span>`;
    row.addEventListener("click", () => selectRepoFile(f, row));
    fileListEl.appendChild(row);
  });
}

fileSearchEl.addEventListener("input", () => {
  const q = fileSearchEl.value.trim().toLowerCase();
  const filtered = q ? repoFiles.filter((f) => f.path.toLowerCase().includes(q)) : repoFiles;
  renderFileList(filtered);
});

async function selectRepoFile(f, rowEl) {
  document.querySelectorAll(".file-row.selected").forEach((r) => r.classList.remove("selected"));
  if (rowEl) rowEl.classList.add("selected");

  // Immediate feedback — large files can take a few seconds to fetch, parse
  // and draw, and with no feedback that looks identical to "broken".
  setBadge(f.name + " (loading…)", 0);
  log(`Fetching ${f.path} …`, "info");

  const rawUrl = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${f.path}`;
  try {
    const res = await fetch(rawUrl);
    if (!res.ok) throw new Error(`raw fetch returned ${res.status}`);
    const geojson = await res.json();
    log(`Parsed ${f.path}, drawing on map…`, "info");
    // Let the "drawing…" message paint before the (potentially slow) render.
    await new Promise((r) => setTimeout(r, 0));
    loadGeoJSON(geojson, f.name);
  } catch (err) {
    setBadge(null);
    log(`Failed to load ${f.path}: ${err.message}`, "bad");
  }
}

fetchRepoFileList();

// ---------------------------------------------------------------------------
// Source 2: upload a local file not yet in the repo
// ---------------------------------------------------------------------------
const fileInputEl = document.getElementById("file-input");
const dropEl = document.getElementById("upload-drop");

function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const geojson = JSON.parse(reader.result);
      loadGeoJSON(geojson, file.name);
    } catch (err) {
      log(`Couldn't parse ${file.name}: ${err.message}`, "bad");
    }
  };
  reader.onerror = () => log(`Couldn't read ${file.name}`, "bad");
  reader.readAsText(file);
}

fileInputEl.addEventListener("change", (e) => handleFile(e.target.files[0]));

["dragover", "dragleave", "drop"].forEach((evt) => {
  dropEl.addEventListener(evt, (e) => e.preventDefault());
});
dropEl.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  handleFile(file);
});

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
