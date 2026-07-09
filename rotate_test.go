package main

import (
	"strings"
	"testing"
)

// Clés de test (32 bytes hex chacune).
const (
	rtKeyOld = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	rtKeyNew = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func TestRotateValue(t *testing.T) {
	oldA, err := newAEADFromHexKey(rtKeyOld)
	if err != nil {
		t.Fatalf("old AEAD: %v", err)
	}
	newA, err := newAEADFromHexKey(rtKeyNew)
	if err != nil {
		t.Fatalf("new AEAD: %v", err)
	}

	t.Run("valeur vide inchangée", func(t *testing.T) {
		out, changed, err := rotateValue(oldA, newA, "")
		if err != nil || changed || out != "" {
			t.Fatalf("out=%q changed=%v err=%v", out, changed, err)
		}
	})

	t.Run("chiffré ancienne clé → ré-encrypté nouvelle clé", func(t *testing.T) {
		enc, err := encryptWithAEAD(oldA, "secret-totp-base32")
		if err != nil {
			t.Fatalf("encrypt old: %v", err)
		}
		out, changed, err := rotateValue(oldA, newA, enc)
		if err != nil || !changed {
			t.Fatalf("changed=%v err=%v", changed, err)
		}
		if !strings.HasPrefix(out, encPrefix) {
			t.Fatalf("sortie non chiffrée : %q", out)
		}
		plain, err := decryptWithAEAD(newA, out)
		if err != nil || plain != "secret-totp-base32" {
			t.Fatalf("round-trip : plain=%q err=%v", plain, err)
		}
		// Et l'ancienne clé ne doit plus pouvoir lire la sortie.
		if _, err := decryptWithAEAD(oldA, out); err == nil {
			t.Fatal("la sortie est encore déchiffrable avec l'ancienne clé")
		}
	})

	t.Run("déjà sous la nouvelle clé → idempotent", func(t *testing.T) {
		enc, _ := encryptWithAEAD(newA, "déjà-migré")
		out, changed, err := rotateValue(oldA, newA, enc)
		if err != nil || changed || out != enc {
			t.Fatalf("out=%q changed=%v err=%v", out, changed, err)
		}
	})

	t.Run("cleartext legacy → chiffré nouvelle clé", func(t *testing.T) {
		out, changed, err := rotateValue(oldA, newA, "token-en-clair")
		if err != nil || !changed {
			t.Fatalf("changed=%v err=%v", changed, err)
		}
		plain, err := decryptWithAEAD(newA, out)
		if err != nil || plain != "token-en-clair" {
			t.Fatalf("round-trip : plain=%q err=%v", plain, err)
		}
	})

	t.Run("indéchiffrable avec les deux clés → erreur", func(t *testing.T) {
		thirdA, _ := newAEADFromHexKey("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
		enc, _ := encryptWithAEAD(thirdA, "orphelin")
		if _, _, err := rotateValue(oldA, newA, enc); err == nil {
			t.Fatal("erreur attendue pour une valeur chiffrée avec une clé inconnue")
		}
	})
}
