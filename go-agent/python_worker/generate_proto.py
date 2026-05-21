from pathlib import Path
import sys

from grpc_tools import protoc

ROOT = Path(__file__).resolve().parent
PROTO_DIR = ROOT.parent / "proto"
OUTPUT_DIR = ROOT

if __name__ == "__main__":
    proto_file = PROTO_DIR / "agent.proto"
    result = protoc.main([
        "grpc_tools.protoc",
        f"-I{PROTO_DIR}",
        f"--python_out={OUTPUT_DIR}",
        f"--grpc_python_out={OUTPUT_DIR}",
        str(proto_file),
    ])
    if result != 0:
        sys.exit(result)
    print("Generated protobuf modules in python_worker/")
