package main

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "log"
    "math"
    "net/http"
    "os"
    "path/filepath"
    "strings"
    "sync"
    "time"
)

type modelDownloader struct {
    hub   *wsHub
    store *modelStore
    http  *http.Client
}

func newModelDownloader(hub *wsHub, store *modelStore) *modelDownloader {
    return &modelDownloader{
        hub:   hub,
        store: store,
        http: &http.Client{
            Timeout: 0,
        },
    }
}

func (d *modelDownloader) recordDownload(modelID, modelURL, status, message string, done, total int64) {
	if d.store != nil && d.store.db != nil {
		_ = d.store.db.RecordDownload(modelID, modelURL, status, message, done, total)
	}
}

func (d *modelDownloader) Broadcast(event wsEvent) {
	if d.hub != nil {
		d.hub.broadcast(event)
	}
}

func (d *modelDownloader) DownloadModel(ctx context.Context, modelID, modelURL string) error {
    if modelID == "" || modelURL == "" {
        return fmt.Errorf("modelID and modelURL are required")
    }

    modelsDir := modelsRootPath
    if err := os.MkdirAll(modelsDir, 0o755); err != nil {
        return err
    }

    filename := filepath.Base(strings.TrimRight(modelURL, "/"))
    if filename == "" || filename == "." || strings.Contains(filename, "?") {
        filename = modelID + ".bin"
    }
    targetPath := filepath.Join(modelsDir, modelID+"_"+filename)
    tempPath := targetPath + ".tmp"

    d.Broadcast(wsEvent{Type: "download", Status: "started", Message: "Starting download", Source: "go"})
    d.recordDownload(modelID, modelURL, "started", "Fetch metadata", 0, 0)
    d.store.Set(ModelMetadata{ID: modelID, URL: modelURL, Filename: filepath.Base(targetPath), Status: "started", Message: "Fetch metadata"})

    client := d.http
    req, err := http.NewRequestWithContext(ctx, http.MethodHead, modelURL, nil)
    if err != nil {
        return err
    }
    resp, err := client.Do(req)
    if err != nil || resp.StatusCode >= 400 {
        // HEAD may be blocked by some servers, fallback to GET metadata
        resp, err = client.Get(modelURL)
        if err != nil {
            return err
        }
        defer resp.Body.Close()
    } else {
        defer resp.Body.Close()
    }

    contentLength := resp.ContentLength
    acceptRanges := strings.Contains(strings.ToLower(resp.Header.Get("Accept-Ranges")), "bytes")

    d.store.Set(ModelMetadata{ID: modelID, URL: modelURL, Filename: filepath.Base(targetPath), Size: contentLength, Status: "downloading", Message: "Downloading model"})

    if acceptRanges && contentLength > 0 && contentLength > 1<<20 {
        if err := d.parallelDownload(ctx, modelURL, tempPath, contentLength); err != nil {
            return err
        }
    } else {
        if err := d.singleDownload(ctx, modelURL, tempPath); err != nil {
            return err
        }
    }

    checksum, err := d.verifyAndFinalize(tempPath, targetPath, modelID, modelURL)
    if err != nil {
        d.store.Set(ModelMetadata{ID: modelID, URL: modelURL, Filename: filepath.Base(targetPath), Status: "failed", Message: err.Error()})
        return err
    }

    d.store.Set(ModelMetadata{ID: modelID, URL: modelURL, Filename: filepath.Base(targetPath), Size: contentLength, SHA256: checksum, Status: "ready", Message: "Download complete"})
    d.recordDownload(modelID, modelURL, "completed", "Download complete", contentLength, contentLength)
    d.Broadcast(wsEvent{Type: "download", Status: "completed", Progress: 100, Message: "Download complete", Source: "go"})
    return nil
}

func (d *modelDownloader) parallelDownload(ctx context.Context, url, tempPath string, size int64) error {
    parts := 4
    chunkSize := int64(math.Ceil(float64(size) / float64(parts)))
    tmpDir := tempPath + ".parts"
    if err := os.MkdirAll(tmpDir, 0o755); err != nil {
        return err
    }
    defer os.RemoveAll(tmpDir)

    progress := int64(0)
    progressMu := sync.Mutex{}
    doneCh := make(chan struct{})
    errCh := make(chan error, parts)
    var wg sync.WaitGroup

    for i := 0; i < parts; i++ {
        start := int64(i) * chunkSize
        end := int64(math.Min(float64(start+chunkSize-1), float64(size-1)))
        if start > end {
            break
        }
        wg.Add(1)
        go func(part int, start, end int64) {
            defer wg.Done()
            partPath := filepath.Join(tmpDir, fmt.Sprintf("part-%d", part))
            if err := d.downloadRange(ctx, url, start, end, partPath, func(bytes int64) {
                progressMu.Lock()
                progress += bytes
                progressMu.Unlock()
            }); err != nil {
                errCh <- err
            }
        }(i, start, end)
    }

    go func() {
        ticker := time.NewTicker(250 * time.Millisecond)
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                progressMu.Lock()
                p := int(math.Round(float64(progress) / float64(size) * 100))
                progressMu.Unlock()
                d.Broadcast(wsEvent{Type: "download", Status: "downloading", Progress: p, Message: "Downloading model", Source: "go"})
            case <-doneCh:
                return
            }
        }
    }()

    wg.Wait()
    close(doneCh)

    select {
    case err := <-errCh:
        return err
    default:
    }

    return d.mergeParts(tmpDir, tempPath, parts)
}

func (d *modelDownloader) downloadRange(ctx context.Context, url string, start, end int64, path string, progressFn func(int64)) error {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return err
    }
    req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
    resp, err := d.http.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
        return fmt.Errorf("unexpected status %d for range request", resp.StatusCode)
    }

    out, err := os.Create(path)
    if err != nil {
        return err
    }
    defer out.Close()

    counter := &writeCounter{callback: progressFn}
    if _, err := io.Copy(out, io.TeeReader(resp.Body, counter)); err != nil {
        return err
    }
    return nil
}

func (d *modelDownloader) singleDownload(ctx context.Context, url, tempPath string) error {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return err
    }
    resp, err := d.http.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    if resp.StatusCode >= 400 {
        return fmt.Errorf("download failed with status %d", resp.StatusCode)
    }

    out, err := os.Create(tempPath)
    if err != nil {
        return err
    }
    defer out.Close()

    counter := &writeCounter{callback: func(bytes int64) {
        d.Broadcast(wsEvent{Type: "download", Status: "downloading", Message: "Downloading model", Source: "go"})
    }}
    if _, err := io.Copy(out, io.TeeReader(resp.Body, counter)); err != nil {
        return err
    }
    return nil
}

func (d *modelDownloader) mergeParts(tmpDir, targetPath string, partCount int) error {
    out, err := os.Create(targetPath)
    if err != nil {
        return err
    }
    defer out.Close()

    for i := 0; i < partCount; i++ {
        partPath := filepath.Join(tmpDir, fmt.Sprintf("part-%d", i))
        in, err := os.Open(partPath)
        if err != nil {
            return err
        }
        if _, err := io.Copy(out, in); err != nil {
            in.Close()
            return err
        }
        in.Close()
    }
    return nil
}

func (d *modelDownloader) verifyAndFinalize(tempPath, targetPath, modelID, modelURL string) (string, error) {
    fh, err := os.Open(tempPath)
    if err != nil {
        return "", err
    }
    hasher := sha256.New()
    if _, err := io.Copy(hasher, fh); err != nil {
        fh.Close()
        return "", err
    }
    if err := fh.Close(); err != nil {
        return "", err
    }

    checksum := hex.EncodeToString(hasher.Sum(nil))
    log.Printf("downloaded model %s sha256=%s", modelID, checksum)

    if err := os.Rename(tempPath, targetPath); err != nil {
        return "", err
    }
    return checksum, nil
}

type writeCounter struct {
    total    int64
    callback func(int64)
}

func (w *writeCounter) Write(p []byte) (int, error) {
    n := len(p)
    w.total += int64(n)
    if w.callback != nil {
        w.callback(int64(n))
    }
    return n, nil
}
