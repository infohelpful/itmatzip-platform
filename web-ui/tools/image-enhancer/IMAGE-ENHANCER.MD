# Image Enhancer (CodeFormer)

## library-hub (`image-enhancer-lib`)

| 자산 | Release 파일 |
|------|----------------|
| CodeFormer 소스 | `CodeFormer-master.zip` |
| CPU wheel | `codeformer-wheels.zip` |
| GPU wheel (분할) | `codeformer-wheels_gpu.zip.001` / `.002` |
| 가중치 | `codeformer.pth` |
| 배경 향상 (선택) | `RealESRGAN_x2plus.pth` |

Base URL: `https://github.com/infohelpful/library-hub/releases/download/image-enhancer-lib/`

## Python 런타임

| 구성 | Python | 경로 |
|------|--------|------|
| FastAPI 사이카 | **3.14** | `engine\python.exe` (MSI) |
| CodeFormer | **3.12 venv** | `%APPDATA%\ItMatZip\image-enhancer\.venv-codeformer` |

**환경 준비** 시: venv 생성 → GPU/CPU wheel zip에서 **torch/torchvision** 설치 → zip에 없는 패키지(basicsr, opencv 등)는 **PyPI로 자동 보완** → 소스·모델 다운로드.

GPU zip에 `torch`·`torchvision`만 있어도 동작합니다. 완전 오프라인이면 `codeformer-wheels.zip`에 전체 의존성 wheel을 넣어야 합니다.

Vocal Remover `wheel.zip` / Create Music `wheels_create_music` 과 **별도** 번들입니다.

## prepare 순서

1. Python 3.12 venv
2. `codeformer-wheels.zip` (CPU) 또는 `codeformer-wheels_gpu.zip.001/002` (GPU)
3. `CodeFormer-master.zip` → vendor
4. `codeformer.pth`, `RealESRGAN_x2plus.pth`

`basicsr setup.py develop` 은 **사용하지 않음** (wheel의 basicsr==1.4.2).

## 환경 변수 (선택)

| 변수 | 설명 |
|------|------|
| `ITMATZIP_CODEFORMER_SKIP_WHEELS=1` | wheel 대신 pytorch.org / PyPI 온라인 설치 |
| `ITMATZIP_CODEFORMER_WHEELS_CPU_URL` | CPU wheel zip URL 덮어쓰기 |
| `ITMATZIP_CODEFORMER_WHEELS_GPU_PART1_URL` / `PART2` | GPU 분할 zip |
| `ITMATZIP_CODEFORMER_ZIP_URL` | CodeFormer 소스 zip |
| `ITMATZIP_CODEFORMER_WEIGHT_URL` | codeformer.pth |
| `ITMATZIP_REALESRGAN_WEIGHT_URL` | RealESRGAN 가중치 |

## 배경 복원 팁

- **배경 복원 (RealESRGAN)** 체크 + **출력 배율 2배 이상** (CodeFormer 기본 권장).
- 이전 UI는 배율 1로 고정되어 배경 향상이 거의 적용되지 않았음 — 2배·4배에서 RealESRGAN 효과가 큼.
- **배경 고품질 모드**: `bg_tile=256` (느리지만 타일 경계가 덜 보일 수 있음).

## API

`/api/tools/image-enhancer/*` — `agent/routers/image_enhancer.py`

| GET | `/media/image?image_path=` | 원본 미리보기 (로컬 입력 파일) |
| GET | `/download?file_path=` | 결과·작업 파일 다운로드 |
