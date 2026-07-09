package main

import "testing"

// TestStravaNoEnergyFallback fige le comportement Audit F4 : une activité sans
// calories ni kJ (footing sans capteur, hors Premium) ressort avec
// ActiveEnergy=0 — PAS d'estimation duration×HR, même si MovingTime et la FC
// sont présents. Si quelqu'un ajoute un fallback un jour, ce test doit être
// mis à jour consciemment.
func TestStravaNoEnergyFallback(t *testing.T) {
	e := stravaActivityToPhysio(&stravaActivity{
		StartDateLocal: "2026-07-08T18:00:00Z",
		MovingTime:     1800,
		HasHeartrate:   true, AverageHeartrate: 140,
	})
	if e.ActiveEnergy != 0 {
		t.Errorf("ActiveEnergy=%v want 0 (pas d'estimation duration×HR — Audit F4)", e.ActiveEnergy)
	}
	if e.AvgHR != 140 {
		t.Errorf("AvgHR=%v want 140", e.AvgHR)
	}
}

// TestIsoDayFromAHAE couvre les trois formats de date-time émis par Apple
// Health Auto Export selon la config, plus les entrées invalides.
func TestIsoDayFromAHAE(t *testing.T) {
	cases := map[string]string{
		"2026-04-30 02:00:00 +0000": "2026-04-30",
		"2026-04-30T02:00:00Z":      "2026-04-30",
		"2026-04-30":                "2026-04-30",
		"30/04/2026":                "", // format non supporté → rejeté proprement
		"court":                     "",
		"":                          "",
	}
	for in, want := range cases {
		if got := isoDayFromAHAE(in); got != want {
			t.Errorf("isoDayFromAHAE(%q)=%q want %q", in, got, want)
		}
	}
}

// TestParseAHAESleepAnalysis couvre la métrique sleep_analysis : durée asleep
// directe, fallback inBed×0.92, et agrégats étendus (vo2 max du jour, pesée
// minimale du jour).
func TestParseAHAESleepAnalysis(t *testing.T) {
	raw := []byte(`{
	  "data": {
	    "metrics": [
	      {"name":"sleep_analysis","units":"hr","data":[
	        {"startDate":"2026-04-30 01:00:00 +0000","asleep":6.5},
	        {"startDate":"2026-04-30 14:00:00 +0000","asleep":0,"inBed":1.0}
	      ]},
	      {"name":"vo2_max","units":"ml/kg/min","data":[
	        {"date":"2026-04-30 08:00:00 +0000","qty":48.2},
	        {"date":"2026-04-30 09:00:00 +0000","qty":47.9}
	      ]},
	      {"name":"body_mass","units":"kg","data":[
	        {"date":"2026-04-30 07:00:00 +0000","qty":81.4},
	        {"date":"2026-04-30 21:00:00 +0000","qty":82.6}
	      ]}
	    ]
	  }
	}`)
	entries, err := parseAppleHealthAutoExport(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("attendu 1 jour, got %d", len(entries))
	}
	e := entries[0]
	// 6.5 h + sieste inBed 1.0 × 0.92 = 7.42 h
	if e.Sleep < 7.41 || e.Sleep > 7.43 {
		t.Errorf("Sleep=%v want ~7.42 (asleep + inBed×0.92)", e.Sleep)
	}
	if e.VO2Max != 48.2 {
		t.Errorf("VO2Max=%v want 48.2 (max du jour)", e.VO2Max)
	}
	if e.BodyMassKg != 81.4 {
		t.Errorf("BodyMassKg=%v want 81.4 (pesée min du jour)", e.BodyMassKg)
	}
}
