package main

import "testing"

// TestStravaActivityToPhysio vérifie le mapping activité Strava → PhysioEntry :
// date tronquée au jour, AvgHR seulement si has_heartrate, énergie prioritaire
// calories puis kJ×0.239.
func TestStravaActivityToPhysio(t *testing.T) {
	// Activité avec calories (Strava Premium) + FC.
	a := &stravaActivity{
		StartDateLocal:   "2026-04-30T07:30:00Z",
		Type:             "Run",
		HasHeartrate:     true,
		AverageHeartrate: 152,
		Calories:         620,
		Kilojoules:       2000, // ignoré car Calories prioritaire
	}
	e := stravaActivityToPhysio(a)
	if e.Date != "2026-04-30" {
		t.Errorf("date=%q want 2026-04-30", e.Date)
	}
	if e.AvgHR != 152 {
		t.Errorf("AvgHR=%v want 152", e.AvgHR)
	}
	if e.ActiveEnergy != 620 {
		t.Errorf("ActiveEnergy=%v want 620 (calories prioritaires)", e.ActiveEnergy)
	}

	// Ride avec kJ seulement (pas de calories) → kJ × 0.239.
	b := &stravaActivity{
		StartDateLocal: "2026-05-01T18:00:00Z",
		Type:           "Ride",
		Kilojoules:     1000,
	}
	eb := stravaActivityToPhysio(b)
	want := 1000 * 0.239
	if eb.ActiveEnergy < want-0.01 || eb.ActiveEnergy > want+0.01 {
		t.Errorf("ActiveEnergy=%v want ~%v (kJ×0.239)", eb.ActiveEnergy, want)
	}

	// Sans FC → AvgHR doit rester 0 (pas de donnée inventée).
	c := &stravaActivity{StartDateLocal: "2026-05-02T08:00:00Z", HasHeartrate: false, AverageHeartrate: 140}
	ec := stravaActivityToPhysio(c)
	if ec.AvgHR != 0 {
		t.Errorf("AvgHR=%v want 0 quand has_heartrate=false", ec.AvgHR)
	}

	// Date trop courte → vide (ne crée pas une entrée non agrégeable).
	d := &stravaActivity{StartDateLocal: "bad"}
	if got := stravaActivityToPhysio(d); got.Date != "" {
		t.Errorf("date invalide devrait donner Date vide, got %q", got.Date)
	}
}
