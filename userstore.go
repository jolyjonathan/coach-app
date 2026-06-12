package main

/*
userstore.go — Façade typée sur le store utilisateurs (audit modularité).

Suite de la « recette » posée par SessionStore (session.go) : encapsuler les
globales `usersByID` / `usersByEm` / `usersMu` derrière une API à méthodes.

Migration INCRÉMENTALE et assumée :
  - les globales restent la source de stockage (61 sites y accèdent encore
    via des sections lock/RLock multi-champs, trop variées pour une bascule
    aveugle sans risque) ;
  - tout CODE NOUVEAU passe par userStore.* ;
  - les accesseurs propres et bornés (lecture par id, snapshot, itération,
    bootstrap) sont déjà migrés ici ;
  - les sections d'écriture multi-champs migreront une par une, jusqu'à
    pouvoir rendre les champs privés et paralléliser les tests.

Le but final (tests `-parallel`, frontières compilées) s'atteint quand le
dernier accès direct a disparu — ce fichier en est le point d'ancrage.
*/

// UserStore enveloppe les maps utilisateurs. Il NE possède pas encore le
// mutex en propre (il référence usersMu) pendant la migration — voir l'en-tête.
type UserStore struct{}

var userStore = &UserStore{}

// ByID renvoie le pointeur utilisateur (ou nil) sous RLock.
func (s *UserStore) ByID(id string) *User {
	usersMu.RLock()
	defer usersMu.RUnlock()
	return usersByID[id]
}

// ByEmail renvoie l'utilisateur par email normalisé (ou nil) sous RLock.
func (s *UserStore) ByEmail(emailLower string) *User {
	usersMu.RLock()
	defer usersMu.RUnlock()
	return usersByEm[emailLower]
}

// Exists indique si un email est déjà pris (sous RLock).
func (s *UserStore) Exists(emailLower string) bool {
	usersMu.RLock()
	defer usersMu.RUnlock()
	_, ok := usersByEm[emailLower]
	return ok
}

// Count renvoie le nombre d'utilisateurs.
func (s *UserStore) Count() int {
	usersMu.RLock()
	defer usersMu.RUnlock()
	return len(usersByID)
}

// Add insère un nouvel utilisateur dans les deux index sous Lock.
func (s *UserStore) Add(u *User) {
	usersMu.Lock()
	usersByID[u.ID] = u
	usersByEm[u.EmailLower] = u
	usersMu.Unlock()
}

// Delete retire un utilisateur des deux index sous Lock.
func (s *UserStore) Delete(id string) {
	usersMu.Lock()
	if u := usersByID[id]; u != nil {
		delete(usersByEm, u.EmailLower)
		delete(usersByID, id)
	}
	usersMu.Unlock()
}

// Snapshot renvoie une copie de la liste des pointeurs (pour sérialisation
// hors verrou). Les pointeurs sont partagés — ne pas muter les User pendant
// la sérialisation (l'appelant tient le verrou applicatif si besoin).
func (s *UserStore) Snapshot() []*User {
	usersMu.RLock()
	defer usersMu.RUnlock()
	list := make([]*User, 0, len(usersByID))
	for _, u := range usersByID {
		list = append(list, u)
	}
	return list
}

// CountAdmins compte les administrateurs (sous RLock). Sert aux garde-fous
// « il doit rester au moins un admin ».
func (s *UserStore) CountAdmins(excludeID string) int {
	usersMu.RLock()
	defer usersMu.RUnlock()
	return s.countAdmins(excludeID)
}

// CountAdminsLocked : même chose mais l'appelant tient DÉJÀ usersMu.Lock()
// (les handlers admin modifient/suppriment sous Lock et vérifient le quorum
// dans la même section critique — RWMutex non réentrant, on ne reprend pas
// le verrou).
func (s *UserStore) CountAdminsLocked(excludeID string) int {
	return s.countAdmins(excludeID)
}

func (s *UserStore) countAdmins(excludeID string) int {
	n := 0
	for _, u := range usersByID {
		if u.IsAdmin && u.ID != excludeID {
			n++
		}
	}
	return n
}
