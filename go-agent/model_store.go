package main

import (
	"path/filepath"
	"time"
)

type ModelMetadata struct {
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	Filename  string    `json:"filename"`
	Size      int64     `json:"size"`
	SHA256    string    `json:"sha256,omitempty"`
	Status    string    `json:"status"`
	Message   string    `json:"message"`
	UpdatedAt time.Time `json:"updated_at"`
}

type modelStore struct {
	db *stateDB
}

func newModelStore(dbPath string) (*modelStore, error) {
	db, err := newStateDB(dbPath)
	if err != nil {
		return nil, err
	}
	return &modelStore{db: db}, nil
}

func (s *modelStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *modelStore) Set(metadata ModelMetadata) error {
	return s.db.UpsertModel(metadata)
}

func (s *modelStore) Get(modelID string) (ModelMetadata, bool) {
	meta, ok, err := s.db.GetModel(modelID)
	if err != nil || !ok {
		return ModelMetadata{}, false
	}
	return meta, true
}

func (s *modelStore) List() []ModelMetadata {
	list, err := s.db.ListModels()
	if err != nil {
		return nil
	}
	return list
}

func defaultStateDBPath() string {
	return filepath.Join(settingsRootPath, "state.db")
}
