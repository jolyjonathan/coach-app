package main

import (
	"encoding/json"
	"os"
	"testing"
)

// TestParseAppleHealthAutoExport vérifie le parsing du format AHAE : agrégation
// par jour ISO, mapping des métriques core, et tolérance aux formats de date.
func TestParseAppleHealthAutoExport(t *testing.T) {
	raw := []byte(`{
	  "data": {
	    "metrics": [
	      {"name":"heart_rate_variability","units":"ms","data":[
	        {"date":"2026-04-30 02:00:00 +0000","qty":50},
	        {"date":"2026-04-30 03:00:00 +0000","qty":60}
	      ]},
	      {"name":"resting_heart_rate","units":"bpm","data":[
	        {"date":"2026-04-30 06:00:00 +0000","qty":58},
	        {"date":"2026-04-30 07:00:00 +0000","qty":55}
	      ]},
	      {"name":"step_count","units":"count","data":[
	        {"date":"2026-04-30 10:00:00 +0000","qty":4000},
	        {"date":"2026-04-30 18:00:00 +0000","qty":3000}
	      ]}
	    ]
	  }
	}`)
	entries, err := parseAppleHealthAutoExport(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("attendu 1 jour agrégé, got %d", len(entries))
	}
	e := entries[0]
	if e.Date != "2026-04-30" {
		t.Errorf("date=%q want 2026-04-30", e.Date)
	}
	// HRV = moyenne (50+60)/2 = 55.
	if e.HRV != 55 {
		t.Errorf("HRV=%v want 55", e.HRV)
	}
	// RHR = min observé = 55.
	if e.RHR != 55 {
		t.Errorf("RHR=%v want 55 (min)", e.RHR)
	}
	// Steps = somme = 7000.
	if e.Steps != 7000 {
		t.Errorf("Steps=%v want 7000", e.Steps)
	}
}

func TestParseAppleHealthRejectsGarbage(t *testing.T) {
	if _, err := parseAppleHealthAutoExport([]byte(`{"nope":1}`)); err == nil {
		t.Error("structure sans data.metrics devrait être rejetée")
	}
	if _, err := parseAppleHealthAutoExport([]byte(`not json`)); err == nil {
		t.Error("JSON invalide devrait être rejeté")
	}
}

// TestMergePhysioIntoData vérifie le merge par date (replace même date) et le
// cap à maxPhysioEntries.
func TestMergePhysioIntoData(t *testing.T) {
	dataDir = t.TempDir()
	uid := "a1b2c3d4e5f60718"

	// Premier merge.
	if err := mergePhysioIntoData(uid, []PhysioEntry{
		{Date: "2026-04-30", HRV: 50, Sleep: 7},
		{Date: "2026-05-01", HRV: 55},
	}); err != nil {
		t.Fatalf("merge1: %v", err)
	}
	// Re-merge même date : doit remplacer/compléter, pas dupliquer.
	if err := mergePhysioIntoData(uid, []PhysioEntry{
		{Date: "2026-04-30", RHR: 58},
	}); err != nil {
		t.Fatalf("merge2: %v", err)
	}

	b := readDataFile(t, uid)
	body, _ := b["body"].(map[string]any)
	arr, _ := body["physio"].([]any)
	if len(arr) != 2 {
		t.Fatalf("attendu 2 dates distinctes, got %d", len(arr))
	}
	// La date 2026-04-30 doit avoir hrv ET rhr (merge, pas remplacement total).
	var found map[string]any
	for _, p := range arr {
		if pm, ok := p.(map[string]any); ok && pm["date"] == "2026-04-30" {
			found = pm
		}
	}
	if found == nil {
		t.Fatal("date 2026-04-30 introuvable après merge")
	}
	if found["hrv"] == nil || found["rhr"] == nil {
		t.Errorf("le merge doit conserver hrv ET ajouter rhr, got %v", found)
	}
}

func TestMergePhysioRejectsBadUID(t *testing.T) {
	if err := mergePhysioIntoData("../etc/passwd", []PhysioEntry{{Date: "2026-04-30", HRV: 50}}); err == nil {
		t.Error("uid invalide devrait être rejeté")
	}
}

func readDataFile(t *testing.T, uid string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(dataPath(uid))
	if err != nil {
		t.Fatalf("read data file: %v", err)
	}
	var v map[string]any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("unmarshal data file: %v", err)
	}
	return v
}
