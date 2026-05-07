package main

// RFC 6238 TOTP (Time-based One-Time Password) — minimal implementation.
//
// Why hand-rolled? Adding a third-party dependency for ~80 lines of well-defined
// crypto isn't worth the supply-chain surface. crypto/hmac + crypto/sha1 +
// encoding/base32 are all stdlib, all stable.
//
// Algorithm:
//   T  = floor(unix_time / 30)
//   H  = HMAC-SHA1(secret, T_as_8_bytes_big_endian)
//   o  = H[19] & 0x0f                          // dynamic offset
//   d  = (H[o..o+4] & 0x7fffffff) % 10^6       // 6-digit truncation
//
// Verification accepts ±1 step (90s window total) for clock drift tolerance.
// We could expose this as a constant if we ever want stricter security.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const totpStep = 30 // seconds
const totpDigits = 6
const totpDrift = 1 // accept t-1, t, t+1

// generateTOTPSecret returns a fresh 20-byte secret encoded as base32 (no
// padding, uppercase) — the format Authenticator apps consume natively.
func generateTOTPSecret() (string, error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return strings.TrimRight(base32.StdEncoding.EncodeToString(raw), "="), nil
}

// totpAt returns the 6-digit code for the given secret at time `t` (unix s).
func totpAt(secretB32 string, t int64) (string, error) {
	// Re-pad to a multiple of 8 — Go's StdEncoding requires it.
	pad := strings.Repeat("=", (8-len(secretB32)%8)%8)
	key, err := base32.StdEncoding.DecodeString(strings.ToUpper(secretB32) + pad)
	if err != nil {
		return "", err
	}
	counter := uint64(t / totpStep)
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	h := mac.Sum(nil)
	off := h[len(h)-1] & 0x0f
	val := (uint32(h[off])&0x7f)<<24 |
		uint32(h[off+1])<<16 |
		uint32(h[off+2])<<8 |
		uint32(h[off+3])
	return fmt.Sprintf("%0*d", totpDigits, val%1000000), nil
}

// verifyTOTP accepts a code if it matches any step in [t-drift .. t+drift].
// Returns true on success. We compare via constant-time equality on each step.
func verifyTOTP(secretB32, code string) bool {
	if len(code) != totpDigits {
		return false
	}
	now := time.Now().Unix()
	for i := -totpDrift; i <= totpDrift; i++ {
		want, err := totpAt(secretB32, now+int64(i)*totpStep)
		if err != nil {
			return false
		}
		// Constant-time compare. hmac.Equal is fine on equal-length strings.
		if hmac.Equal([]byte(want), []byte(code)) {
			return true
		}
	}
	return false
}

// otpauthURL builds the standard otpauth:// URL that Authenticator apps consume.
// Issuer is set to "Coach" so the entry shows up cleanly in the user's app.
func otpauthURL(accountEmail, secretB32 string) string {
	u := url.URL{
		Scheme: "otpauth",
		Host:   "totp",
		Path:   "/Coach:" + accountEmail,
	}
	q := u.Query()
	q.Set("secret", secretB32)
	q.Set("issuer", "Coach")
	q.Set("algorithm", "SHA1")
	q.Set("digits", "6")
	q.Set("period", "30")
	u.RawQuery = q.Encode()
	return u.String()
}
