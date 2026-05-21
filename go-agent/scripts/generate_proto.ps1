# Generate Go gRPC stubs from proto/agent.proto
# Requires: protoc, protoc-gen-go, protoc-gen-go-grpc

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ProtoDir = Join-Path $Root "proto"
$OutDir = $ProtoDir

Write-Host "Generating Go protobuf stubs into $OutDir"

protoc `
  --proto_path="$ProtoDir" `
  --go_out="$OutDir" --go_opt=paths=source_relative `
  --go-grpc_out="$OutDir" --go-grpc_opt=paths=source_relative `
  (Join-Path $ProtoDir "agent.proto")

Write-Host "Done."
