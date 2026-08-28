// ---------------------------------------------------------------------------
// Browser GNN compute trial: detects CPU/GPU capabilities, then runs a
// single graph-convolution layer (ONNX model) on both the WASM (CPU) and
// WebGPU (GPU) execution providers and compares timing.
// ---------------------------------------------------------------------------

const logEl = document.getElementById("log");
function log(msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setBadge(el, ok, textOk, textNo) {
  el.textContent = ok ? textOk : textNo;
  el.className = "badge " + (ok ? "ok" : "no");
}

// ---------------------------------------------------------------------------
// 1. Environment detection
// ---------------------------------------------------------------------------
async function detectEnvironment() {
  document.getElementById("cpu-cores").textContent =
    navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} threads available` : "unknown";

  // WASM SIMD check
  let simdOk = false;
  try {
    simdOk = WebAssembly.validate(new Uint8Array([
      0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11
    ]));
  } catch (e) { simdOk = false; }
  setBadge(document.getElementById("wasm-simd-badge"), simdOk, "supported", "not supported");

  // WebGPU check
  const webgpuOk = !!navigator.gpu;
  setBadge(document.getElementById("webgpu-badge"), webgpuOk, "supported", "not available");

  const gpuAdapterEl = document.getElementById("gpu-adapter");
  if (webgpuOk) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info || {};
        gpuAdapterEl.textContent = info.description || info.vendor || "adapter found (details hidden by browser)";
      } else {
        gpuAdapterEl.textContent = "no adapter found";
      }
    } catch (e) {
      gpuAdapterEl.textContent = "could not query adapter";
    }
  } else {
    gpuAdapterEl.textContent = "n/a (WebGPU unsupported)";
  }

  const ortOk = typeof ort !== "undefined";
  setBadge(document.getElementById("ort-badge"), ortOk, "loaded", "failed to load");

  log("Environment check complete.", "info-line");
  if (!webgpuOk) {
    log("WebGPU not available in this browser — try latest Chrome or Edge for the GPU test. CPU test will still run.", "bad-line");
  }
  return { webgpuOk, ortOk };
}

// ---------------------------------------------------------------------------
// 2. Random graph generation (dense adjacency for this trial)
// ---------------------------------------------------------------------------
function makeRandomGraph(n, f) {
  const X = new Float32Array(n * f);
  for (let i = 0; i < X.length; i++) X[i] = Math.random();

  // Random symmetric adjacency, row-normalized (a stand-in for a real graph's
  // normalized adjacency matrix)
  const A = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    let rowSum = 0;
    for (let j = 0; j < n; j++) {
      const v = Math.random() < 0.1 ? 1 : 0; // ~10% edge density
      A[i * n + j] = v;
      rowSum += v;
    }
    A[i * n + i] = 1; // self-loop
    rowSum += 1;
    for (let j = 0; j < n; j++) A[i * n + j] /= rowSum || 1;
  }
  return { X, A };
}

// ---------------------------------------------------------------------------
// 3. Run the model on a given execution provider, return timing
// ---------------------------------------------------------------------------
async function runOnProvider(providerName, X, A, n, f) {
  const session = await ort.InferenceSession.create("model/gcn_layer.onnx", {
    executionProviders: [providerName],
  });

  const xTensor = new ort.Tensor("float32", X, [n, f]);
  const aTensor = new ort.Tensor("float32", A, [n, n]);

  // Warm-up run (excluded from timing — first run pays compilation/setup cost)
  await session.run({ X: xTensor, A: aTensor });

  const runs = 5;
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await session.run({ X: xTensor, A: aTensor });
    times.push(performance.now() - start);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return { avg, times };
}

// ---------------------------------------------------------------------------
// 3.5. Real classification demo — Karate Club graph, real trained weights
// ---------------------------------------------------------------------------
let karateData = null;

async function loadKarateData() {
  if (karateData) return karateData;
  log("Loading Karate Club graph data (34 real people, 78 real friendships)...");
  const res = await fetch("model/karate_club_data.json");
  karateData = await res.json();
  log(`Loaded. ${karateData.num_nodes} nodes. Ground-truth accuracy check pending run.`, "info-line");
  return karateData;
}

async function runClassification(providerName) {
  const data = await loadKarateData();
  const n = data.num_nodes;
  const X = new Float32Array(data.X);
  const A = new Float32Array(data.A);

  log(`Running real classification on ${providerName === "wasm" ? "CPU (WASM)" : "GPU (WebGPU)"}...`);
  const start = performance.now();
  const session = await ort.InferenceSession.create("model/gcn_layer.onnx", {
    executionProviders: [providerName],
  });
  const xTensor = new ort.Tensor("float32", X, [n, n]);
  const aTensor = new ort.Tensor("float32", A, [n, n]);
  const out = await session.run({ X: xTensor, A: aTensor });
  const elapsed = performance.now() - start;

  const probs = out.P.data; // [n, 2] flattened
  const preds = [];
  for (let i = 0; i < n; i++) {
    preds.push(probs[i * 2] > probs[i * 2 + 1] ? 0 : 1);
  }

  let correct = 0;
  for (let i = 0; i < n; i++) if (preds[i] === data.labels[i]) correct++;
  const acc = (correct / n) * 100;

  log(`Classification done in ${elapsed.toFixed(1)} ms. Accuracy: ${acc.toFixed(1)}% (${correct}/${n} correct).`, "ok-line");

  renderClassification(data, preds, elapsed, providerName);
}

function renderClassification(data, preds, elapsed, providerName) {
  const container = document.getElementById("classify-results");
  const correct = preds.filter((p, i) => p === data.labels[i]).length;
  const acc = ((correct / data.num_nodes) * 100).toFixed(1);
  const deviceLabel = providerName === "wasm" ? "CPU (WASM)" : "GPU (WebGPU)";

  let html = `<div class="classify-summary">
    Ran on <strong>${deviceLabel}</strong> in <strong>${elapsed.toFixed(1)} ms</strong> —
    <strong>${correct}/${data.num_nodes}</strong> members correctly classified (${acc}%),
    trained on only ${data.train_node_indices.length} labeled examples.
    <br><span style="color: var(--ink-faint);">Gold outline = the 2 nodes the model was actually trained on. Green = correct prediction. Red = wrong.</span>
  </div>`;
  html += '<div class="node-grid">';
  for (let i = 0; i < data.num_nodes; i++) {
    const isCorrect = preds[i] === data.labels[i];
    const isLabeled = data.train_node_indices.includes(i);
    const cls = ["node-chip", isCorrect ? "correct" : "wrong", isLabeled ? "labeled" : ""].join(" ").trim();
    html += `<div class="${cls}" title="Node ${data.node_names[i]}: predicted ${preds[i] === 0 ? "Mr. Hi" : "Officer"}">${data.node_names[i]}</div>`;
  }
  html += "</div>";
  container.innerHTML = html;
}

document.getElementById("classify-btn").addEventListener("click", async () => {
  document.getElementById("classify-btn").disabled = true;
  try {
    await runClassification("wasm");
  } catch (e) {
    log(`Classification (CPU) failed: ${e.message}`, "bad-line");
  }
  document.getElementById("classify-btn").disabled = false;
});

document.getElementById("classify-btn-gpu").addEventListener("click", async () => {
  if (!navigator.gpu) {
    log("Cannot run GPU classification — WebGPU not supported in this browser.", "bad-line");
    return;
  }
  document.getElementById("classify-btn-gpu").disabled = true;
  try {
    await runClassification("webgpu");
  } catch (e) {
    log(`Classification (GPU) failed: ${e.message}`, "bad-line");
  }
  document.getElementById("classify-btn-gpu").disabled = false;
});

// ---------------------------------------------------------------------------
// 4. Wire up UI
// ---------------------------------------------------------------------------
const slider = document.getElementById("node-slider");
const display = document.getElementById("node-count-display");
slider.addEventListener("input", () => { display.textContent = slider.value; });

const runBtn = document.getElementById("run-btn");

runBtn.addEventListener("click", async () => {
  runBtn.disabled = true;
  const n = parseInt(slider.value, 10);
  const f = 34; // must match the trained model's fixed input dimension (W0 is [34,16])

  document.getElementById("cpu-time").textContent = "—";
  document.getElementById("gpu-time").textContent = "—";
  document.getElementById("cpu-sub").textContent = "running…";
  document.getElementById("gpu-sub").textContent = "waiting…";
  document.getElementById("cpu-time").classList.remove("win");
  document.getElementById("gpu-time").classList.remove("win");

  log(`Generating random graph: ${n} nodes, ${f} features...`);
  const { X, A } = makeRandomGraph(n, f);
  log(`Graph ready. Adjacency matrix is ${n}x${n} (${(n*n*4/1e6).toFixed(1)} MB as float32).`, "info-line");

  const env = { webgpuOk: !!navigator.gpu };

  // --- CPU (WASM) ---
  try {
    log("Running on CPU (WASM execution provider)...");
    const cpuResult = await runOnProvider("wasm", X, A, n, f);
    document.getElementById("cpu-time").textContent = `${cpuResult.avg.toFixed(1)} ms`;
    document.getElementById("cpu-sub").textContent = `avg of 5 runs, after warm-up`;
    log(`CPU done: ${cpuResult.avg.toFixed(1)} ms average.`, "ok-line");
    window.__cpuAvg = cpuResult.avg;
  } catch (e) {
    document.getElementById("cpu-sub").textContent = "failed";
    log(`CPU run failed: ${e.message}`, "bad-line");
  }

  // --- GPU (WebGPU) ---
  if (env.webgpuOk) {
    try {
      document.getElementById("gpu-sub").textContent = "running…";
      log("Running on GPU (WebGPU execution provider)...");
      const gpuResult = await runOnProvider("webgpu", X, A, n, f);
      document.getElementById("gpu-time").textContent = `${gpuResult.avg.toFixed(1)} ms`;
      document.getElementById("gpu-sub").textContent = `avg of 5 runs, after warm-up`;
      log(`GPU done: ${gpuResult.avg.toFixed(1)} ms average.`, "ok-line");
      window.__gpuAvg = gpuResult.avg;
    } catch (e) {
      document.getElementById("gpu-sub").textContent = "failed (see log)";
      log(`GPU run failed: ${e.message}`, "bad-line");
    }
  } else {
    document.getElementById("gpu-sub").textContent = "skipped — WebGPU unavailable";
    log("Skipping GPU run — WebGPU not supported in this browser.", "bad-line");
  }

  // Highlight the winner
  if (window.__cpuAvg && window.__gpuAvg) {
    if (window.__gpuAvg < window.__cpuAvg) {
      document.getElementById("gpu-time").classList.add("win");
      log(`GPU was ${(window.__cpuAvg / window.__gpuAvg).toFixed(2)}x faster than CPU at this graph size.`, "ok-line");
    } else {
      document.getElementById("cpu-time").classList.add("win");
      log(`CPU was ${(window.__gpuAvg / window.__cpuAvg).toFixed(2)}x faster than GPU at this graph size (small graphs often favor CPU — GPU setup/transfer overhead dominates).`, "ok-line");
    }
  }

  runBtn.disabled = false;
});

detectEnvironment();
// ---------------------------------------------------------------------------
// Preflight GPU feasibility check — predicts whether a given graph size
// will fit in a single WebGPU buffer BEFORE actually running inference.
//
// Key fact: WebGPU deliberately does not expose total VRAM (privacy), but
// it DOES expose maxBufferSize / maxStorageBufferBindingSize — hard caps
// on how large a single buffer allocation is allowed to be, regardless of
// how much VRAM the GPU actually has. Our adjacency matrix (N x N floats)
// has to live in one buffer, so this limit is what actually matters here.
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

async function checkGpuFeasibility(n, featureDim) {
  const resultEl = document.getElementById("feasibility-result");
  resultEl.innerHTML = '<p style="color: var(--ink-faint); font-family: var(--font-mono); font-size: 13px;">Checking...</p>';

  if (!navigator.gpu) {
    resultEl.innerHTML = renderVerdict("no", "WebGPU not available in this browser — can't check GPU feasibility.", []);
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    resultEl.innerHTML = renderVerdict("no", "No WebGPU adapter found — can't check GPU feasibility.", []);
    return;
  }

  const limits = adapter.limits;
  const bytesA = n * n * 4;           // adjacency matrix: N x N floats
  const bytesX = n * featureDim * 4;  // feature matrix: N x featureDim floats

  const rows = [
    { label: "Adjacency matrix (A)", need: bytesA },
    { label: "Feature matrix (X)", need: bytesX },
  ];

  const maxBuffer = limits.maxBufferSize;
  const maxBinding = limits.maxStorageBufferBindingSize;
  const hardLimit = Math.min(maxBuffer, maxBinding);

  let verdict = "ok";
  let reasons = [];

  rows.forEach((r) => {
    r.limit = hardLimit;
    r.fits = r.need <= hardLimit;
    if (!r.fits) {
      verdict = "no";
      reasons.push(`${r.label} needs ${formatBytes(r.need)}, exceeding the browser's ${formatBytes(hardLimit)} single-buffer limit.`);
    }
  });

  // Even if it technically fits the buffer-size limit, warn if it's using
  // a large fraction of it (actual free VRAM could still be exceeded —
  // this we genuinely cannot know in advance from JS).
  if (verdict === "ok") {
    const worstFraction = Math.max(bytesA, bytesX) / hardLimit;
    if (worstFraction > 0.5) {
      verdict = "risky";
      reasons.push(`Uses ${(worstFraction * 100).toFixed(0)}% of the browser's max buffer size — likely to work, but real available VRAM (which JS can't query) could still cause it to fail. Try it, but don't be surprised if it does.`);
    } else {
      reasons.push(`Comfortably within limits (using ${(worstFraction * 100).toFixed(1)}% of the max buffer size).`);
    }
  }

  let html = renderVerdict(verdict, null, rows, hardLimit, reasons);
  resultEl.innerHTML = html;

  // Optional: actually attempt a real buffer allocation as a stronger test
  // than just comparing numbers - catches real-world limits the reported
  // numbers might not reflect.
  try {
    const device = await adapter.requestDevice();
    const testBuffer = device.createBuffer({
      size: bytesA,
      usage: GPUBufferUsage.STORAGE,
    });
    testBuffer.destroy();
    resultEl.innerHTML += '<p style="color: var(--good); font-family: var(--font-mono); font-size: 13px; margin-top: 8px;">✓ Real allocation test: the browser accepted a buffer of this size (does not guarantee the full model run will succeed, but is a good sign).</p>';
  } catch (e) {
    resultEl.innerHTML += `<p style="color: var(--bad); font-family: var(--font-mono); font-size: 13px; margin-top: 8px;">✗ Real allocation test failed: ${e.message}</p>`;
  }
}

function renderVerdict(verdict, forcedMessage, rows, hardLimit, reasons) {
  const labels = { ok: "LIKELY TO WORK", risky: "RISKY", no: "WILL LIKELY FAIL" };
  const colors = { ok: "var(--good)", risky: "var(--gold)", no: "var(--bad)" };

  let html = `<div style="border: 1px solid ${colors[verdict]}; border-radius: 4px; padding: 14px 16px;">
    <div style="font-family: var(--font-mono); font-weight: 700; color: ${colors[verdict]}; margin-bottom: 8px;">${labels[verdict]}</div>`;

  if (forcedMessage) {
    html += `<div style="font-size: 14px; color: var(--ink-soft);">${forcedMessage}</div>`;
  } else {
    html += `<table style="width: 100%; font-family: var(--font-mono); font-size: 13px; border-collapse: collapse; margin-bottom: 8px;">
      <tr style="color: var(--ink-faint);"><td>Tensor</td><td>Size needed</td><td>Browser's max buffer</td><td>Fits?</td></tr>`;
    rows.forEach((r) => {
      html += `<tr>
        <td>${r.label}</td>
        <td>${formatBytes(r.need)}</td>
        <td>${formatBytes(r.limit)}</td>
        <td style="color: ${r.fits ? "var(--good)" : "var(--bad)"};">${r.fits ? "yes" : "NO"}</td>
      </tr>`;
    });
    html += "</table>";
    reasons.forEach((r) => {
      html += `<div style="font-size: 13px; color: var(--ink-soft);">• ${r}</div>`;
    });
  }
  html += "</div>";
  return html;
}

document.getElementById("check-btn").addEventListener("click", () => {
  const n = parseInt(document.getElementById("node-slider").value, 10);
  const f = 34; // match your model's feature dimension
  checkGpuFeasibility(n, f);
});
