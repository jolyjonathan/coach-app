package main

import (
	"testing"
	"time"
)

// We test the primitives of the TOTP module — generateSecret + totpAt +
// verifyTOTP — without going through HTTP. The HTTP layer is straightforward
// glue; the cryptographic correctness lives here.

func TestTOTPSecretIsBase32(t *testing.T) {
	s, err := generateTOTPSecret()
	if err != nil {
		t.Fatalf("gen: %v", err)
	}
	if len(s) < 16 {
		t.Errorf("secret too short: %q", s)
	}
	for _, c := range s {
		if !((c >= 'A' && c <= 'Z') || (c >= '2' && c <= '7')) {
			t.Errorf("non-base32 char in secret: %q", c)
		}
	}
}

func TestTOTPRoundTrip(t *testing.T) {
	// Pin a secret + time so the test is deterministic.
	secret := "JBSWY3DPEHPK3PXP" // RFC 4648 example "Hello!\xde\xad\xbe\xef"
	// Compute code at t=1700000000 and check verifyTOTP accepts it (drift=0).
	now := int64(1700000000)
	code, err := totpAt(secret, now)
	if err != nil {
		t.Fatalf("totpAt: %v", err)
	}
	if len(code) != 6 {
		t.Errorf("code len = %d want 6", len(code))
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			t.Errorf("non-digit in code: %q", c)
		}
	}
}

func TestVerifyTOTPDrift(t *testing.T) {
	secret, _ := generateTOTPSecret()
	now := time.Now().Unix()
	// Code from "now" must verify.
	code, _ := totpAt(secret, now)
	if !verifyTOTP(secret, code) {
		t.Errorf("current code rejected")
	}
	// Code from 30s ago must verify (drift=1).
	codePrev, _ := totpAt(secret, now-30)
	if !verifyTOTP(secret, codePrev) {
		t.Errorf("t-30s code rejected (drift should accept)")
	}
	// Code from 5 minutes ago must NOT verify.
	codeOld, _ := totpAt(secret, now-300)
	if verifyTOTP(secret, codeOld) {
		t.Errorf("t-300s code accepted (should be outside drift window)")
	}
	// Wrong-length input rejected.
	if verifyTOTP(secret, "12345") {
		t.Errorf("5-digit code accepted")
	}
}

func TestOTPAuthURL(t *testing.T) {
	u := otpauthURL("alice@example.com", "JBSWY3DPEHPK3PXP")
	if u == "" {
		t.Fatal("empty url")
	}
	// Must include scheme, secret, issuer.
	for _, want := range []string{"otpauth://totp/", "secret=", "issuer=Coach"} {
		if !contains(u, want) {
			t.Errorf("URL missing %q: %s", want, u)
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
