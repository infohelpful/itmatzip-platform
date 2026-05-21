import argparse
import hashlib
import json
import logging
import os
import sys
from concurrent import futures
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import grpc

try:
    import agent_pb2
    import agent_pb2_grpc
except ImportError as exc:
    raise ImportError(
        "Protobuf modules not found. Run python generate_proto.py in python_worker/ first."
    ) from exc

from vocal_inference import demucs_available, is_vocal_model, run_vocal_separation

LOG = logging.getLogger(__name__)


def _install_root() -> Path:
    custom = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT")
    if custom:
        return Path(custom)
    return Path(__file__).resolve().parent.parent


def _models_dir() -> Path:
    return _install_root() / "models"


class ModelRegistry:
    def __init__(self) -> None:
        self._loaded: dict[str, dict] = {}

    def find_model_path(self, model_id: str) -> Path | None:
        models_dir = _models_dir()
        if not models_dir.is_dir():
            return None
        prefix = f"{model_id}_"
        for entry in sorted(models_dir.iterdir()):
            if entry.is_file() and entry.name.startswith(prefix):
                return entry
        return None

    def load(self, model_id: str) -> dict:
        if model_id in self._loaded:
            return self._loaded[model_id]

        path = self.find_model_path(model_id)
        if path is None or not path.is_file():
            raise FileNotFoundError(f"model not found: {model_id}")

        size = path.stat().st_size
        digest = hashlib.sha256()
        with path.open("rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)

        meta = {
            "model_id": model_id,
            "path": str(path),
            "size": size,
            "sha256": digest.hexdigest(),
        }
        self._loaded[model_id] = meta
        LOG.info("Loaded model %s (%s bytes)", model_id, size)
        return meta

    def predict(self, model_id: str, input_payload: bytes) -> dict:
        if is_vocal_model(model_id):
            return run_vocal_separation(model_id, input_payload)

        meta = self.load(model_id)
        input_hash = hashlib.sha256(input_payload).hexdigest()
        return {
            "model_id": model_id,
            "model_size": meta["size"],
            "model_sha256": meta["sha256"],
            "input_len": len(input_payload),
            "input_sha256": input_hash,
            "output_preview": input_payload[:64].hex(),
            "status": "ok",
        }


class WorkerControlServicer(agent_pb2_grpc.WorkerControlServicer):
    def __init__(self, registry: ModelRegistry) -> None:
        self._registry = registry

    def Health(self, request, context):
        models_dir = _models_dir()
        ready = models_dir.is_dir() or demucs_available()
        return agent_pb2.HealthResponse(status="ok", version="0.3.0", ready=ready)

    def InstallModel(self, request, context):
        LOG.info("InstallModel request: model_id=%s url=%s", request.model_id, request.url)
        return agent_pb2.InstallModelResponse(accepted=True, message="Queued")

    def InstallModelProgress(self, request, context):
        for progress in range(0, 101, 10):
            yield agent_pb2.InstallProgress(
                status="installing",
                progress=progress,
                message=f"Downloading {progress}%",
            )

    def Status(self, request, context):
        loaded = list(self._registry._loaded.keys())
        msg = "ready"
        if loaded:
            msg = f"ready; loaded={','.join(loaded)}"
        if demucs_available():
            msg += "; demucs=installed"
        return agent_pb2.StatusResponse(worker_status=msg, last_error="")


class InferenceServicer(agent_pb2_grpc.InferenceServicer):
    def __init__(self, registry: ModelRegistry) -> None:
        self._registry = registry

    def Predict(self, request, context):
        model_id = (request.model_id or "").strip()
        if not model_id:
            return agent_pb2.InferenceResponse(output_payload=b"", status="model-id-required")

        try:
            result = self._registry.predict(model_id, request.input_payload or b"")
            payload = json.dumps(result, ensure_ascii=False).encode("utf-8")
            return agent_pb2.InferenceResponse(output_payload=payload, status="ok")
        except FileNotFoundError as exc:
            LOG.warning("Inference model missing: %s", exc)
            return agent_pb2.InferenceResponse(output_payload=b"", status="model-not-found")
        except Exception as exc:
            LOG.exception("Inference failed")
            return agent_pb2.InferenceResponse(output_payload=b"", status=f"error:{exc}")


def serve(bind_address: str = "127.0.0.1:50051"):
    registry = ModelRegistry()
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    agent_pb2_grpc.add_WorkerControlServicer_to_server(WorkerControlServicer(registry), server)
    agent_pb2_grpc.add_InferenceServicer_to_server(InferenceServicer(registry), server)
    server.add_insecure_port(bind_address)
    server.start()
    LOG.info("gRPC worker listening on %s (install_root=%s)", bind_address, _install_root())
    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        LOG.info("gRPC worker shutdown requested")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="127.0.0.1:50051")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    serve(bind_address=args.bind)
