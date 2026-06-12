# Propositions d'évolution — Coach Adaptatif

**Principe directeur :** chaque proposition respecte la philosophie du projet — un modèle scientifique validé, rendu invisible, avec un « pourquoi » sourcé, sans rien demander de plus à l'utilisateur. Aucune ne nécessite de dépendance externe ni ne compromet l'auto-hébergement. Chaque item indique où il se branche dans le code existant.

---

## A. Améliorer l'existant

### A1. TRIMP réel pour les activités externes (la donnée dort déjà sur disque)
Le correctif F1 a aligné les échelles de charge, mais le cardio reste estimé par sRPE déclaratif. Or `PhysioEntry.AvgHR` est **déjà ingéré** depuis Strava et Apple Health — et jamais consommé (« stockés pour usage futur »). Le TRIMP de Banister (1991) calcule la charge interne à partir de la FC réelle : `durée × ΔFC_ratio × e^(1.92·ΔFC_ratio)`. Quand `avgHR` existe pour le jour d'une séance externe, l'utiliser à la place du sRPE estimé ; sinon, fallback actuel. Zéro saisie en plus, charge cardio objective.
**Branchement :** `banister.js > sessionLoad()` — nécessite FCmax (estimable Tanaka 2001 : 208 − 0.7×âge, l'âge est dans le profil) et FC repos (déjà dans `body.physio.rhr`).

### A2. Tenir la promesse « Epley + Mayhew + Lombardi avec validation croisée »
La doc du projet l'annonce, le code n'implémente qu'Epley. Proposition : calculer les trois estimateurs par set, prendre leur médiane comme observation `y` du filtre de Kalman, et utiliser leur **dispersion comme bruit d'observation** — quand les trois formules divergent (reps élevées, RPE flou), `R` augmente naturellement au lieu des paliers actuels. Plus honnête statistiquement, et la doc redevient vraie.
**Branchement :** `bayesian.js > epleyAdjusted()` → `estimate1RM()` renvoyant `{y, R}` ; `observationVariance()` devient un plancher.

### A3. Calibration individuelle des constantes Banister (τ)
`TAU_FITNESS=42` / `TAU_FATIGUE=7` sont les valeurs population. Busso (1997) et Hellard (2006) montrent une forte variabilité interindividuelle. Dès ~12 semaines d'historique avec readiness, faire un grid-search léger (τ_fatigue ∈ [4..12], τ_fitness ∈ [30..60]) maximisant la corrélation TSB ↔ readiness observé. Invisible : l'utilisateur voit juste un TSB qui « colle » mieux à son ressenti, avec la mention « calibré sur tes N dernières semaines ».
**Branchement :** `banister.js` — nouvelle fonction `calibrateTaus(history, physio)`, résultat persisté dans `profile`.

### A4. Le drift Kalman pilote le macrocycle (les deux briques existent, pas le câblage)
`Bayesian.detectDrift()` détecte la régression silencieuse ; `Programming.adaptiveBlockOverride()` sait forcer un bloc. Mais rien ne les relie : un drift `strong` sur 2+ key lifts devrait **proposer automatiquement** un deload anticipé du bloc Issurin (avec le pourquoi : « pente −0.6 kg/sem sur développé couché et squat, significative à t=2.1 »). C'est exactement le « coach qui voit ce que tu ne vois pas » du pitch.
**Branchement :** `app.js` au calcul des ajustements — croiser `detectDrift` des `pickKeyLifts()` avec `adaptiveBlockOverride`.

### A5. Confirmation de saisie sur anomalie (detectAnomaly existe, l'UX non)
`detectAnomaly()` calcule le z-score d'un set fraîchement loggé mais rien n'est montré au moment de la saisie. Un set à z>3 est soit un PR exceptionnel, soit une coquille (155 kg au lieu de 55). Au log : « 155 kg, vraiment ? C'est +82 kg vs ta prédiction (68±4 kg)