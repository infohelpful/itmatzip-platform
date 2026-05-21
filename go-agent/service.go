package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/kardianos/service"
)

const windowsServiceName = "ItMatZipAgent"

type program struct {
	ctx         context.Context
	cancel      context.CancelFunc
	hub         *wsHub
	mgr         *workerManager
	sidecar     *fastapiSidecar
	port        int
	grpcPort    int
	fastapiPort int
}

func (p *program) Start(s service.Service) error {
	log.Print("service starting")
	initPaths()
	if err := ensurePaths(); err != nil {
		return err
	}
	setupLogging()

	p.ctx, p.cancel = context.WithCancel(context.Background())
	p.hub = newHub()
	initUpdateManager(p.ctx)
	grpcAddr := fmt.Sprintf("%s:%d", defaultHost, p.grpcPort)
	p.mgr = newWorkerManager(p.hub, grpcAddr)

	go func() {
		if err := p.mgr.startPythonWorker(p.ctx); err != nil {
			log.Printf("failed to start Python stdio worker: %v", err)
		}
		if err := p.mgr.startGRPCWorker(p.ctx); err != nil {
			log.Printf("failed to start Python gRPC worker: %v", err)
		} else if err := p.mgr.grpcClient.Connect(p.ctx); err != nil {
			log.Printf("grpc client connect failed: %v", err)
		}

		p.sidecar = newFastAPISidecar(p.fastapiPort)
		go func() {
			if err := p.sidecar.Start(p.ctx, p.mgr); err != nil {
				log.Printf("failed to start FastAPI sidecar: %v", err)
			}
		}()

		if err := startHTTPServer(p.ctx, p.hub, p.mgr, p.port, p.sidecar); err != nil {
			log.Printf("service HTTP server stopped: %v", err)
		}
	}()
	return nil
}

func (p *program) Stop(s service.Service) error {
	log.Print("service stopping")
	if p.sidecar != nil {
		p.sidecar.Stop()
	}
	if p.cancel != nil {
		p.cancel()
	}
	if p.mgr != nil {
		p.mgr.stop()
	}
	time.Sleep(200 * time.Millisecond)
	return nil
}

func serviceConfig(port, grpcPort, fastapiPort int) *service.Config {
	exe, err := serviceExecutable()
	if err != nil {
		log.Printf("warning: resolve service executable: %v", err)
	}
	return &service.Config{
		Name:        windowsServiceName,
		DisplayName: "ItMatZip Agent",
		Description: "ItMatZip local agent service for model management and AI worker orchestration.",
		Executable:  exe,
		Arguments: []string{
			"--service",
			fmt.Sprintf("--port=%d", port),
			fmt.Sprintf("--grpc-port=%d", grpcPort),
			fmt.Sprintf("--fastapi-port=%d", fastapiPort),
		},
	}
}

func serviceExecutable() (string, error) {
	return os.Executable()
}

func installService(port, grpcPort, fastapiPort int) error {
	prg := &program{port: port, grpcPort: grpcPort, fastapiPort: fastapiPort}
	cfg := serviceConfig(port, grpcPort, fastapiPort)
	svc, err := service.New(prg, cfg)
	if err != nil {
		return err
	}
	if err := svc.Install(); err != nil {
		if _, statusErr := svc.Status(); statusErr == nil {
			log.Printf("service %s already installed, skipping register", cfg.Name)
			return nil
		}
		return err
	}
	if err := startWindowsService(); err != nil {
		log.Printf("warning: could not start service after install: %v", err)
	}
	return nil
}

func restartWindowsService() error {
	if err := stopWindowsService(); err != nil {
		return err
	}
	time.Sleep(800 * time.Millisecond)
	return startWindowsService()
}

func uninstallService() error {
	_ = stopWindowsService()
	prg := &program{}
	cfg := &service.Config{Name: windowsServiceName}
	svc, err := service.New(prg, cfg)
	if err != nil {
		return err
	}
	if err := svc.Uninstall(); err != nil {
		if _, statusErr := svc.Status(); statusErr != nil {
			log.Printf("service %s not installed, skipping unregister", cfg.Name)
			return nil
		}
		return err
	}
	return nil
}

func runService(port, grpcPort, fastapiPort int) error {
	prg := &program{port: port, grpcPort: grpcPort, fastapiPort: fastapiPort}
	svc, err := service.New(prg, serviceConfig(port, grpcPort, fastapiPort))
	if err != nil {
		return err
	}
	return svc.Run()
}
