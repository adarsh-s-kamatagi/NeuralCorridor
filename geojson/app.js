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
const map = L.map("map").setView([20, 0], 2);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

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

function clearMap() {
  editLayer.clearLayers();
  selectedLayer = null;
  renderPropsPanel(null);
}

function bindFeatureInteractions(layer) {
  if (!layer.feature) layer.feature = { type: "Feature", properties: {} };
  if (!layer.feature.properties) layer.feature.properties = {};
  layer.on("click", () => selectFeature(layer));
}

function selectFeature(layer) {
  selectedLayer = layer;
  renderPropsPanel(layer);
}

// New shapes drawn with the toolbar
map.on("pm:create", (e) => {
  const layer = e.layer;
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
    onEachFeature: (feature, lyr) => bindFeatureInteractions(lyr),
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

  const rawUrl = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${f.path}`;
  try {
    const res = await fetch(rawUrl);
    if (!res.ok) throw new Error(`raw fetch returned ${res.status}`);
    const geojson = await res.json();
    loadGeoJSON(geojson, f.name);
  } catch (err) {
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
