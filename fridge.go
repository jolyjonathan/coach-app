package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

/* ==========================================================================
 * Émission vers Frigo Adaptatif
 *
 * Coach connaît l'entraînement ; le frigo connaît le corps et l'assiette.
 * Le sens frigo → coach passe déjà par le webhook physio existant. Ce fichier
 * couvre le sens inverse : pousser les séances et la dépense vers le frigo,
 * pour qu'il dimensionne les portions sur l'activité réelle plutôt que sur un
 * coefficient figé.
 *
 * Protocole : voir SYNCHRO-COACH.md dans le dépôt fridge-app.
 * ========================================================================== */

const (
	fridgeTimeout      = 10 * time.Second
	fridgeMaxSeances   = 200
	fridgeFenetreJours = 30
)

// clientFridge refuse de suivre les redirections.
//
// L'URL est fournie par l'utilisateur et appelée par ce serveur : valider ce
// qu'il colle ne sert à rien si le serveur distant peut ensuite répondre
// « 302 vers http://169.254.169.254 » et nous y emmener. Le contrôle porterait
// alors sur une adresse que nous n'appelons pas.
var clientFridge = &http.Client{
	Timeout: fridgeTimeout,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return errors.New("redirection refusée")
	},
}

// suffixesInternesFridge : noms réservés ou d'usage interne. Les résoudre
// depuis le conteneur donnerait accès à des services qui n'ont pas à être
// atteignables depuis un champ de formulaire.
var suffixesInternesFridge = map[string]bool{
	"local": true, "internal": true, "localhost": true, "localdomain": true,
	"lan": true, "home": true, "intranet": true, "private": true, "corp": true,
	"svc": true, "cluster": true, "default": true, "namespace": true,
	"test": true, "example": true, "invalid": true, "onion": true,
}

// urlFrigoValide reproduit délibérément les règles appliquées côté frigo.
//
// Dupliquer plutôt que partager une bibliothèque : ce sont deux binaires
// déployés séparément, et une dépendance commune signifierait qu'une mise à
// jour de sécurité doit être livrée deux fois pour prendre effet. Ici chaque
// service se protège lui-même.
func urlFrigoValide(brut string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(brut))
	if err != nil {
		return nil, errors.New("URL illisible")
	}
	if u.Scheme != "https" {
		return nil, errors.New("l'URL doit être en https")
	}
	hote := strings.ToLower(u.Hostname())
	if hote == "" || !strings.Contains(hote, ".") {
		return nil, errors.New("hôte invalide")
	}
	if estAdresseIPFridge(hote) {
		return nil, errors.New("adresse IP refusée, utilise un nom de domaine")
	}
	dernier := hote[strings.LastIndex(hote, ".")+1:]
	if suffixesInternesFridge[dernier] {
		return nil, errors.New("ce domaine est interne au réseau")
	}
	if len(dernier) < 2 {
		return nil, errors.New("domaine de premier niveau invalide")
	}
	for _, c := range dernier {
		if c < 'a' || c > 'z' {
			return nil, errors.New("domaine de premier niveau invalide")
		}
	}
	if !strings.Contains(u.Path, "/api/coach/push/") {
		return nil, errors.New("cette URL ne ressemble pas à une URL de réception du frigo")
	}
	return u, nil
}

func estAdresseIPFridge(h string) bool {
	if strings.Contains(h, ":") {
		return true
	}
	for _, c := range h {
		if (c < '0' || c > '9') && c != '.' {
			return false
		}
	}
	return true
}

/* ---------------------------------------------------------------- payload */

type fridgeSeance struct {
	ExternalID  string `json:"external_id"`
	Day         string `json:"day"`
	Kind        string `json:"kind"`
	DurationMin int    `json:"duration_min"`
	Intensity   string `json:"intensity"`
	KcalEst     int    `json:"kcal_est"`
	Note        string `json:"note"`
}

type fridgeEnergie struct {
	Day         string  `json:"day"`
	KcalDepense int     `json:"kcal_depense"`
	Charge      float64 `json:"charge"`
}

type fridgePayload struct {
	Seances []fridgeSeance  `json:"seances"`
	Energie []fridgeEnergie `json:"energie"`
}

// typeStravaVersFrigo traduit le vocabulaire Strava vers celui du frigo.
// Une valeur inconnue devient « autre » plutôt que d'être écartée : une séance
// mal étiquetée reste une séance, et la perdre fausserait les totaux.
var typeStravaVersFrigo = map[string]string{
	"Run": "course", "TrailRun": "course", "VirtualRun": "course",
	"Ride": "velo", "VirtualRide": "velo", "GravelRide": "velo",
	"MountainBikeRide": "velo", "EBikeRide": "velo",
	"Swim":           "natation",
	"Walk":           "marche",
	"Hike":           "randonnee",
	"WeightTraining": "musculation", "Workout": "musculation",
	"Crossfit": "musculation",
	"Yoga":     "yoga",
	"Soccer":   "sport co", "Basketball": "sport co", "Tennis": "sport co",
	"Badminton": "sport co", "Squash": "sport co",
}

// intensiteDepuisFC déduit l'intensité de la fréquence cardiaque moyenne.
//
// Sans fréquence cardiaque on renvoie « moderee » : c'est le défaut du frigo,
// et inventer une intensité à partir de la seule durée n'aurait aucun sens —
// une longue sortie tranquille et un fractionné court donneraient le même
// verdict.
func intensiteDepuisFC(avgHR, maxHR float64) string {
	if avgHR <= 0 {
		return "moderee"
	}
	// Repère faute de mieux : 220 − âge n'est pas connu ici, on se cale sur la
	// FC max observée pendant la séance quand elle existe.
	ref := maxHR
	if ref <= 0 {
		ref = 185
	}
	ratio := avgHR / ref
	switch {
	case ratio >= 0.85:
		return "soutenue"
	case ratio <= 0.65:
		return "legere"
	default:
		return "moderee"
	}
}

// seanceCoach : forme d'une entrée de `history` dans le fichier de l'utilisateur
// (voir public/app.js, construction de `rec` à la fin d'une séance).
type seanceCoach struct {
	ID       string  `json:"id"`
	Date     string  `json:"date"` // ISO complet, pas seulement le jour
	Title    string  `json:"title"`
	RPE      float64 `json:"rpe"`
	Duration float64 `json:"durationMin"` // absent des séances antérieures à v0.2.4
	Exos     []struct {
		Sets int `json:"sets"`
	} `json:"exos"`
	Sets []struct {
		Reps float64 `json:"reps"`
	} `json:"sets"`
}

// dureeSeance : durée réelle si elle a été enregistrée, sinon une estimation.
//
// Les séances antérieures à v0.2.4 n'ont pas d'horodatage de début : rien dans
// le fichier ne permet de retrouver leur durée. Plutôt que de les écarter, on
// estime à trois minutes par série effectuée — travail plus repos, ordre de
// grandeur usuel en musculation. C'est grossier, et c'est pourquoi ces séances
// partent avec une note qui le dit : le frigo affichera une durée, autant
// qu'elle soit annoncée pour ce qu'elle vaut.
func dureeSeance(s seanceCoach) (minutes int, estimee bool) {
	if s.Duration > 0 {
		return int(s.Duration), false
	}
	n := len(s.Sets)
	if n == 0 {
		for _, e := range s.Exos {
			n += e.Sets
		}
	}
	if n == 0 {
		return 0, true
	}
	d := n * 3
	if d > 240 {
		d = 240 // au-delà, c'est une donnée aberrante, pas une séance
	}
	return d, true
}

// intensiteDepuisRPE : l'échelle de perception d'effort est une mesure plus
// directe que la fréquence cardiaque pour de la musculation — elle intègre la
// difficulté des séries, ce qu'une FC moyenne dilue entre les temps de repos.
func intensiteDepuisRPE(rpe float64) string {
	switch {
	case rpe <= 0:
		return "moderee" // non renseigné : on ne devine pas
	case rpe >= 8:
		return "soutenue"
	case rpe <= 5:
		return "legere"
	default:
		return "moderee"
	}
}

// poidsCorporel cherche la dernière pesée connue dans le fichier utilisateur.
// Sert à estimer la dépense ; sans elle on renvoie 0 et le frigo appliquera sa
// propre estimation plutôt qu'un chiffre fondé sur un poids inventé.
func poidsCorporel(data map[string]any) float64 {
	body, _ := data["body"].(map[string]any)
	if body == nil {
		return 0
	}
	arr, _ := body["weights"].([]any)
	dernier := 0.0
	for _, it := range arr {
		m, _ := it.(map[string]any)
		if m == nil {
			continue
		}
		if kg, ok := m["kg"].(float64); ok && kg > 0 {
			dernier = kg
		}
	}
	return dernier
}

// construireChargeFrigo assemble les séances enregistrées DANS coach, plus les
// activités Strava si elles sont disponibles.
//
// Les séances de coach sont la source principale : c'est le travail que
// l'utilisateur a réellement fait ici, avec son RPE. Strava n'est qu'un
// complément pour le cardio, et son absence n'est pas une erreur.
func construireChargeFrigo(uid string) (fridgePayload, error) {
	var out fridgePayload

	brut, err := loadWorkout(uid)
	if err != nil {
		return out, err
	}
	var data map[string]any
	if len(brut) > 0 {
		_ = json.Unmarshal(brut, &data)
	}
	var histoire []seanceCoach
	if data != nil {
		if h, err := json.Marshal(data["history"]); err == nil {
			_ = json.Unmarshal(h, &histoire)
		}
	}
	poids := poidsCorporel(data)
	limite := time.Now().AddDate(0, 0, -fridgeFenetreJours)
	parJour := map[string]float64{}

	for i := range histoire {
		h := histoire[i]
		if len(h.Date) < 10 {
			continue
		}
		jour := h.Date[:10]
		if d, err := time.Parse("2006-01-02", jour); err == nil && d.Before(limite) {
			continue
		}
		duree, estimee := dureeSeance(h)
		if duree <= 0 {
			continue
		}
		note := h.Title
		if estimee {
			note = strings.TrimSpace(h.Title + " (durée estimée)")
		}
		// Dépense : METs de la musculation (5,0, compendium d'Ainsworth)
		// pondérés par l'intensité perçue, appliqués au poids réel.
		kcal := 0
		if poids > 0 {
			met := 5.0
			switch intensiteDepuisRPE(h.RPE) {
			case "soutenue":
				met = 6.0
			case "legere":
				met = 3.5
			}
			kcal = int(met * poids * float64(duree) / 60)
		}
		out.Seances = append(out.Seances, fridgeSeance{
			// h.ID est l'identifiant du MODÈLE de séance : il se répète à
			// chaque exécution. L'utiliser tel quel écraserait toutes les
			// séances d'un même programme les unes sur les autres, côté frigo,
			// via son index d'unicité (user, source, external_id).
			// L'horodatage complet, lui, est unique par séance.
			ExternalID:  "coach-" + h.Date,
			Day:         jour,
			Kind:        "musculation",
			DurationMin: duree,
			Intensity:   intensiteDepuisRPE(h.RPE),
			KcalEst:     kcal,
			Note:        note,
		})
		parJour[jour] += float64(kcal)
		if len(out.Seances) >= fridgeMaxSeances {
			break
		}
	}

	// Strava en complément. Non connecté n'est PAS une erreur : la plupart des
	// utilisateurs de coach ne font que de la musculation.
	if acts, err := stravaFetchActivitesBrutes(uid, fridgeFenetreJours); err == nil {
		for i := range acts {
			a := &acts[i]
			if len(a.StartDateLocal) < 10 || a.MovingTime <= 0 {
				continue
			}
			if len(out.Seances) >= fridgeMaxSeances {
				break
			}
			jour := a.StartDateLocal[:10]
			kind, ok := typeStravaVersFrigo[a.Type]
			if !ok {
				kind = "autre"
			}
			kcal := 0
			switch {
			case a.Calories > 0:
				kcal = int(a.Calories)
			case a.Kilojoules > 0:
				kcal = int(a.Kilojoules * 0.239)
			}
			out.Seances = append(out.Seances, fridgeSeance{
				ExternalID:  fmt.Sprintf("strava-%d", a.ID),
				Day:         jour,
				Kind:        kind,
				DurationMin: a.MovingTime / 60,
				Intensity:   intensiteDepuisFC(a.AverageHeartrate, a.MaxHeartrate),
				KcalEst:     kcal,
			})
			parJour[jour] += float64(kcal)
		}
	}

	jours := make([]string, 0, len(parJour))
	for j := range parJour {
		jours = append(jours, j)
	}
	sort.Strings(jours)
	for _, j := range jours {
		if parJour[j] <= 0 {
			continue // pas de dépense estimable : on ne transmet pas un zéro
		}
		// `charge` reste à 0 : la charge type Banister est calculée CÔTÉ CLIENT
		// à partir de body.physio. Ce serveur ne la connaît pas, et une valeur
		// inventée serait pire qu'une absence.
		out.Energie = append(out.Energie, fridgeEnergie{Day: j, KcalDepense: int(parJour[j])})
	}
	return out, nil
}

// envoyerAuFrigo poste la charge. Renvoie une erreur explicite : elle est
// remontée telle quelle à l'utilisateur, une synchro qui échoue en silence
// entretient la croyance que les données arrivent.
// sansSecretFrigo : même problème, même remède que côté frigo.
//
// Go inclut l'URL appelée dans ses erreurs réseau, et cette URL porte le
// secret de réception du frigo. Sans nettoyage, il apparaît dans le message
// remonté à l'utilisateur — donc dans la première capture d'écran envoyée
// pour demander de l'aide.
func sansSecretFrigo(msg, pushURL string) string {
	if pushURL == "" {
		return msg
	}
	remplacement := "l'URL du frigo"
	if u, err := url.Parse(pushURL); err == nil && u.Host != "" {
		remplacement = "https://" + u.Host + "/…"
	}
	return strings.ReplaceAll(msg, pushURL, remplacement)
}

func envoyerAuFrigo(pushURL string, p fridgePayload) error {
	// Revalidation à l'envoi, pas seulement à la saisie : le fichier
	// utilisateurs peut être restauré ou édité à la main.
	if _, err := urlFrigoValide(pushURL); err != nil {
		return err
	}
	corps, err := json.Marshal(p)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, pushURL, strings.NewReader(string(corps)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "coach-adaptatif/1.0")
	resp, err := clientFridge.Do(req)
	if err != nil {
		return errors.New(sansSecretFrigo(err.Error(), pushURL))
	}
	defer resp.Body.Close()
	rep, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusNotFound {
		return errors.New("lien refusé par le frigo — régénère l'URL de réception depuis son onglet Santé")
	}
	return fmt.Errorf("le frigo a répondu %s : %s", resp.Status, strings.TrimSpace(string(rep)))
}

/* --------------------------------------------------------------- handlers */

// GET /api/physio/integrations/fridge
func handleFridgeStatus(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	usersMu.RLock()
	var brut string
	if u := usersByID[uid]; u != nil {
		brut = u.FridgePushURL
	}
	usersMu.RUnlock()
	hote := ""
	if u, err := url.Parse(brut); err == nil {
		hote = u.Hostname()
	}
	// Seul l'hôte sort : l'URL complète contient un secret.
	writeJSON(w, http.StatusOK, map[string]any{
		"configure": brut != "",
		"hote":      hote,
	})
}

// POST /api/physio/integrations/fridge  { "url": "https://fridge…/api/coach/push/12/…" }
func handleFridgeSet(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	var in struct {
		URL string `json:"url"`
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 8<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "requête invalide")
		return
	}
	if _, err := urlFrigoValide(in.URL); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	physioMu.Lock()
	usersMu.Lock()
	if u := usersByID[uid]; u != nil {
		u.FridgePushURL = strings.TrimSpace(in.URL)
	}
	usersMu.Unlock()
	physioMu.Unlock()
	saveUsers()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// DELETE /api/physio/integrations/fridge
func handleFridgeRemove(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	physioMu.Lock()
	usersMu.Lock()
	if u := usersByID[uid]; u != nil {
		u.FridgePushURL = ""
	}
	usersMu.Unlock()
	physioMu.Unlock()
	saveUsers()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /api/physio/integrations/fridge/sync
func handleFridgeSync(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	usersMu.RLock()
	var pushURL string
	if u := usersByID[uid]; u != nil {
		pushURL = u.FridgePushURL
	}
	usersMu.RUnlock()
	if pushURL == "" {
		writeErr(w, http.StatusBadRequest, "aucune URL de frigo configurée")
		return
	}
	p, err := construireChargeFrigo(uid)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "lecture des activités impossible : "+err.Error())
		return
	}
	if len(p.Seances) == 0 && len(p.Energie) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"envoye": false,
			"raison": "aucune séance terminée sur les " +
				strconv.Itoa(fridgeFenetreJours) + " derniers jours"})
		return
	}
	if err := envoyerAuFrigo(pushURL, p); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	physioMu.Lock()
	usersMu.Lock()
	if u := usersByID[uid]; u != nil {
		if u.PhysioLastSync == nil {
			u.PhysioLastSync = map[string]time.Time{}
		}
		u.PhysioLastSync["fridge"] = time.Now()
	}
	usersMu.Unlock()
	physioMu.Unlock()
	saveUsers()
	writeJSON(w, http.StatusOK, map[string]any{
		"envoye": true, "seances": len(p.Seances), "jours_energie": len(p.Energie),
	})
}
