package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/itmatzip/itmatzip-agent-go-prototype/proto"
)

type grpcWorkerClient struct {
	addr      string
	conn      *grpc.ClientConn
	client    pb.WorkerControlClient
	inference pb.InferenceClient
}

func newGRPCWorkerClient(addr string) *grpcWorkerClient {
	return &grpcWorkerClient{addr: addr}
}

func (c *grpcWorkerClient) Connect(ctx context.Context) error {
	if c.conn != nil {
		return nil
	}
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := grpc.DialContext(
		dialCtx,
		c.addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		return fmt.Errorf("grpc dial %s: %w", c.addr, err)
	}
	c.conn = conn
	c.client = pb.NewWorkerControlClient(conn)
	c.inference = pb.NewInferenceClient(conn)
	return nil
}

func (c *grpcWorkerClient) Close() error {
	if c.conn == nil {
		return nil
	}
	err := c.conn.Close()
	c.conn = nil
	c.client = nil
	c.inference = nil
	return err
}

func (c *grpcWorkerClient) Health(ctx context.Context) (map[string]any, error) {
	if c.client == nil {
		if err := c.Connect(ctx); err != nil {
			return nil, err
		}
	}
	resp, err := c.client.Health(ctx, &pb.Empty{})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"status":  resp.GetStatus(),
		"version": resp.GetVersion(),
		"ready":   resp.GetReady(),
	}, nil
}

func (c *grpcWorkerClient) Status(ctx context.Context) (map[string]any, error) {
	if c.client == nil {
		if err := c.Connect(ctx); err != nil {
			return nil, err
		}
	}
	resp, err := c.client.Status(ctx, &pb.Empty{})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"worker_status": resp.GetWorkerStatus(),
		"last_error":    resp.GetLastError(),
	}, nil
}

func (c *grpcWorkerClient) Predict(ctx context.Context, modelID string, input []byte) (map[string]any, error) {
	if c.inference == nil {
		if err := c.Connect(ctx); err != nil {
			return nil, err
		}
	}
	resp, err := c.inference.Predict(ctx, &pb.InferenceRequest{
		ModelId:      modelID,
		InputPayload: input,
	})
	if err != nil {
		return nil, err
	}
	result := map[string]any{
		"status": resp.GetStatus(),
	}
	if len(resp.GetOutputPayload()) > 0 {
		var parsed map[string]any
		if err := json.Unmarshal(resp.GetOutputPayload(), &parsed); err == nil {
			result["result"] = parsed
		} else {
			result["output_payload"] = resp.GetOutputPayload()
		}
	}
	return result, nil
}
