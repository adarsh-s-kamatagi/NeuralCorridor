# Browser GNN Compute Trial

A test page with two things in it:

1. **A real, trained GNN doing real work** — not random weights, not a toy.
2. **A CPU vs GPU compute benchmark** — to see what browser-side GPU
   acceleration actually buys you for this kind of workload.

## The model

A 2-layer Graph Convolutional Network (GCN), trained on
[**Zachary's Karate Club**](https://en.wikipedia.org/wiki/Zachary%27s_karate_club) —
a real 34-person social network, famous in graph theory because the club
split into two factions after a conflict between the instructor and the
administrator. Given the network of friendships and the true faction for
just **2 of the 34 members**, the model predicts the other 32 correctly
**97.1% of the time** — using nothing but graph structure.

Trained with hand-written numpy forward/backward passes (see
`train_gcn.py` — small enough not to need PyTorch for training), then
exported to a real ONNX file (`build_model.py`) — the same format
`torch.onnx.export()` produces from an actual PyTorch model. The ONNX
export was verified to produce bit-for-bit identical predictions to the
original numpy model before shipping.

**Architecture:**
```
Y = Softmax( A_norm @ ReLU(A_norm @ X @ W0) @ W1 )
```
where `A_norm` is the symmetrically-normalized adjacency matrix (with
self-loops), `X` is node features (identity matrix — each node starts as
its own one-hot vector), and `W0`/`W1` are the trained weight matrices.

## What the page does

1. **Environment check** — CPU threads, WASM SIMD, WebGPU support, GPU
   adapter.
2. **Real classification demo** — runs the actual trained model on the
   actual 34-node graph, in-browser, on CPU or GPU. Shows every member as a
   colored chip: green if correctly classified, red if wrong, gold outline
   for the 2 nodes the model was actually trained on.
3. **Scalability stress test** — the trained model only has 34 real nodes
   to work with, too small to show a meaningful CPU/GPU gap. This section
   runs the *same architecture* on larger randomly generated graphs (64 to
   4096 nodes) purely to compare raw compute speed — not accuracy, since
   there's no ground truth for random data.

## Why ONNX and not PyTorch directly

Browsers can only run JavaScript, WebAssembly, and WebGPU/WebGL — there's
no way to run PyTorch itself inside one. The standard path is:

```
PyTorch model  →  torch.onnx.export()  →  .onnx file  →  ONNX Runtime Web (browser)
```

This project follows that exact pipeline, just with the training/export
step done here instead of in PyTorch (since the model is small enough that
hand-written numpy training was simpler than installing full PyTorch for
this trial). `torch.onnx.export(your_model, ...)` produces an equivalent
file for any real PyTorch model you train later.

## Browser support notes

- **WebGPU** (needed for the GPU test) is supported by default in Chrome
  and Edge 113+. Firefox and Safari have partial/flagged support depending
  on version. If unavailable, the page clearly shows the GPU option as
  skipped rather than failing silently.
- **WASM (CPU)** works in essentially every modern browser.

## Extending this toward real GNN work

1. **Train a bigger/real PyTorch GNN** on an actual dataset (Cora,
   PubMed, or your own graph data) using `torch_geometric`, export with
   `torch.onnx.export()`, and drop the `.onnx` file into `model/` in place
   of this one.
2. **Sparse adjacency.** This trial uses dense adjacency matrices for
   simplicity. Real large graphs are sparse — a dense `N x N` matrix gets
   expensive fast (16M floats at N=4096). Worth exploring ONNX's sparse
   tensor support once you're working with bigger real graphs.
3. **More layers / more classes**, once you move past a 2-class toy
   problem to real multi-class node classification.

## Running it

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`. This is a static site — deploy it to
its own GitHub repo (separate from your blog) and enable GitHub Pages the
same way as before: upload all files (including the `model/` folder),
Settings → Pages → Deploy from branch → main → root.

