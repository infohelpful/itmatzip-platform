# Python Worker Prototype

## 목적
- Go 런처가 subprocess로 Python 워커를 실행하고 stdout으로 JSON 이벤트를 수집
- gRPC 서비스로 확장할 수 있는 구조를 준비

## 의존성
- `grpcio`
- `grpcio-tools`
- `protobuf`

설치:
```powershell
cd ..\python_worker
python -m pip install -r requirements.txt
```

## Proto 생성
```powershell
python generate_proto.py
```

## 실행
- 서비스 모드:
```powershell
python worker.py --serve
```

- 설치 테스트:
```powershell
python worker.py --install-model --model-id test-model --model-url https://example.com/model.bin
```

- gRPC 서버 (proto 생성 후):
```powershell
python worker_grpc.py --bind 127.0.0.1:50051
```
