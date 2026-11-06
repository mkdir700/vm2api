package egress

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"sync"
	"syscall"
	"time"
)

// flowGate serializes listener admission with pause. Count before launching a handler.
type flowGate struct {
	mu     sync.Mutex
	paused bool
	active int
}

func (g *flowGate) begin() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.paused {
		return false
	}
	g.active++
	return true
}

func (g *flowGate) end() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.active--
}

func (s *Server) controlListener() (net.Listener, error) {
	if s.cfg.ControlSocket == "" {
		return nil, nil
	}
	listener, err := net.Listen("unix", s.cfg.ControlSocket)
	if errors.Is(err, syscall.EADDRINUSE) {
		// An unclean exit can leave a pathname. Preserve any live or uncertain listener.
		previous, statErr := os.Lstat(s.cfg.ControlSocket)
		if statErr == nil && previous.Mode()&os.ModeSocket != 0 {
			connection, dialErr := net.DialTimeout("unix", s.cfg.ControlSocket, 200*time.Millisecond)
			if connection != nil {
				connection.Close()
			} else if errors.Is(dialErr, syscall.ECONNREFUSED) {
				current, currentErr := os.Lstat(s.cfg.ControlSocket)
				if currentErr == nil && os.SameFile(previous, current) {
					if removeErr := os.Remove(s.cfg.ControlSocket); removeErr == nil {
						listener, err = net.Listen("unix", s.cfg.ControlSocket)
					}
				}
			}
		}
	}
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(s.cfg.ControlSocket, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	var identity [16]byte
	if _, err := rand.Read(identity[:]); err != nil {
		listener.Close()
		return nil, err
	}
	instance := hex.EncodeToString(identity[:])
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !((r.Method == http.MethodGet && r.URL.Path == "/status") ||
			(r.Method == http.MethodPost && (r.URL.Path == "/pause" || r.URL.Path == "/resume"))) {
			http.NotFound(w, r)
			return
		}
		if match := r.Header.Get("If-Match"); match != "" && match != instance {
			http.Error(w, "helper instance changed", http.StatusConflict)
			return
		}
		s.flows.mu.Lock()
		if r.URL.Path == "/pause" {
			s.flows.paused = true
		}
		if r.URL.Path == "/resume" {
			s.flows.paused = false
		}
		state := struct {
			Instance string `json:"instance"`
			Version  int    `json:"version"`
			ProxyID  string `json:"proxy_id"`
			Paused   bool   `json:"paused"`
			Active   int    `json:"active"`
		}{instance, 1, s.cfg.ProxyID, s.flows.paused, s.flows.active}
		s.flows.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(state)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second}
	go func() { _ = server.Serve(listener) }()
	return listener, nil
}
