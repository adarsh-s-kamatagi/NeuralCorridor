import numpy as np
import networkx as nx
import json

rng = np.random.default_rng(0)

# ---------------------------------------------------------------------------
# 1. Load Zachary's Karate Club graph + build normalized adjacency
# ---------------------------------------------------------------------------
G = nx.karate_club_graph()
N = G.number_of_nodes()
nodes = list(G.nodes())

A = nx.to_numpy_array(G, nodelist=nodes)
A_hat = A + np.eye(N)  # add self-loops
deg = A_hat.sum(axis=1)
D_inv_sqrt = np.diag(1.0 / np.sqrt(deg))
A_norm = D_inv_sqrt @ A_hat @ D_inv_sqrt  # symmetric normalization (Kipf & Welling)
A_norm = A_norm.astype(np.float32)

X = np.eye(N, dtype=np.float32)  # identity features (standard for this demo)

# Ground truth: which faction each member ended up joining
labels = np.array([0 if G.nodes[n]['club'] == 'Mr. Hi' else 1 for n in nodes])

# Semi-supervised: only give the model 1 labeled example per class to train on
# (this is the classic setup — the point is the model learns from GRAPH
# STRUCTURE, not from lots of labels)
train_mask = np.zeros(N, dtype=bool)
train_mask[0] = True   # node 0 -> known Mr. Hi
train_mask[33] = True  # node 33 -> known Officer
train_idx = np.where(train_mask)[0]

print(f"Graph: {N} nodes, {G.number_of_edges()} edges")
print(f"Training on {train_mask.sum()} labeled nodes out of {N}")

# ---------------------------------------------------------------------------
# 2. Two-layer GCN, implemented + trained by hand with numpy
#    Layer 1: H = ReLU(A_norm @ X @ W0)
#    Layer 2: Z = A_norm @ H @ W1
#    Output: softmax(Z) -> class probabilities per node
# ---------------------------------------------------------------------------
F_in, H_dim, C = N, 16, 2
W0 = rng.normal(0, 0.5, (F_in, H_dim)).astype(np.float32)
W1 = rng.normal(0, 0.5, (H_dim, C)).astype(np.float32)

def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)

lr = 0.05
for epoch in range(300):
    # forward
    AX = A_norm @ X
    Z0 = AX @ W0
    H = np.maximum(Z0, 0)          # ReLU
    AH = A_norm @ H
    Z1 = AH @ W1
    P = softmax(Z1)                # [N, C]

    # loss (cross-entropy on labeled nodes only)
    eps = 1e-9
    loss = -np.log(P[train_idx, labels[train_idx]] + eps).mean()

    # backward
    dZ1 = P.copy()
    dZ1[train_idx, labels[train_idx]] -= 1
    dZ1 /= len(train_idx)
    dZ1[~train_mask] = 0  # only labeled nodes contribute gradient

    dW1 = AH.T @ dZ1
    dAH = dZ1 @ W1.T
    dH = A_norm.T @ dAH
    dZ0 = dH * (Z0 > 0)
    dW0 = AX.T @ dZ0

    W1 -= lr * dW1
    W0 -= lr * dW0

    if epoch % 50 == 0 or epoch == 299:
        preds = P.argmax(axis=1)
        acc = (preds == labels).mean()
        print(f"epoch {epoch:3d}  loss {loss:.4f}  full-graph accuracy {acc:.3f}")

# Final predictions
AX = A_norm @ X
H = np.maximum(AX @ W0, 0)
P_final = softmax((A_norm @ H) @ W1)
preds_final = P_final.argmax(axis=1)
final_acc = (preds_final == labels).mean()
print(f"\nFinal accuracy (trained on 2 labels, evaluated on all {N}): {final_acc:.3f}")

# ---------------------------------------------------------------------------
# 3. Save trained weights + graph data for ONNX export and the browser demo
# ---------------------------------------------------------------------------
np.savez("/home/claude/gnn-browser-test/trained_weights.npz", W0=W0, W1=W1)

demo_data = {
    "num_nodes": N,
    "A": A_norm.flatten().tolist(),
    "X": X.flatten().tolist(),
    "labels": labels.tolist(),
    "predictions": preds_final.tolist(),
    "accuracy": float(final_acc),
    "train_node_indices": train_idx.tolist(),
    "node_names": [str(n) for n in nodes],
}
with open("/home/claude/gnn-browser-test/karate_club_data.json", "w") as f:
    json.dump(demo_data, f)

print("Saved trained_weights.npz and karate_club_data.json")
