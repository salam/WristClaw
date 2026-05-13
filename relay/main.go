package main

import (
	"log"
	"net/http"
	"os"

	"github.com/salam/wristclaw/relay/server"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	relay := server.NewRelay()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", relay.HandleWebSocket)
	mux.HandleFunc("/watch/join", relay.HandleWatchJoin)
	mux.HandleFunc("/watch/send", relay.HandleWatchSend)
	mux.HandleFunc("/watch/poll", relay.HandleWatchPoll)
	mux.HandleFunc("/host/join", relay.HandleHostJoin)
	mux.HandleFunc("/host/send", relay.HandleHostSend)
	mux.HandleFunc("/host/poll", relay.HandleHostPoll)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	log.Printf("WristClaw relay listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
