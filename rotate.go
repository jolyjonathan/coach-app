package main

/*
rotate.go — sous-commande --rotate-key : rotation de COACH_TOKEN_KEY.

Ré-encrypte tous les champs chiffrés at-rest (TOTPSecret + valeurs de
PhysioTokens) de l'ancienne clé vers la nouvelle, en une passe, directement
en base. Les autres champs sensibles ne sont PAS concernés : les mots de
passe et recovery codes sont des hash bcrypt (non réversibles, pas de clé),
le webhook secret est un identifiant aléatoire non chiffré.

Usage (⚠️ l'app doit être ARRÊTÉE — elle tient les users en mémoire) :

  docker compose stop coach-app
  docker compose run --rm \
    -e COACH_TOKEN_KEY_OLD=<ancienne clé hex> \
    -e COACH_TOKEN_KEY=<nouvelle clé hex> \
    coach-app --rotate-key
  # mettre à jour COACH_TOKEN_KEY dans .env avec la NOUVELLE clé
  docker compose up -d coach-app

Idempotent : une valeur déjà déchiffrable avec la nouvelle clé est laissée
telle quelle ; une valeur en cleartext legacy est chiffrée avec la nouvelle
clé au passage. La commande échoue (exit 1) si une valeur n'est déchiffrable
avec AUCUNE des deux clés — rien n'est écrit dans ce cas (tout-ou-rien).
*/

import (
	"crypto/cipher"
	"fmt"
	"log"
	"os"
	"strings"
)

// rotateValue ré-encrypte une valeur stockée de oldA vers newA.
// Renvoie (nouvelleValeur, changé, erreur).
func rotateValue(oldA, newA cipher.AEAD, stored string) (string, bool, error) {
	if stored == "" {
		return "", false, nil
	}
	// Déjà sous la nouvelle clé ? (idempotence : re-run sans danger)
	if strings.HasPrefix(stored, encPrefix) {
		if _, err := decryptWithAEAD(newA, stored); err == nil {
			return stored, false, nil
		}
		// Sinon : doit être déchiffrable avec l'ancienne clé.
		plain, err := decryptWithAEAD(oldA, stored)
		if err != nil {
			return "", false, fmt.Errorf("valeur indéchiffrable avec l'ancienne ET la nouvelle clé : %w", err)
		}
		enc, err := encryptWithAEAD(newA, plain)
		return enc, true, err
	}
	// Cleartext legacy → on en profite pour chiffrer sous la nouvelle clé.
	enc, err := encryptWithAEAD(newA, stored)
	return enc, true, err
}

// runRotateKey est appelé par main() pour le sub-mode --rotate-key.
// Se termine toujours par os.Exit.
func runRotateKey() {
	newKey := strings.TrimSpace(getenvOrFile("COACH_TOKEN_KEY", ""))
	oldKey := strings.TrimSpace(getenvOrFile("COACH_TOKEN_KEY_OLD", ""))
	if newKey == "" || oldKey == "" {
		log.Println("rotate-key: COACH_TOKEN_KEY (nouvelle) et COACH_TOKEN_KEY_OLD (ancienne) sont requis")
		os.Exit(1)
	}
	if newKey == oldKey {
		log.Println("rotate-key: la nouvelle clé est identique à l'ancienne — rien à faire")
		os.Exit(1)
	}
	newA, err := newAEADFromHexKey(newKey)
	if err != nil {
		log.Printf("rotate-key: COACH_TOKEN_KEY : %v", err)
		os.Exit(1)
	}
	oldA, err := newAEADFromHexKey(oldKey)
	if err != nil {
		log.Printf("rotate-key: COACH_TOKEN_KEY_OLD : %v", err)
		os.Exit(1)
	}

	if os.Getenv("COACH_DB") == "" {
		log.Println("rotate-key: COACH_DB requis (la rotation opère directement en base)")
		os.Exit(1)
	}
	if err := initSQL(); err != nil {
		log.Printf("rotate-key: init SQL: %v", err)
		os.Exit(1)
	}

	list, err := dbLoadUsers()
	if err != nil {
		log.Printf("rotate-key: chargement users: %v", err)
		os.Exit(1)
	}

	// Passe 1 : tout ré-encrypter en mémoire. La moindre erreur = abandon
	// AVANT toute écriture (tout-ou-rien : pas d'état mixte en base).
	rotated := 0
	for _, u := range list {
		if nv, changed, err := rotateValue(oldA, newA, u.TOTPSecret); err != nil {
			log.Printf("rotate-key: user %s: TOTPSecret: %v", u.ID, err)
			os.Exit(1)
		} else if changed {
			u.TOTPSecret = nv
			rotated++
		}
		for k, v := range u.PhysioTokens {
			if nv, changed, err := rotateValue(oldA, newA, v); err != nil {
				log.Printf("rotate-key: user %s: PhysioTokens[%s]: %v", u.ID, k, err)
				os.Exit(1)
			} else if changed {
				u.PhysioTokens[k] = nv
				rotated++
			}
		}
	}

	// Passe 2 : écriture unique.
	if err := dbSaveAllUsers(list); err != nil {
		log.Printf("rotate-key: écriture users: %v", err)
		os.Exit(1)
	}
	log.Printf("rotate-key: OK — %d valeur(s) ré-encryptée(s) sur %d utilisateur(s). "+
		"Mettre à jour COACH_TOKEN_KEY dans .env avec la nouvelle clé avant de relancer l'app.",
		rotated, len(list))
	os.Exit(0)
}
