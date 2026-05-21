import argparse
import json
import os
import sys
import time


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_service():
    emit({"type": "worker_status", "status": "starting", "message": "Python worker service starting"})
    time.sleep(1)
    emit({"type": "worker_status", "status": "ready", "message": "Python worker ready"})

    try:
        while True:
            time.sleep(5)
            emit({"type": "heartbeat", "status": "alive", "message": "Python worker heartbeat"})
    except KeyboardInterrupt:
        emit({"type": "worker_status", "status": "stopping", "message": "Python worker shutting down"})


def run_installation(model_id: str, model_url: str):
    emit({
        "type": "install_request",
        "status": "pending",
        "message": f"Installing model {model_id or '<default>'}",
        "model_id": model_id,
        "url": model_url,
    })
    for i in range(0, 101, 10):
        emit({
            "type": "install_progress",
            "status": "installing",
            "progress": i,
            "message": f"Downloading model... {i}%",
            "model_id": model_id,
        })
        time.sleep(0.5)
    emit({
        "type": "install_progress",
        "status": "installed",
        "progress": 100,
        "message": "Model download complete.",
        "model_id": model_id,
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true", help="Run as long-lived worker service")
    parser.add_argument("--install-model", action="store_true", help="Run a sample install workflow")
    parser.add_argument("--model-id", default="default-model", help="Model identifier for install")
    parser.add_argument("--model-url", default="", help="Model download URL")
    args = parser.parse_args()

    if args.install_model:
        run_installation(args.model_id, args.model_url)
        return
    if args.serve:
        run_service()
        return

    print("Use --serve or --install-model", file=sys.stderr)


if __name__ == "__main__":
    main()
