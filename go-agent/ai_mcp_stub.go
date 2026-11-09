//go:build !windows

package main

import "net/http"

func mountAIMCPSettings(*http.ServeMux) {}
