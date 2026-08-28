import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

weights = np.load("/home/claude/gnn-browser-test/trained_weights.npz")
W0 = weights["W0"].astype(np.float32)  # [34, 16] - trained
W1 = weights["W1"].astype(np.float32)  # [16, 2]  - trained

F_in, H_dim = W0.shape
_, C = W1.shape

W0_init = numpy_helper.from_array(W0, name="W0")
W1_init = numpy_helper.from_array(W1, name="W1")

N = "N"  # dynamic node count

X = helper.make_tensor_value_info("X", TensorProto.FLOAT, [N, F_in])
A = helper.make_tensor_value_info("A", TensorProto.FLOAT, [N, N])
P = helper.make_tensor_value_info("P", TensorProto.FLOAT, [N, C])

nodes = [
    helper.make_node("MatMul", ["A", "X"], ["AX"], name="aggregate_1"),
    helper.make_node("MatMul", ["AX", "W0"], ["Z0"], name="transform_1"),
    helper.make_node("Relu", ["Z0"], ["H"], name="activation_1"),
    helper.make_node("MatMul", ["A", "H"], ["AH"], name="aggregate_2"),
    helper.make_node("MatMul", ["AH", "W1"], ["Z1"], name="transform_2"),
    helper.make_node("Softmax", ["Z1"], ["P"], name="classify", axis=1),
]

graph = helper.make_graph(
    nodes, "trained_gcn_karate_club",
    [X, A], [P],
    initializer=[W0_init, W1_init],
)

model = helper.make_model(graph, producer_name="gnn-browser-trial",
                           opset_imports=[helper.make_opsetid("", 17)])
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, "/home/claude/gnn-browser-test/model/gcn_layer.onnx")
print("Trained GCN model built and validated OK")
print(f"W0: {W0.shape}, W1: {W1.shape}")
