package main

/*
store.go — Flusher d'écritures disque à dirty-flag (audit modularité, action 1).

Problème résolu : users.json et sessions.json étaient réécrits EN ENTIER à
chaque mutation, souvent via un `go saveX()` fire-and-forget — une goroutine
par sauvegarde, sans coalescing. Trois mutations rapprochées = trois
sérialisations complètes concurrentes du même fichier.

Principe (généralisation du pattern rateLimitSnapshotter) :
  - les writers appellent markUsersDirty() / markSessionsDirty() — O(1),
    aucune I/O, aucun spawn de goroutine ;
  - UNE goroutine (storeFlusher) vérifie les flags toutes les 2 s et
    n'écrit que si quelque chose a changé ;
  - flushStores() force l'écriture au shutdown (appelé par main après
    srv.Shutdown), donc la fenêtre de perte max est ~2 s de mutations
    asynchrones — identique à l'ancienne fenêtre du `go saveX()` qui
    pouvait être préempté avant d'écrire.

Les chemins qui exigent une durabilité AVANT la réponse HTTP (register,
change-password, delete-account, 2FA verify…) continuent d'appeler
saveUsers() de façon synchrone — le flusher ne s'applique qu'aux écritures
qui étaient déjà asynchrones.
*/

import (
	"sync"
	"time"
)

var (
	storeDirtyMu  sync.Mutex
	usersDirty    bool
	sessionsDirty bool
)

// markUsersDirty signale qu'une mutation de users.json attend d'être
// persistée. Coalescé par le flusher.
func markUsersDirty() {
	storeDirtyMu.Lock()
	usersDirty = true
	storeDirtyMu.Unlock()
}

// markSessionsDirty signale qu'une mutation de sessions.json attend d'être
// persistée. Coalescé par le flusher.
func markSessionsDirty() {
	storeDirtyMu.Lock()
	sessionsDirty = true
	storeDirtyMu.Unlock()
}

// takeDirtyFlags lit-et-efface les deux flags atomiquement.
func takeDirtyFlags() (users, sessions bool) {
	storeDirtyMu.Lock()
	users, sessions = usersDirty, sessionsDirty
	usersDirty, sessionsDirty = false, false
	storeDirtyMu.Unlock()
	return
}

// storeFlusher tourne en goroutine : flush des fichiers marqués dirty
// toutes les 2 secondes. Une seule écriture par fichier quel que soit le
// nombre de mutations dans la fenêtre.
func storeFlusher() {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for range t.C {
		u, s := takeDirtyFlags()
		if u {
			saveUsers()
		}
		if s {
			saveSessions()
		}
	}
}

// flushStores force l'écriture des stores dirty — appelé au shutdown pour
// ne rien perdre de la dernière fenêtre de 2 s.
func flushStores() {
	u, s := takeDirtyFlags()
	if u {
		saveUsers()
	}
	if s {
		saveSessions()
	}
}
