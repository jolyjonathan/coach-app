package main

import (
	"strings"
	"testing"
	"time"
)

func TestGenerateRecoveryCodesShapeAndHash(t *testing.T) {
	plain, hashed := generateRecoveryCodes()
	if len(plain) != recoveryCodeCount || len(hashed) != recoveryCodeCount {
		t.Fatalf("count: plain=%d hashed=%d want %d", len(plain), len(hashed), recoveryCodeCount)
	}
	for _, p := range plain {
		// Format "abcd-efgh".
		if len(p) != 9 || p[4] != '-' {
			t.Errorf("format inattendu: %q", p)
		}
	}
	// Les hashs ne doivent JAMAIS contenir le clair.
	for i := range plain {
		if strings.Contains(hashed[i], normalizeRecoveryCode(plain[i])) {
			t.Errorf("le hash fuit le code en clair")
		}
	}
}

func TestConsumeRecoveryCodeSingleUse(t *testing.T) {
	plain, hashed := generateRecoveryCodes()
	u := &User{RecoveryCodes: hashed}

	// Un code valide est accepté et consommé.
	if !consumeRecoveryCode(u, plain[0]) {
		t.Fatal("code valide refusé")
	}
	if len(u.RecoveryCodes) != recoveryCodeCount-1 {
		t.Errorf("code non consommé: reste %d", len(u.RecoveryCodes))
	}
	// Le même code ne marche plus (usage unique).
	if consumeRecoveryCode(u, plain[0]) {
		t.Error("code réutilisé accepté — doit être usage unique")
	}
	// Tolérance casse / tirets / espaces.
	if !consumeRecoveryCode(u, strings.ToUpper(plain[1])) {
		t.Error("variante majuscule refusée")
	}
	noDash := strings.ReplaceAll(plain[2], "-", "")
	if !consumeRecoveryCode(u, noDash) {
		t.Error("variante sans tiret refusée")
	}
	// Un code bidon est refusé.
	if consumeRecoveryCode(u, "zzzz-zzzz") {
		t.Error("code invalide accepté")
	}
}

func TestRecoveryCodeLoginFallback(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	twofaRequired = false
	defer func() { twofaRequired = false }()

	cookies, csrf := registerAndLogin(t, mux, "recover@example.com", "Correct-horse-9")

	// Enrôle la 2FA et récupère les codes en clair.
	setup := doJSON(t, mux, "POST", "/api/2fa/setup", map[string]any{}, cookies, csrf)
	if setup.status != 200 {
		t.Fatalf("2fa setup: %d", setup.status)
	}
	secret, _ := setup.body["secret"].(string)
	code, _ := totpAt(secret, time.Now().Unix())
	verify := doJSON(t, mux, "POST", "/api/2fa/verify", map[string]any{"code": code}, cookies, csrf)
	if verify.status != 200 {
		t.Fatalf("2fa verify: %d body=%v", verify.status, verify.body)
	}
	rc, ok := verify.body["recoveryCodes"].([]any)
	if !ok || len(rc) != recoveryCodeCount {
		t.Fatalf("recoveryCodes manquants au verify: %v", verify.body["recoveryCodes"])
	}
	firstCode, _ := rc[0].(string)

	// Logout puis login avec mot de passe + code de RÉCUPÉRATION (pas TOTP).
	doJSON(t, mux, "POST", "/api/logout", nil, cookies, csrf)
	login := doJSON(t, mux, "POST", "/api/login", map[string]string{
		"email": "recover@example.com", "password": "Correct-horse-9", "totpCode": firstCode,
	}, nil, "")
	if login.status != 200 {
		t.Fatalf("login via recovery code: status=%d body=%v", login.status, login.body)
	}

	// Le même code de récupération ne doit plus marcher (usage unique).
	doJSON(t, mux, "POST", "/api/logout", nil, login.cookies, "")
	login2 := doJSON(t, mux, "POST", "/api/login", map[string]string{
		"email": "recover@example.com", "password": "Correct-horse-9", "totpCode": firstCode,
	}, nil, "")
	if login2.status == 200 {
		t.Error("code de récupération réutilisé accepté — doit être usage unique")
	}
}
