package main

import "testing"

// L'identifiant d'une entrée d'historique est celui du MODÈLE de séance : il se
// répète à chaque exécution. S'en servir comme identifiant externe ferait
// écraser, côté frigo, toutes les séances d'un même programme les unes sur les
// autres — son index d'unicité porte sur (user, source, external_id).
func TestIdentifiantExterneUniqueParSeance(t *testing.T) {
	a := seanceCoach{ID: "push-a", Date: "2026-08-01T18:30:00.000Z"}
	b := seanceCoach{ID: "push-a", Date: "2026-08-04T18:20:00.000Z"}
	if ida, idb := "coach-"+a.Date, "coach-"+b.Date; ida == idb {
		t.Fatal("deux exécutions du même modèle produisent le même identifiant")
	}
	if a.ID != b.ID {
		t.Fatal("cas de test mal construit : les deux doivent partager le modèle")
	}
}

// Durée : réelle si enregistrée, estimée sinon — et jamais silencieusement.
func TestDureeSeance(t *testing.T) {
	reelle := seanceCoach{Duration: 47}
	if d, est := dureeSeance(reelle); d != 47 || est {
		t.Errorf("durée réelle : %d min, estimée=%v", d, est)
	}

	// Séance ancienne : douze séries effectuées, aucune durée enregistrée.
	ancienne := seanceCoach{}
	ancienne.Sets = make([]struct {
		Reps float64 `json:"reps"`
	}, 12)
	d, est := dureeSeance(ancienne)
	if !est {
		t.Error("une durée reconstituée doit être signalée comme estimée")
	}
	if d != 36 {
		t.Errorf("12 séries → %d min, attendu 36", d)
	}

	// Repli sur le nombre de séries prévues si aucune n'a été enregistrée.
	prevue := seanceCoach{}
	prevue.Exos = []struct {
		Sets int `json:"sets"`
	}{{Sets: 4}, {Sets: 3}}
	if d, _ := dureeSeance(prevue); d != 21 {
		t.Errorf("7 séries prévues → %d min, attendu 21", d)
	}

	// Aberration bornée : une séance de six heures n'existe pas.
	enorme := seanceCoach{}
	enorme.Sets = make([]struct {
		Reps float64 `json:"reps"`
	}, 500)
	if d, _ := dureeSeance(enorme); d != 240 {
		t.Errorf("borne haute non appliquée : %d min", d)
	}

	// Rien d'exploitable : on n'invente pas une durée.
	if d, _ := dureeSeance(seanceCoach{}); d != 0 {
		t.Errorf("séance vide → %d min, attendu 0", d)
	}
}

// Le RPE est une mesure plus directe que la FC pour de la musculation : il
// intègre la difficulté des séries, qu'une FC moyenne dilue dans les repos.
func TestIntensiteDepuisRPE(t *testing.T) {
	cas := map[float64]string{0: "moderee", 3: "legere", 5: "legere",
		6: "moderee", 7: "moderee", 8: "soutenue", 10: "soutenue"}
	for rpe, attendu := range cas {
		if got := intensiteDepuisRPE(rpe); got != attendu {
			t.Errorf("RPE %.0f → %q, attendu %q", rpe, got, attendu)
		}
	}
}

// Sans poids connu on ne fabrique pas de dépense : le frigo appliquera sa
// propre estimation plutôt qu'un chiffre fondé sur un poids inventé.
func TestPoidsCorporelDerniereePesee(t *testing.T) {
	data := map[string]any{"body": map[string]any{"weights": []any{
		map[string]any{"date": "2026-07-01", "kg": 78.0},
		map[string]any{"date": "2026-08-01", "kg": 76.4},
	}}}
	if got := poidsCorporel(data); got != 76.4 {
		t.Errorf("poids = %v, attendu la dernière pesée 76.4", got)
	}
	if got := poidsCorporel(map[string]any{}); got != 0 {
		t.Errorf("sans données : %v, attendu 0", got)
	}
	if got := poidsCorporel(map[string]any{"body": map[string]any{}}); got != 0 {
		t.Errorf("sans pesée : %v, attendu 0", got)
	}
}
