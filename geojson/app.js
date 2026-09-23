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

function styleForType(geomType, color) {
  const base =
    geomType === "Point" || geomType === "MultiPoint" ? POINT_STYLE :
    geomType === "LineString" || geomType === "MultiLineString" ? LINE_STYLE :
    POLY_STYLE; // Polygon, MultiPolygon, Rectangle, etc.
  if (!color) return { ...base };
  // Overlay mode: recolor by source instead of by geometry type, so two
  // different files loaded at once are visually distinguishable.
  return { ...base, color, fillColor: color };
}

// Distinct colors auto-assigned to each newly-loaded source (repo file or
// upload), cycling if more sources are loaded than colors. Hand-drawn shapes
// keep the fixed default styling above rather than pulling from this.
const LAYER_PALETTE = ["#2a4b9b", "#b0432e", "#2f8f5b", "#8a4fbd", "#c07a1e", "#1e8f97", "#a3357a", "#5a6b1f"];
let paletteIndex = 0;
function nextLayerColor() {
  const c = LAYER_PALETTE[paletteIndex % LAYER_PALETTE.length];
  paletteIndex++;
  return c;
}

// ---------------------------------------------------------------------------
// Splitting one file's features into overlay layers (by a property, or by
// geometry type) — this is what lets "one file with several kinds of data
// in it" render as several toggleable/colorable layers instead of one blob.
// ---------------------------------------------------------------------------
function extractFeatures(geojsonObj) {
  if (!geojsonObj) return [];
  if (geojsonObj.type === "FeatureCollection") return geojsonObj.features || [];
  if (geojsonObj.type === "Feature") return [geojsonObj];
  return [{ type: "Feature", properties: {}, geometry: geojsonObj }]; // bare geometry
}

function normalizeGeomType(t) {
  if (t === "Point" || t === "MultiPoint") return "Point";
  if (t === "LineString" || t === "MultiLineString") return "Line";
  return "Polygon"; // Polygon, MultiPolygon, and anything else
}

// Looks at every feature's properties and finds keys that plausibly name a
// category — present on most features, with a handful of repeated values
// (not a unique id). Returns candidate keys, best (fewest distinct values)
// first, since that's usually the one meant as a "type"/"category" field.
function detectGroupCandidates(features) {
  if (!features.length) return [];
  const propStats = new Map(); // key -> { values: Map(value -> count), seenOn: number }
  features.forEach((f) => {
    const props = (f && f.properties) || {};
    Object.entries(props).forEach(([k, v]) => {
      if (v === null || v === undefined || typeof v === "object") return;
      if (!propStats.has(k)) propStats.set(k, { values: new Map(), seenOn: 0 });
      const stat = propStats.get(k);
      stat.seenOn++;
      const vs = String(v);
      stat.values.set(vs, (stat.values.get(vs) || 0) + 1);
    });
  });
  const candidates = [];
  propStats.forEach((stat, key) => {
    const cardinality = stat.values.size;
    const coverage = stat.seenOn / features.length;
    if (cardinality >= 2 && cardinality <= 20 && cardinality < features.length && coverage >= 0.6) {
      candidates.push({ key, cardinality, coverage });
    }
  });
  candidates.sort((a, b) => a.cardinality - b.cardinality || b.coverage - a.coverage);
  return candidates.map((c) => c.key);
}

// Splits features into Map(groupValue -> features[]) by a property key, by
// geometry type ("__geomtype__"), or not at all ("" -> one group, "All").
function groupFeatures(features, groupProperty) {
  const groups = new Map();
  features.forEach((f) => {
    let val;
    if (groupProperty === "__geomtype__") {
      val = normalizeGeomType(f.geometry && f.geometry.type);
    } else if (groupProperty) {
      const raw = (f.properties || {})[groupProperty];
      val = raw === undefined || raw === null || raw === "" ? "(none)" : String(raw);
    } else {
      val = "All features";
    }
    if (!groups.has(val)) groups.set(val, []);
    groups.get(val).push(f);
  });
  return groups;
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

// sourceKey -> { label, rawGeojson, candidates, hasMultipleGeomTypes, groupProperty }
// One entry per loaded FILE (repo files use "repo:<path>", uploads use a
// unique per-upload key). This is what the "Split by" dropdown reads/writes.
const fileSources = new Map();

// subKey -> { label, sourceKey, groupValue, color, visible, opacity }.
// One entry per visible OVERLAY LAYER. When a file isn't split, it has a
// single subKey ("<sourceKey>::All features"); when split by a property or
// by geometry type, it has one subKey per distinct value
// ("<sourceKey>::<value>"). Hand-drawn shapes use the fixed key "drawn" and
// aren't tracked here since there's nothing to toggle them by.
const sourcesInfo = new Map();

// subKey -> [leaflet layers]. Kept separate from editLayer's own layer list
// because a hidden layer's shapes are removed from editLayer (so they stop
// drawing/editing) but we still need to find them again to show them.
const sourceLayers = new Map();

// The effective Leaflet style for a layer, folding in its source's current
// opacity setting on top of its base (geometry-type + color) style.
function effectiveStyle(lyr) {
  const base = lyr._baseStyle;
  if (!base) return base;
  const info = sourcesInfo.get(lyr._sourceKey);
  const factor = info && info.opacity != null ? info.opacity / 100 : 1;
  if (factor === 1) return base;
  return {
    ...base,
    opacity: (base.opacity != null ? base.opacity : 1) * factor,
    fillOpacity: (base.fillOpacity != null ? base.fillOpacity : 0) * factor,
  };
}

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
      lyr.setStyle(effectiveStyle(lyr));
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
  fileSources.clear();
  sourcesInfo.clear();
  sourceLayers.clear();
  paletteIndex = 0;
  selectFeature(null);
  updateBadge();
  renderFileList(getFilteredRepoFiles()); // uncheck every repo file row
  renderLayersPanel();
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
function addFeaturesFromGeoJSON(geojsonObj, sourceKey, color) {
  const built = L.geoJSON(geojsonObj, {
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, styleForType("Point", color)),
    style: (feature) => styleForType(feature.geometry && feature.geometry.type, color),
    onEachFeature: (feature, lyr) => {
      lyr._baseStyle = styleForType(feature.geometry && feature.geometry.type, color);
      lyr._sourceKey = sourceKey;
      bindFeatureInteractions(lyr);
    },
  });
  const layers = [];
  built.eachLayer((lyr) => {
    editLayer.addLayer(lyr);
    layers.push(lyr);
  });
  sourceLayers.set(sourceKey, (sourceLayers.get(sourceKey) || []).concat(layers));
  return layers.length;
}

// Removes a source's layers everywhere (map + tracking), whether or not it
// was currently hidden. Used when a source is unloaded entirely (unchecked,
// or removed from the Layers panel) — not for a simple visibility toggle.
function removeLayersForSource(sourceKey) {
  const layers = sourceLayers.get(sourceKey) || [];
  layers.forEach((lyr) => {
    if (lyr === selectedLayer) selectFeature(null);
    if (editLayer.hasLayer(lyr)) editLayer.removeLayer(lyr);
  });
  sourceLayers.delete(sourceKey);
}

// Shows/hides one overlay layer's features without losing them — no refetch
// needed to bring them back.
function setSourceVisibility(subKey, visible) {
  const info = sourcesInfo.get(subKey);
  if (info) info.visible = visible;
  const layers = sourceLayers.get(subKey) || [];
  layers.forEach((lyr) => {
    if (visible) {
      if (!editLayer.hasLayer(lyr)) editLayer.addLayer(lyr);
    } else {
      if (lyr === selectedLayer) selectFeature(null);
      if (editLayer.hasLayer(lyr)) editLayer.removeLayer(lyr);
    }
  });
  updateBadge();
}

// Fades one overlay layer in/out (0-100) relative to its own base style.
function setSourceOpacity(subKey, opacityPct) {
  const info = sourcesInfo.get(subKey);
  if (!info) return;
  info.opacity = opacityPct;
  updateFocusVisuals(); // re-applies effectiveStyle() to every visible layer
}

// Removes every overlay layer belonging to one file (used both when the
// file is unloaded entirely, and when it's about to be re-split by a
// different property).
function removeAllSubLayersForFile(sourceKey) {
  [...sourcesInfo.entries()]
    .filter(([, info]) => info.sourceKey === sourceKey)
    .forEach(([subKey]) => {
      removeLayersForSource(subKey);
      sourcesInfo.delete(subKey);
    });
}

// (Re)builds one file's overlay layers from its already-fetched GeoJSON,
// splitting its features into groups by the given property ("" = don't
// split, "__geomtype__" = split by geometry type, or a property key found
// in the data). This is what runs on first load AND whenever the "Split
// by" dropdown for that file changes.
function loadSourceIntoLayers(sourceKey, groupProperty) {
  const src = fileSources.get(sourceKey);
  if (!src) return 0;
  removeAllSubLayersForFile(sourceKey);
  src.groupProperty = groupProperty;

  const features = extractFeatures(src.rawGeojson);
  const groups = groupFeatures(features, groupProperty);
  let total = 0;
  groups.forEach((feats, groupValue) => {
    const subKey = sourceKey + "::" + groupValue;
    const color = nextLayerColor();
    const count = addFeaturesFromGeoJSON({ type: "FeatureCollection", features: feats }, subKey, color);
    sourcesInfo.set(subKey, {
      label: groupProperty ? `${src.label} — ${groupValue}` : src.label,
      sourceKey,
      groupValue,
      color,
      visible: true,
      opacity: 100,
    });
    total += count;
  });
  return total;
}

// First-time load of a file: figures out a sensible default split (a
// property that looks like a category, else geometry type if the file
// mixes points/lines/polygons, else no split) and builds its layers.
function registerFileSource(sourceKey, label, rawGeojson) {
  const features = extractFeatures(rawGeojson);
  const candidates = detectGroupCandidates(features);
  const hasMultipleGeomTypes = new Set(features.map((f) => normalizeGeomType(f.geometry && f.geometry.type))).size > 1;
  const defaultGroupProperty = candidates.length ? candidates[0] : hasMultipleGeomTypes ? "__geomtype__" : "";

  fileSources.set(sourceKey, { label, rawGeojson, candidates, hasMultipleGeomTypes, groupProperty: defaultGroupProperty });
  return loadSourceIntoLayers(sourceKey, defaultGroupProperty);
}

// Fully unloads one file: removes all its overlay layers, forgets it, and
// refreshes the Layers panel and (for repo sources) the file-list checkbox.
function removeFileEverywhere(sourceKey) {
  removeAllSubLayersForFile(sourceKey);
  fileSources.delete(sourceKey);
  updateBadge();
  maybeSetExportDefault();
  renderLayersPanel();
  if (sourceKey.startsWith("repo:")) renderFileList(getFilteredRepoFiles());
  log(`Removed ${sourceKey.replace(/^repo:|^upload:/, "").split(":")[0]} from the map`, "info");
}

function updateBadge() {
  const total = editLayer.getLayers().length;
  if (total === 0) {
    badgeEl.textContent = "No file loaded yet.";
    return;
  }
  const labels = [...fileSources.values()].map((s) => escapeHtml(s.label));
  const prefix = labels.length ? labels.join(", ") : "Hand-drawn shapes";
  badgeEl.innerHTML = `<strong>${prefix}</strong> — ${total} feature${total === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Layers panel — one group per loaded FILE (with a "Split by" control to
// break that single file into several overlay layers), each containing one
// row per overlay layer that split currently produces.
// ---------------------------------------------------------------------------
const layersPanelEl = document.getElementById("layers-panel");

function renderLayersPanel() {
  if (fileSources.size === 0) {
    layersPanelEl.innerHTML = `<div class="layers-empty">Nothing loaded yet — check a file above or upload one.</div>`;
    return;
  }
  layersPanelEl.innerHTML = "";

  fileSources.forEach((src, sourceKey) => {
    const group = document.createElement("div");
    group.className = "layer-file-group";

    const header = document.createElement("div");
    header.className = "layer-file-header";
    header.innerHTML = `
      <span class="layer-file-name">${escapeHtml(src.label)}</span>
      <select class="layer-groupby" title="Split this file's features into overlay layers"></select>
      <button class="layer-file-remove" title="Remove this file">×</button>`;

    const select = header.querySelector(".layer-groupby");
    const options = [{ value: "", text: "Single layer" }];
    if (src.hasMultipleGeomTypes) options.push({ value: "__geomtype__", text: "By geometry type" });
    src.candidates.forEach((key) => options.push({ value: key, text: `By "${key}"` }));
    select.innerHTML = options
      .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.text)}</option>`)
      .join("");
    select.value = src.groupProperty || "";

    select.addEventListener("change", () => {
      loadSourceIntoLayers(sourceKey, select.value);
      updateBadge();
      maybeSetExportDefault();
      fitToData();
      renderLayersPanel();
      const how = select.value ? select.options[select.selectedIndex].text.toLowerCase() : "back into a single layer";
      log(`Split ${src.label} ${how}`, "info");
    });
    header.querySelector(".layer-file-remove").addEventListener("click", () => removeFileEverywhere(sourceKey));

    group.appendChild(header);

    [...sourcesInfo.entries()]
      .filter(([, info]) => info.sourceKey === sourceKey)
      .forEach(([subKey, info]) => {
        const count = (sourceLayers.get(subKey) || []).length;
        const row = document.createElement("div");
        row.className = "layer-row" + (info.visible ? "" : " layer-hidden");
        row.innerHTML = `
          <span class="layer-swatch" style="background:${info.color}"></span>
          <span class="layer-main">
            <span class="layer-name">${escapeHtml(src.groupProperty ? info.groupValue : "All features")}</span>
            <span class="layer-count">${count} feature${count === 1 ? "" : "s"}</span>
          </span>
          <label class="layer-vis-toggle" title="Show/hide this layer">
            <input type="checkbox" ${info.visible ? "checked" : ""} />
          </label>
          <input type="range" class="layer-opacity" min="10" max="100" value="${info.opacity}" title="Layer opacity" />`;

        row.querySelector(".layer-vis-toggle input").addEventListener("change", (e) => {
          setSourceVisibility(subKey, e.target.checked);
          row.classList.toggle("layer-hidden", !e.target.checked);
        });
        row.querySelector(".layer-opacity").addEventListener("input", (e) => {
          setSourceOpacity(subKey, Number(e.target.value));
        });

        group.appendChild(row);
      });

    layersPanelEl.appendChild(group);
  });
}

// Keep the export filename in sync with what's loaded, but only while the
// person hasn't typed their own filename in.
let lastAutoFilename = "";
function maybeSetExportDefault() {
  const el = document.getElementById("export-filename");
  if (el.value.trim() !== "" && el.value !== lastAutoFilename) return; // they customized it — leave it alone
  const labels = [...fileSources.values()].map((s) => s.label);
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
    const isLoaded = fileSources.has(sourceKey);

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
    removeFileEverywhere(sourceKey); // also re-renders the file list itself
    return;
  }

  rowEl.classList.add("selected");
  log(`Fetching ${f.path} …`, "info");
  const rawUrl = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${f.path}`;
  try {
    const res = await fetch(rawUrl);
    if (!res.ok) throw new Error(`raw fetch returned ${res.status}`);
    const geojson = await res.json();
    const count = registerFileSource(sourceKey, f.name, geojson);
    updateBadge();
    renderLayersPanel();
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
        const count = registerFileSource(sourceKey, file.name, geojson);
        updateBadge();
        renderLayersPanel();
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
  // Union of what's currently on the map (covers hand-drawn shapes, which
  // aren't tracked in sourceLayers) with every tracked source layer (covers
  // layers currently toggled off) — hiding a layer shouldn't drop it from
  // the export, only from view.
  const allLayers = new Set(editLayer.getLayers());
  sourceLayers.forEach((layers) => layers.forEach((lyr) => allLayers.add(lyr)));
  const geojson = L.featureGroup([...allLayers]).toGeoJSON();
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
