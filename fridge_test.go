package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// L'URL est fournie par l'utilisateur et APPELÉE par ce serveur : sans filtre,
// c'est une falsification de requête côté serveur. Le conteneur coach parle à
// MariaDB et aux API externes ; le laisser sonder le réseau depuis un champ de
// formulaire serait un pivot offert.
func TestURLFrigoRefuseLesCiblesInternes(t *testing.T) {
	refusees := []struct{ nom, url string }{
		{"http en clair", "http://fridge.jjoly.eu/api/coach/push/1/abc"},
		{"IP privée", "https://10.0.0.5/api/coach/push/1/abc"},
		{"boucle locale", "https://127.0.0.1/api/coach/push/1/abc"},
		{"IPv6", "https://[::1]/api/coach/push/1/abc"},
		{"métadonnées cloud", "https://169.254.169.254/api/coach/push/1/abc"},
		{"service kubernetes", "https://fridge-app.default/api/coach/push/1/abc"},
		{"kubernetes complet", "https://fridge.prod.svc.cluster.local/api/coach/push/1/abc"},
		{"nom .internal", "https://fridge.internal/api/coach/push/1/abc"},
		{"hôte sans point", "https://fridge/api/coach/push/1/abc"},
		{"TLD numérique", "https://fridge.123/api/coach/push/1/abc"},
		{"chemin étranger", "https://fridge.jjoly.eu/admin/delete-all"},
		{"schéma fichier", "file:///etc/passwd"},
		{"vide", ""},
	}
	for _, c := range refusees {
		t.Run(c.nom, func(t *testing.T) {
			if _, err := urlFrigoValide(c.url); err == nil {
				t.Errorf("acceptée à tort : %q", c.url)
			}
		})
	}
	if _, err := urlFrigoValide("https://fridge.jjoly.eu/api/coach/push/12/9f3a2b"); err != nil {
		t.Errorf("URL légitime refusée : %v", err)
	}
}

// transportVersFrigoFactice ne détourne que l'hôte du frigo. Réécrire aussi la
// cible d'une redirection la ferait reboucler jusqu'à la limite de Go, et le
// test de redirection serait vert sans que le refus y soit pour quoi que ce soit.
type transportVersFrigoFactice struct{ hote string }

func (tr transportVersFrigoFactice) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host != "fridge.jjoly.eu" {
		return http.DefaultTransport.RoundTrip(r)
	}
	c := r.Clone(r.Context())
	c.URL.Scheme = "http"
	c.URL.Host = tr.hote
	c.Host = ""
	return http.DefaultTransport.RoundTrip(c)
}

func detourner(t *testing.T, srv *httptest.Server) {
	t.Helper()
	hote := strings.TrimPrefix(srv.URL, "http://")
	prec := clientFridge.Transport
	clientFridge.Transport = transportVersFrigoFactice{hote: hote}
	t.Cleanup(func() { clientFridge.Transport = prec })
}

// Une redirection ne doit pas être suivie : valider l'URL saisie ne protège
// plus rien si le serveur distant peut nous rediriger ailleurs.
func TestFrigoRedirectionRefusee(t *testing.T) {
	var cible int
	srvCible := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cible++
		w.WriteHeader(http.StatusOK)
	}))
	defer srvCible.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srvCible.URL+"/vole", http.StatusFound)
	}))
	defer srv.Close()
	detourner(t, srv)

	err := envoyerAuFrigo("https://fridge.jjoly.eu/api/coach/push/1/secret",
		fridgePayload{Seances: []fridgeSeance{{ExternalID: "x", Day: "2026-08-01", Kind: "velo", DurationMin: 40}}})
	if err == nil {
		t.Fatal("la redirection a été suivie")
	}
	if cible != 0 {
		t.Errorf("la cible a été appelée %d fois — les données seraient parties "+
			"vers une adresse jamais validée", cible)
	}
}

// Le format émis doit être exactement celui que le frigo attend.
func TestFormatEnvoyeAuFrigo(t *testing.T) {
	var recu fridgePayload
	var contentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentType = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&recu)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	detourner(t, srv)

	p := fridgePayload{
		Seances: []fridgeSeance{{
			ExternalID: "strava-14892", Day: "2026-08-03", Kind: "velo",
			DurationMin: 52, Intensity: "soutenue", KcalEst: 480,
		}},
		Energie: []fridgeEnergie{{Day: "2026-08-03", KcalDepense: 780}},
	}
	if err := envoyerAuFrigo("https://fridge.jjoly.eu/api/coach/push/12/abc", p); err != nil {
		t.Fatalf("envoi : %v", err)
	}
	if contentType != "application/json" {
		t.Errorf("Content-Type = %q", contentType)
	}
	if len(recu.Seances) != 1 || recu.Seances[0].ExternalID != "strava-14892" {
		t.Errorf("séances mal transmises : %+v", recu.Seances)
	}
	if recu.Seances[0].DurationMin != 52 || recu.Seances[0].Kind != "velo" {
		t.Errorf("champs perdus : %+v", recu.Seances[0])
	}
	if len(recu.Energie) != 1 || recu.Energie[0].KcalDepense != 780 {
		t.Errorf("énergie mal transmise : %+v", recu.Energie)
	}
}

// Un lien mort (secret régénéré côté frigo) doit être distingué d'une panne :
// il ne redeviendra jamais valide de lui-même.
func TestLienMortDistingueDunePanne(t *testing.T) {
	for _, code := range []int{http.StatusUnauthorized, http.StatusNotFound} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
		}))
		err := envoyerAuFrigo("https://fridge.jjoly.eu/api/coach/push/1/x", fridgePayload{})
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), "régénère") {
			t.Errorf("code %d : message peu actionnable (%v)", code, err)
		}
	}
}

// Le vocabulaire Strava doit être traduit, et une valeur inconnue ne doit pas
// faire disparaître la séance : une séance mal étiquetée reste une séance.
func TestTraductionDesTypesStrava(t *testing.T) {
	cas := map[string]string{
		"Run": "course", "TrailRun": "course", "Ride": "velo",
		"VirtualRide": "velo", "Swim": "natation", "Walk": "marche",
		"Hike": "randonnee", "WeightTraining": "musculation", "Yoga": "yoga",
	}
	for strava, attendu := range cas {
		if got := typeStravaVersFrigo[strava]; got != attendu {
			t.Errorf("%s → %q, attendu %q", strava, got, attendu)
		}
	}
	if _, connu := typeStravaVersFrigo["Kitesurf"]; connu {
		t.Error("Kitesurf ne devrait pas être répertorié (il retombera sur « autre »)")
	}
}

// L'intensité vient de la fréquence cardiaque. Sans elle, on ne devine pas :
// une longue sortie tranquille et un fractionné court ont la même durée.
func TestIntensiteDepuisFC(t *testing.T) {
	if got := intensiteDepuisFC(0, 0); got != "moderee" {
		t.Errorf("sans FC : %q, attendu « moderee »", got)
	}
	if got := intensiteDepuisFC(170, 190); got != "soutenue" {
		t.Errorf("170/190 : %q, attendu « soutenue »", got)
	}
	if got := intensiteDepuisFC(110, 190); got != "legere" {
		t.Errorf("110/190 : %q, attendu « legere »", got)
	}
	if got := intensiteDepuisFC(140, 190); got != "moderee" {
		t.Errorf("140/190 : %q, attendu « moderee »", got)
	}
}

// L'apport alimentaire ne doit être retenu que s'il est déclaré réel. Un
// apport estimé serait indiscernable d'une mesure une fois écrit.
func TestApportRetenuSeulementSiReel(t *testing.T) {
	reel := PhysioEntry{Date: "2026-08-03", KcalIntake: 2100, ProteinG: 120, IntakeBasis: "reel"}
	estime := PhysioEntry{Date: "2026-08-03", KcalIntake: 2100, IntakeBasis: "prevu"}

	if reel.KcalIntake <= 0 || reel.IntakeBasis != "reel" {
		t.Fatal("cas de référence mal construit")
	}
	// La règle appliquée dans mergePhysioIntoData.
	retenu := func(e PhysioEntry) bool { return e.KcalIntake > 0 && e.IntakeBasis == "reel" }
	if !retenu(reel) {
		t.Error("un apport déclaré réel devrait être retenu")
	}
	if retenu(estime) {
		t.Error("un apport estimé ne doit pas être retenu")
	}
}
