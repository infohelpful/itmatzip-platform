package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type stateDB struct {
	db *sql.DB
}

func newStateDB(path string) (*stateDB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &stateDB{db: db}
	if err := store.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *stateDB) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *stateDB) migrate() error {
	schema := `
CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    url TEXT NOT NULL,
    bytes_done INTEGER NOT NULL DEFAULT 0,
    bytes_total INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    message TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(model_id) REFERENCES models(id)
);

CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    pid INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'stopped',
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`
	if _, err := s.db.Exec(schema); err != nil {
		return fmt.Errorf("migrate schema: %w", err)
	}
	return nil
}

func (s *stateDB) UpsertModel(meta ModelMetadata) error {
	if meta.UpdatedAt.IsZero() {
		meta.UpdatedAt = time.Now().UTC()
	}
	_, err := s.db.Exec(`
INSERT INTO models (id, url, filename, size, sha256, status, message, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    url=excluded.url,
    filename=excluded.filename,
    size=excluded.size,
    sha256=excluded.sha256,
    status=excluded.status,
    message=excluded.message,
    updated_at=excluded.updated_at
`, meta.ID, meta.URL, meta.Filename, meta.Size, meta.SHA256, meta.Status, meta.Message, meta.UpdatedAt.Format(time.RFC3339))
	return err
}

func (s *stateDB) GetModel(modelID string) (ModelMetadata, bool, error) {
	row := s.db.QueryRow(`
SELECT id, url, filename, size, sha256, status, message, updated_at
FROM models WHERE id = ?
`, modelID)
	var meta ModelMetadata
	var updatedAt string
	err := row.Scan(&meta.ID, &meta.URL, &meta.Filename, &meta.Size, &meta.SHA256, &meta.Status, &meta.Message, &updatedAt)
	if err == sql.ErrNoRows {
		return ModelMetadata{}, false, nil
	}
	if err != nil {
		return ModelMetadata{}, false, err
	}
	meta.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return meta, true, nil
}

func (s *stateDB) ListModels() ([]ModelMetadata, error) {
	rows, err := s.db.Query(`
SELECT id, url, filename, size, sha256, status, message, updated_at
FROM models ORDER BY updated_at DESC
`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]ModelMetadata, 0)
	for rows.Next() {
		var meta ModelMetadata
		var updatedAt string
		if err := rows.Scan(&meta.ID, &meta.URL, &meta.Filename, &meta.Size, &meta.SHA256, &meta.Status, &meta.Message, &updatedAt); err != nil {
		 return nil, err
		}
		meta.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
		list = append(list, meta)
	}
	return list, rows.Err()
}

func (s *stateDB) RecordDownload(modelID, url, status, message string, bytesDone, bytesTotal int64) error {
	now := time.Now().UTC().Format(time.RFC3339)
	finishedAt := ""
	if status == "completed" || status == "failed" {
		finishedAt = now
	}
	_, err := s.db.Exec(`
INSERT INTO downloads (model_id, url, bytes_done, bytes_total, status, message, started_at, finished_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`, modelID, url, bytesDone, bytesTotal, status, message, now, finishedAt)
	return err
}

func (s *stateDB) UpsertWorker(id, kind string, pid int, status, lastError string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.Exec(`
INSERT INTO workers (id, kind, pid, status, last_error, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    kind=excluded.kind,
    pid=excluded.pid,
    status=excluded.status,
    last_error=excluded.last_error,
    updated_at=excluded.updated_at
`, id, kind, pid, status, lastError, now)
	return err
}

func (s *stateDB) ListWorkers() ([]WorkerRecord, error) {
	rows, err := s.db.Query(`
SELECT id, kind, pid, status, last_error, updated_at FROM workers ORDER BY updated_at DESC
`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]WorkerRecord, 0)
	for rows.Next() {
		var rec WorkerRecord
		if err := rows.Scan(&rec.ID, &rec.Kind, &rec.PID, &rec.Status, &rec.LastError, &rec.UpdatedAt); err != nil {
			return nil, err
		}
		list = append(list, rec)
	}
	return list, rows.Err()
}

type WorkerRecord struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	PID       int    `json:"pid"`
	Status    string `json:"status"`
	LastError string `json:"last_error"`
	UpdatedAt string `json:"updated_at"`
}
