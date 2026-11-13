"""Create Music 설치용 다운로드 도구.

- 여러 연결로 나눠 받는 Range 다운로드 (서버가 Range를 지원할 때)
- GitHub에 분할 업로드된 무압축(stored) zip에서 필요한 파일만 골라 받기
  → 3.6GB 번들 전체를 받지 않고, 합치기·압축 풀기용 임시 파일도 만들지 않습니다.
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

logger = logging.getLogger(__name__)

USER_AGENT = "ItMatZip-Agent-CreateMusic/1.1"
CHUNK_BYTES = 16 * 1024 * 1024
READ_BYTES = 1024 * 1024
DEFAULT_CONNECTIONS = 8
RETRIES = 4
PARALLEL_MIN_BYTES = 32 * 1024 * 1024
REQUEST_TIMEOUT_SEC = 60

# (받은 바이트, 전체 바이트)
ByteProgress = Callable[[int, int], None]


def _is_github_host(url: str) -> bool:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return host == "github.com" or host.endswith(".github.com") or host.endswith(
        "githubusercontent.com"
    )


def _request(url: str, start: int | None = None, end: int | None = None) -> urllib.request.Request:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/octet-stream,*/*"}
    if _is_github_host(url):
        token = (
            os.environ.get("ITMATZIP_CREATE_MUSIC_LIB_TOKEN", "").strip()
            or os.environ.get("GITHUB_TOKEN", "").strip()
            or os.environ.get("GH_TOKEN", "").strip()
        )
        if token:
            headers["Authorization"] = f"token {token}"
    if start is not None:
        headers["Range"] = f"bytes={start}-{'' if end is None else end}"
    return urllib.request.Request(url, headers=headers, method="GET")


def _status(resp) -> int:
    return int(getattr(resp, "status", None) or resp.getcode() or 0)


def probe(url: str) -> tuple[int, bool]:
    """(전체 크기, Range 지원 여부). 크기를 모르면 0."""
    with urllib.request.urlopen(_request(url, 0, 0), timeout=REQUEST_TIMEOUT_SEC) as resp:
        if _status(resp) == 206:
            content_range = resp.headers.get("Content-Range") or ""
            total = content_range.rsplit("/", 1)[-1].strip()
            if total.isdigit():
                return int(total), True
            return 0, False
        return int(resp.headers.get("Content-Length") or 0), False


@dataclass(frozen=True)
class Segment:
    """url의 [start, start+length) 바이트를 대상 파일 dest_offset 위치에 씁니다."""

    url: str
    start: int
    length: int
    dest_offset: int = 0


@dataclass(frozen=True)
class _Job:
    url: str
    start: int
    length: int
    part_path: Path
    dest_offset: int


class _Counter:
    def __init__(self, total: int, progress: ByteProgress | None) -> None:
        self.total = total
        self.done = 0
        self._progress = progress
        self._lock = threading.Lock()
        self._last = 0.0

    def add(self, n: int) -> None:
        with self._lock:
            self.done = max(0, self.done + n)
            now = time.monotonic()
            if self._progress and (now - self._last >= 0.5 or self.done >= self.total):
                self._last = now
                try:
                    self._progress(self.done, self.total)
                except Exception:
                    pass


def _split_jobs(segments: Iterable[Segment], part_path: Path) -> list[_Job]:
    jobs: list[_Job] = []
    for seg in segments:
        off = 0
        while off < seg.length:
            n = min(CHUNK_BYTES, seg.length - off)
            jobs.append(_Job(seg.url, seg.start + off, n, part_path, seg.dest_offset + off))
            off += n
    return jobs


def _run_job(job: _Job, counter: _Counter) -> None:
    last_exc: Exception | None = None
    for attempt in range(RETRIES):
        got = 0
        try:
            req = _request(job.url, job.start, job.start + job.length - 1)
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
                if _status(resp) != 206:
                    raise RuntimeError(f"서버가 부분 다운로드(Range)를 지원하지 않습니다: {job.url}")
                with job.part_path.open("r+b") as out:
                    out.seek(job.dest_offset)
                    while got < job.length:
                        block = resp.read(min(READ_BYTES, job.length - got))
                        if not block:
                            break
                        out.write(block)
                        got += len(block)
                        counter.add(len(block))
            if got == job.length:
                return
            raise OSError(f"응답이 중간에 끊겼습니다 ({got}/{job.length} bytes)")
        except Exception as exc:  # 네트워크 오류는 재시도
            counter.add(-got)
            last_exc = exc
            if attempt + 1 < RETRIES:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"다운로드 실패: {job.url} ({last_exc})") from last_exc


def run_jobs(jobs: list[_Job], *, connections: int, counter: _Counter) -> None:
    if not jobs:
        return
    workers = max(1, min(connections, len(jobs)))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="cm-dl") as pool:
        futures = [pool.submit(_run_job, job, counter) for job in jobs]
        first_exc: BaseException | None = None
        for fut in futures:
            exc = fut.exception()
            if exc is not None and first_exc is None:
                first_exc = exc
                for other in futures:
                    other.cancel()
        if first_exc is not None:
            raise first_exc


def _prepare_part(dest: Path, size: int) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    with part.open("wb") as fh:
        fh.truncate(size)
    return part


def _stream_download(url: str, dest: Path, progress: ByteProgress | None) -> None:
    part = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(_request(url), timeout=REQUEST_TIMEOUT_SEC) as resp:
        total = int(resp.headers.get("Content-Length") or 0)
        counter = _Counter(total, progress)
        with part.open("wb") as out:
            while True:
                block = resp.read(READ_BYTES)
                if not block:
                    break
                out.write(block)
                counter.add(len(block))
    if total and part.stat().st_size != total:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"다운로드 크기가 맞지 않습니다: {url}")
    os.replace(part, dest)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def crc32_file(path: Path) -> int:
    crc = 0
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(8 * 1024 * 1024), b""):
            crc = zlib.crc32(block, crc)
    return crc & 0xFFFFFFFF


def download_file(
    url: str,
    dest: Path,
    *,
    sha256: str | None = None,
    connections: int = DEFAULT_CONNECTIONS,
    progress: ByteProgress | None = None,
) -> Path:
    """파일 하나 받기. 큰 파일은 여러 연결로 나눠 받고, sha256이 있으면 검증합니다."""
    if dest.is_file() and sha256 and sha256_file(dest) == sha256.lower():
        size = dest.stat().st_size
        if progress:
            progress(size, size)
        return dest
    try:
        total, ranged = probe(url)
    except (urllib.error.URLError, OSError) as exc:
        raise RuntimeError(f"서버에 연결하지 못했습니다: {url} ({exc})") from exc

    part = dest.with_name(dest.name + ".part")
    try:
        if ranged and total >= PARALLEL_MIN_BYTES:
            part = _prepare_part(dest, total)
            counter = _Counter(total, progress)
            run_jobs(
                _split_jobs([Segment(url, 0, total)], part),
                connections=connections,
                counter=counter,
            )
            os.replace(part, dest)
        else:
            _stream_download(url, dest, progress)
    except BaseException:
        part.unlink(missing_ok=True)
        raise

    if sha256:
        actual = sha256_file(dest)
        if actual != sha256.lower():
            dest.unlink(missing_ok=True)
            raise RuntimeError(f"파일 검증 실패(sha256 불일치): {dest.name}")
    return dest


# ---------------------------------------------------------------------------
# 원격 분할 zip
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RemotePart:
    url: str
    size: int


def _segments_for(parts: list[RemotePart], start: int, length: int) -> list[Segment]:
    """여러 조각을 이어 붙인 가상 파일의 [start, start+length) → 조각별 Segment."""
    segments: list[Segment] = []
    base = 0
    pos = start
    remaining = length
    for part in parts:
        end = base + part.size
        if remaining > 0 and pos < end:
            n = min(end - pos, remaining)
            segments.append(Segment(part.url, pos - base, n, pos - start))
            pos += n
            remaining -= n
        base = end
    if remaining > 0:
        raise ValueError("요청 범위가 파일 끝을 넘습니다")
    return segments


class _RemoteConcatFile(io.RawIOBase):
    """원격 조각들을 하나의 읽기 전용 파일처럼 보이게 합니다 (zip 목차 읽기용)."""

    BLOCK = 256 * 1024

    def __init__(self, parts: list[RemotePart]) -> None:
        self._parts = parts
        self._size = sum(p.size for p in parts)
        self._pos = 0
        self._cache: dict[int, bytes] = {}

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            self._pos = offset
        elif whence == io.SEEK_CUR:
            self._pos += offset
        else:
            self._pos = self._size + offset
        self._pos = max(0, self._pos)
        return self._pos

    def _block(self, index: int) -> bytes:
        cached = self._cache.get(index)
        if cached is not None:
            return cached
        start = index * self.BLOCK
        data = _read_range(self._parts, start, min(self.BLOCK, self._size - start))
        if len(self._cache) > 64:
            self._cache.clear()
        self._cache[index] = data
        return data

    def readinto(self, buffer) -> int:  # type: ignore[override]
        view = memoryview(buffer)
        want = min(len(view), max(0, self._size - self._pos))
        written = 0
        while written < want:
            index, offset = divmod(self._pos, self.BLOCK)
            block = self._block(index)
            n = min(len(block) - offset, want - written)
            view[written : written + n] = block[offset : offset + n]
            written += n
            self._pos += n
        return written


@dataclass(frozen=True)
class RemoteMember:
    name: str
    data_start: int
    size: int
    crc: int


_LOCAL_HEADER = struct.Struct("<4s5H3L2H")


def list_remote_zip(part_urls: Iterable[str]) -> tuple[list[RemotePart], list[RemoteMember]]:
    """분할 업로드된 무압축 zip의 파일 목록과 각 파일 데이터 위치."""
    parts: list[RemotePart] = []
    for url in part_urls:
        size, ranged = probe(url)
        if not ranged or size <= 0:
            raise RuntimeError(f"부분 다운로드를 지원하지 않는 주소입니다: {url}")
        parts.append(RemotePart(url, size))

    with zipfile.ZipFile(io.BufferedReader(_RemoteConcatFile(parts), buffer_size=64 * 1024)) as zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
    for info in infos:
        if info.compress_type != zipfile.ZIP_STORED:
            raise RuntimeError(f"압축된 항목은 골라 받을 수 없습니다: {info.filename}")

    def _member(info: zipfile.ZipInfo) -> RemoteMember:
        header = _read_range(parts, info.header_offset, _LOCAL_HEADER.size)
        fields = _LOCAL_HEADER.unpack(header)
        if fields[0] != b"PK\x03\x04":
            raise RuntimeError(f"zip 항목 헤더가 올바르지 않습니다: {info.filename}")
        name_len, extra_len = fields[9], fields[10]
        data_start = info.header_offset + _LOCAL_HEADER.size + name_len + extra_len
        return RemoteMember(info.filename, data_start, info.compress_size, info.CRC)

    # 항목 헤더는 서로 떨어져 있어 하나씩 읽으면 느립니다 → 동시에 읽기
    with ThreadPoolExecutor(max_workers=DEFAULT_CONNECTIONS, thread_name_prefix="cm-zip") as pool:
        members = list(pool.map(_member, infos))
    return parts, members


def _read_range(parts: list[RemotePart], start: int, length: int) -> bytes:
    buf = bytearray()
    for seg in _segments_for(parts, start, length):
        req = _request(seg.url, seg.start, seg.start + seg.length - 1)
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
            if _status(resp) != 206:
                raise RuntimeError(f"서버가 부분 다운로드(Range)를 지원하지 않습니다: {seg.url}")
            data = resp.read()
        if len(data) != seg.length:
            raise OSError("응답이 중간에 끊겼습니다")
        buf += data
    return bytes(buf)


def download_remote_members(
    parts: list[RemotePart],
    members: list[RemoteMember],
    dest_dir: Path,
    *,
    connections: int = DEFAULT_CONNECTIONS,
    progress: ByteProgress | None = None,
) -> list[Path]:
    """골라낸 zip 항목들을 dest_dir에 파일 이름만으로 저장 (CRC 검증)."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    total = sum(m.size for m in members)
    counter = _Counter(total, progress)
    jobs: list[_Job] = []
    pending: list[tuple[RemoteMember, Path, Path]] = []
    for member in members:
        dest = dest_dir / Path(member.name).name
        part = _prepare_part(dest, member.size)
        pending.append((member, part, dest))
        jobs.extend(_split_jobs(_segments_for(parts, member.data_start, member.size), part))
    # 큰 파일 조각부터 받아야 마지막에 한 연결만 남는 시간이 줄어듭니다.
    jobs.sort(key=lambda j: -j.length)
    try:
        run_jobs(jobs, connections=connections, counter=counter)
    except BaseException:
        for _member, part, _dest in pending:
            part.unlink(missing_ok=True)
        raise

    out: list[Path] = []
    for member, part, dest in pending:
        if crc32_file(part) != member.crc:
            for _m, p, _d in pending:
                p.unlink(missing_ok=True)
            raise RuntimeError(f"파일 검증 실패(CRC 불일치): {member.name}")
        os.replace(part, dest)
        out.append(dest)
    return out
