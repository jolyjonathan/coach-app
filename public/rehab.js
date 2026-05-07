/* =============================================================
 * Coach Adaptatif — Module rééducation
 * =============================================================
 *
 * Ce module fournit :
 *   - Une bibliothèque de 36 exercices de rééducation, taggés par
 *     zone (9 zones du corps) et par phase (aiguë / sub-aiguë / retour).
 *   - Le calcul automatique de la phase à partir de la date de blessure.
 *   - Un générateur de séance rééduc qui remplace la séance normale.
 *   - Les textes du disclaimer médical (versionné).
 *
 * IMPORTANT — disclaimer médical :
 *   Aucun de ces exercices ne constitue un avis médical. Ils sont
 *   conçus comme guides généraux et doivent être validés ou ajustés
 *   par un kinésithérapeute / médecin avant utilisation. L'app refuse
 *   d'activer le mode rééduc tant que l'utilisateur n'a pas accepté
 *   le disclaimer (case à cocher obligatoire).
 *
 * Modèle :
 *   window.Rehab = {
 *     ZONES, exercises, computePhase, generateSession, DISCLAIMER, ...
 *   }
 *
 * Chargé AVANT app.js dans index.html pour que app.js puisse l'utiliser.
 * ============================================================= */
(function () {
  'use strict';

  // Version du disclaimer médical. Bumper si on modifie les avertissements
  // de manière substantielle — l'app demandera alors une nouvelle
  // acceptation à l'utilisateur.
  const DISCLAIMER_VERSION = '1.0';

  // Texte du disclaimer médical. Affiché en modale au moment d'activer
  // le mode rééduc, avec case à cocher obligatoire.
  const DISCLAIMER_HTML = `
    <p style="margin-top:0"><strong>Le mode rééducation n'est PAS un avis médical.</strong></p>
    <p>Ces exercices sont des suggestions générales basées sur des protocoles courants
       de retour à l'activité après blessure musculo-squelettique. <strong>Avant de les utiliser,
       tu dois&nbsp;:</strong></p>
    <ul style="margin:6px 0 12px;padding-left:22px">
      <li>Avoir consulté un professionnel de santé (kinésithérapeute, médecin du sport, ostéopathe).</li>
      <li>Avoir un diagnostic clair sur la blessure et les contre-indications.</li>
      <li>Respecter le rythme indiqué par ton kiné si tu en suis un — l'app ne le remplace pas.</li>
    </ul>
    <p><strong>Règle d'or&nbsp;:</strong> si un exercice provoque une douleur (pas un simple
       inconfort), tu arrêtes immédiatement. Une douleur qui dure ou s'aggrave au fil
       des séances doit déclencher une nouvelle consultation, pas une continuation.</p>
    <p><strong>Cas où tu ne dois PAS utiliser ce mode&nbsp;:</strong> fracture en cours
       de consolidation non avalisée, post-opératoire récent sans feu vert chirurgien,
       douleur thoracique, déficit neurologique (perte de force ou de sensibilité),
       gonflement ou rougeur évoquant une infection.</p>
    <p style="font-size:13px;color:var(--mut);margin-bottom:0">
       En cas de doute&nbsp;: stop, et consulte. Coach Adaptatif décline toute
       responsabilité pour un usage en dehors de ces conditions.</p>
  `;

  // Définition des 9 zones couvertes. `label` = libellé UI, `desc` = aide
  // courte affichée dans la sélection de zones.
  const ZONES = [
    { id: 'epaule',     label: 'Épaule',          desc: 'Coiffe des rotateurs, deltoïdes, gléno-humérale' },
    { id: 'dos',        label: 'Dos / lombaires', desc: 'Lombalgies, sciatique, paravertébraux' },
    { id: 'genou',      label: 'Genou',           desc: 'Ligaments, ménisque, syndrome rotulien, tendinopathie' },
    { id: 'coude',      label: 'Coude',           desc: 'Épicondylite, épitrochléite, tendinopathies' },
    { id: 'poignet',    label: 'Poignet / main',  desc: 'Tendinites, entorses, syndrome canal carpien' },
    { id: 'cheville',   label: 'Cheville',        desc: 'Entorses, tendon d\'Achille, instabilité' },
    { id: 'hanche',     label: 'Hanche',          desc: 'Bursite, tendinopathies, conflit fémoro-acétabulaire' },
    { id: 'cervicales', label: 'Cervicales',      desc: 'Tensions, torticolis, cervicalgies' },
    { id: 'pectoral',   label: 'Pectoral',        desc: 'Élongations, contractures, post-immobilisation' },
  ];

  // Phases :
  //   aigue    — semaines 1-2 : repos relatif, mobilité passive douce.
  //   subaigue — semaines 3-6 : isométriques, mobilité active, banding léger.
  //   retour   — semaine 7+   : reprise progressive de charge, propriocep.
  const PHASES = [
    { id: 'aigue',    label: 'Aiguë',     range: 'sem. 1-2',
      summary: 'Repos relatif. Mobilité passive douce sans douleur. Aucune charge.' },
    { id: 'subaigue', label: 'Sub-aiguë', range: 'sem. 3-6',
      summary: 'Isométriques (contractions sans mouvement). Mobilité active dans amplitude indolore. Banding très léger.' },
    { id: 'retour',   label: 'Retour',    range: 'sem. 7 +',
      summary: 'Reprise progressive de charge. Stabilité, proprioception. Préparation au retour à l\'entraînement normal.' },
  ];

  // Bibliothèque d'exercices rééduc. Champs :
  //   id        — identifiant kebab-case unique (préfixé par zone).
  //   n         — nom affiché.
  //   zone      — id zone (correspondance avec ZONES.id).
  //   phases    — phases où cet exo est approprié.
  //   kind      — type pédagogique (mobilite, isometrique, banding,
  //               leger, proprioception, etirement).
  //   dose      — dosage par défaut (texte humain).
  //   gear      — matériel requis ('aucun' / 'elastiques' / 'mur' / etc.).
  //   how       — exécution.
  //   cues      — points-clés.
  //   caution   — signal d'arrêt — si X se produit, stop.
  const EXERCISES = [
    // ========== ÉPAULE ==========
    {
      id: 'reh-epaule-pendulaire', n: 'Pendulaire de Codman', zone: 'epaule',
      phases: ['aigue', 'subaigue'], kind: 'mobilite',
      dose: '3 × 30s — 2 sens (avant/arrière, latéral, circulaire)', gear: 'aucun',
      how: 'Buste penché en avant à 90°, bras du côté blessé pendant librement vers le sol. Laisse le bras se balancer comme un pendule, sans contraction active de l\'épaule. Démarre par petits mouvements et augmente l\'amplitude doucement.',
      cues: ['Le poids du bras fait le travail, l\'épaule ne tire pas.', 'Reste détendu — si tu serres l\'épaule, tu rates l\'effet.', 'Appuie ton autre main sur une table pour stabiliser le buste.'],
      caution: 'Stop si douleur vive ou irradiation dans le bras.',
    },
    {
      id: 'reh-epaule-isom-rot-ext', n: 'Isométrique rotateurs externes', zone: 'epaule',
      phases: ['aigue', 'subaigue'], kind: 'isometrique',
      dose: '3 × 5 tenues de 6s', gear: 'mur',
      how: 'Coude collé au corps fléchi à 90°, dos de la main contre un mur. Pousse doucement le dos de la main contre le mur (= rotation externe) sans bouger. Tiens 6 secondes, relâche.',
      cues: ['Intensité 30-40% du max — pas de tremblement.', 'Garde le coude collé au flanc.', 'Respire normalement pendant la tenue.'],
      caution: 'Stop si la douleur augmente pendant la tenue.',
    },
    {
      id: 'reh-epaule-rot-ext-elast', n: 'Rotation externe à l\'élastique', zone: 'epaule',
      phases: ['subaigue', 'retour'], kind: 'banding',
      dose: '3 × 12 reps lentes', gear: 'elastiques',
      how: 'Élastique fixé à hauteur du coude, à droite si tu travailles le bras gauche (ou inverse). Coude collé au flanc, fléchi à 90°. Tire l\'élastique vers l\'extérieur en gardant le coude au corps. 2s pour aller, 2s pour revenir.',
      cues: ['Coude reste collé — si tu décolles, tu triches avec le deltoïde.', 'Élastique léger — c\'est la coiffe qui travaille, pas le grand pec.', 'Mouvement contrôlé tout du long.'],
      caution: 'Si pincement antérieur de l\'épaule, baisse la résistance ou arrête.',
    },
    {
      id: 'reh-epaule-yty', n: 'Y-T-W au sol', zone: 'epaule',
      phases: ['subaigue', 'retour'], kind: 'leger',
      dose: '2 × 10 reps de chaque (Y, T, W)', gear: 'aucun',
      how: 'Allongé sur le ventre, front au sol. Y = bras tendus formant un Y, soulève à quelques cm. T = bras à 90° formant un T. W = coudes pliés près du corps, comme un W. Maintiens chaque position 2s.',
      cues: ['Pouces vers le plafond pour orienter les rotateurs.', 'Soulève PEU — quelques cm suffisent.', 'Serre les omoplates avant le bras.'],
      caution: 'Stop si douleur cervicale ou lombaire.',
    },

    // ========== DOS / LOMBAIRES ==========
    {
      id: 'reh-dos-bascule-bassin', n: 'Bascule de bassin', zone: 'dos',
      phases: ['aigue', 'subaigue'], kind: 'mobilite',
      dose: '3 × 12 reps', gear: 'aucun',
      how: 'Allongé sur le dos, genoux pliés, pieds à plat. Plaque le bas du dos contre le sol en contractant les abdos et en basculant le bassin. Tiens 3s, relâche.',
      cues: ['Mouvement subtil — c\'est la pression lombaire qui change, pas un grand geste.', 'Inspire en relâchant, expire en plaquant.', 'Pas de rétention de souffle.'],
      caution: 'Stop si douleur qui descend dans la jambe.',
    },
    {
      id: 'reh-dos-cat-camel', n: 'Chat-vache', zone: 'dos',
      phases: ['aigue', 'subaigue', 'retour'], kind: 'mobilite',
      dose: '2 × 10 cycles lents', gear: 'aucun',
      how: 'À quatre pattes, mains sous épaules, genoux sous hanches. Inspire en creusant le dos (regard vers le haut). Expire en arrondissant le dos (regard vers le nombril). Mouvement fluide et lent.',
      cues: ['Mobilise toute la colonne vertèbre par vertèbre.', 'Synchronise avec le souffle — un cycle = une inspiration + une expiration.', 'Pas d\'amplitude max si ça tire — reste dans la zone confort.'],
      caution: 'Si douleur lombaire en extension (vache), réduis l\'amplitude.',
    },
    {
      id: 'reh-dos-bird-dog', n: 'Bird-dog', zone: 'dos',
      phases: ['subaigue', 'retour'], kind: 'leger',
      dose: '3 × 8 par côté, tenues de 3s', gear: 'aucun',
      how: 'À quatre pattes, dos neutre. Tends simultanément le bras droit devant et la jambe gauche derrière, jusqu\'à former une ligne. Tiens 3s. Reviens, change de côté.',
      cues: ['Bassin reste face au sol — pas de bascule.', 'Dos neutre tout le mouvement — visualise un verre d\'eau posé sur les lombaires.', 'Si ton dos tangue, baisse l\'amplitude.'],
      caution: 'Stop si compensation par cambrure lombaire excessive.',
    },
    {
      id: 'reh-dos-mckenzie', n: 'Extension McKenzie au sol', zone: 'dos',
      phases: ['subaigue', 'retour'], kind: 'mobilite',
      dose: '2 × 10 répétitions douces', gear: 'aucun',
      how: 'Allongé sur le ventre, mains sous les épaules. Pousse doucement sur les bras pour soulever le buste, hanches restant au sol. Monte uniquement jusqu\'au confort. Redescends.',
      cues: ['Bassin et hanches collés au sol.', 'Va seulement où ça reste indolore.', 'Souffle en montant.'],
      caution: 'Si la douleur descend dans la jambe pendant l\'extension, arrête immédiatement.',
    },

    // ========== GENOU ==========
    {
      id: 'reh-genou-isom-quad', n: 'Quadriceps isométrique (jambe tendue)', zone: 'genou',
      phases: ['aigue', 'subaigue'], kind: 'isometrique',
      dose: '3 × 8 tenues de 6s', gear: 'aucun',
      how: 'Assis ou allongé, jambe tendue. Contracte fortement le quadriceps (cuisse) pour écraser le genou contre le sol. Tiens 6s, relâche 4s.',
      cues: ['Contracte fort sans bouger le genou.', 'Le pied du côté travaillé peut être en flexion dorsale (orteils vers toi).', 'Si crampe, raccourcis la tenue à 4s.'],
      caution: 'Stop si gonflement après la séance.',
    },
    {
      id: 'reh-genou-leg-raise', n: 'Élévation jambe tendue', zone: 'genou',
      phases: ['subaigue', 'retour'], kind: 'leger',
      dose: '3 × 12 par jambe', gear: 'aucun',
      how: 'Allongé sur le dos, une jambe pliée pied au sol, l\'autre tendue. Contracte le quadriceps puis soulève la jambe tendue à hauteur du genou opposé. Descends contrôlé.',
      cues: ['Genou reste tendu — pas de flexion pendant la montée.', 'Lentement, 2s pour monter, 2s pour descendre.', 'Bas du dos plaqué au sol.'],
      caution: 'Stop si douleur antérieure du genou en montée.',
    },
    {
      id: 'reh-genou-mini-squat', n: 'Mini-squat assisté', zone: 'genou',
      phases: ['subaigue', 'retour'], kind: 'leger',
      dose: '3 × 12 reps', gear: 'aucun',
      how: 'Debout, mains sur un mur ou un dossier de chaise. Plie les genoux pour descendre de 30-45° max — pas plus. Garde le poids sur les talons. Remonte.',
      cues: ['Descente petite et contrôlée — c\'est la qualité qui compte.', 'Genoux dans l\'axe des pieds, pas de valgus (genoux qui rentrent).', 'Si le genou claque ou fait mal, réduis l\'amplitude.'],
      caution: 'Stop si douleur antérieure ou rétro-rotulienne.',
    },
    {
      id: 'reh-genou-step-up-bas', n: 'Step-up bas', zone: 'genou',
      phases: ['retour'], kind: 'proprioception',
      dose: '3 × 10 par jambe', gear: 'aucun',
      how: 'Devant une marche basse (10-15 cm). Pose le pied du côté à rééduquer sur la marche, monte en transférant tout le poids sur cette jambe. Descends contrôlé sur l\'autre pied.',
      cues: ['Tout le travail vient de la jambe qui monte — l\'autre pied effleure juste.', 'Pas de poussée du pied au sol pour s\'aider.', 'Genou aligné sur la pointe du pied.'],
      caution: 'Si la marche est trop haute, prends plus bas. Pas de douleur pendant la descente excentrique.',
    },

    // ========== COUDE ==========
    {
      id: 'reh-coude-isom-flex', n: 'Coude isométrique flexion', zone: 'coude',
      phases: ['aigue', 'subaigue'], kind: 'isometrique',
      dose: '3 × 6 tenues de 6s', gear: 'aucun',
      how: 'Coude fléchi à 90°, bras le long du corps. Avec l\'autre main, pousse vers le bas sur ton avant-bras pendant que tu résistes (= contraction biceps sans mouvement).',
      cues: ['Force modérée — pas de tremblement.', 'Le coude reste exactement à 90° sans bouger.', 'Respire normalement.'],
      caution: 'Stop si douleur électrique vers la main.',
    },
    {
      id: 'reh-coude-pronosup', n: 'Prono-supination', zone: 'coude',
      phases: ['aigue', 'subaigue', 'retour'], kind: 'mobilite',
      dose: '3 × 15 cycles lents', gear: 'aucun',
      how: 'Coude collé au flanc, fléchi à 90°, paume vers le haut. Tourne lentement la main pour mettre la paume vers le bas (pronation), puis reviens (supination).',
      cues: ['Coude reste fixé contre le flanc — c\'est l\'avant-bras qui tourne.', 'Mouvement lent, 2s dans chaque sens.', 'Détend l\'épaule.'],
      caution: 'Stop si douleur vive en fin d\'amplitude.',
    },
    {
      id: 'reh-coude-banding-ext', n: 'Extension à l\'élastique', zone: 'coude',
      phases: ['subaigue', 'retour'], kind: 'banding',
      dose: '3 × 12 reps lentes', gear: 'elastiques',
      how: 'Élastique tenu sous le pied, autre main qui tient l\'élastique au-dessus de la tête. Coude collé à l\'oreille, déplie le bras vers le haut (= extension du triceps). Redescends contrôlé.',
      cues: ['Coude reste pointé vers le plafond.', 'Élastique léger — sensation de travail, pas de douleur.', 'Lent, 2s pour monter, 3s pour redescendre.'],
      caution: 'Si le coude fait mal en extension complète, ne va pas jusqu\'au verrouillage.',
    },
    {
      id: 'reh-coude-curl-leger', n: 'Curl haltère léger', zone: 'coude',
      phases: ['retour'], kind: 'leger',
      dose: '3 × 12 par bras (1-3 kg max)', gear: 'aucun',
      how: 'Haltère léger (ou bouteille d\'eau), bras le long du corps. Plie le coude pour amener la charge vers l\'épaule. Redescends lentement (3s).',
      cues: ['Charge vraiment légère — c\'est de la rééduc, pas du muscu.', 'Coude collé au flanc, pas de balancier.', 'Descente plus lente que la montée (excentrique).'],
      caution: 'Stop dès la moindre douleur — la dose est sub-thérapeutique en force.',
    },

    // ========== POIGNET / MAIN ==========
    {
      id: 'reh-poignet-mobilite', n: 'Mobilité poignet (8 directions)', zone: 'poignet',
      phases: ['aigue', 'subaigue', 'retour'], kind: 'mobilite',
      dose: '2 × 10 cycles lents', gear: 'aucun',
      how: 'Bras tendu devant, paume face au sol. Mobilise le poignet : flexion (paume vers toi), extension (paume opposée), inclinaisons radiale et cubitale, puis circonduction. Lentement, sans à-coups.',
      cues: ['Amplitude jusqu\'à la zone confort uniquement.', 'L\'avant-bras reste fixe — c\'est le poignet qui bouge.', 'Pause 1s en fin d\'amplitude.'],
      caution: 'Stop si crépitement douloureux ou paresthésie (fourmillements).',
    },
    {
      id: 'reh-poignet-isom', n: 'Poignet isométrique multi-directions', zone: 'poignet',
      phases: ['aigue', 'subaigue'], kind: 'isometrique',
      dose: '3 × 4 directions × 6s', gear: 'aucun',
      how: 'Bras tendu paume vers le bas. Avec l\'autre main, pousse sur le dos de la main et résiste sans bouger. Répète : pousser vers le haut, vers le bas, sur le côté pouce, sur le côté auriculaire.',
      cues: ['Force légère à modérée.', 'Aucun mouvement — c\'est isométrique.', 'Pause 6s entre chaque direction.'],
      caution: 'Stop si douleur en fin de tenue.',
    },
    {
      id: 'reh-poignet-grip-balle', n: 'Grip balle anti-stress', zone: 'poignet',
      phases: ['subaigue', 'retour'], kind: 'leger',
      dose: '3 × 15 serres (3s tenue)', gear: 'aucun',
      how: 'Balle anti-stress (ou éponge) dans la main. Serre fort 3s, relâche 2s. Si pas de balle, serre le poing.',
      cues: ['Serre progressivement, pas brutalement.', 'Tenue stable, pas de tremblement.', 'Garde le poignet en position neutre, pas plié.'],
      caution: 'Si tendinite récente, attends quelques jours avant de serrer fort.',
    },
    {
      id: 'reh-poignet-flex-ext-leger', n: 'Flexion-extension chargée légère', zone: 'poignet',
      phases: ['retour'], kind: 'leger',
      dose: '3 × 15 par sens (0,5-2 kg)', gear: 'aucun',
      how: 'Avant-bras posé sur table, main qui dépasse. Petit haltère ou bouteille d\'eau. Fais des flexions (paume vers le haut → soulever la charge) puis sur l\'autre face en extensions. Lentement.',
      cues: ['Charge minimale.', 'Avant-bras reste plaqué sur la table.', 'Amplitude confortable, pas la max.'],
      caution: 'Si douleur, divise la charge par 2. Sinon arrête.',
    },

    // ========== CHEVILLE ==========
    {
      id: 'reh-cheville-pompage', n: 'Pompage cheville', zone: 'cheville',
      phases: ['aigue', 'subaigue'], kind: 'mobilite',
      dose: '3 × 20 reps', gear: 'aucun',
      how: 'Assis ou allongé, jambe tendue. Pointe le pied (orteils loin) puis ramène le pied vers toi (orteils vers le tibia). Mouvement lent, à fond dans chaque sens.',
      cues: ['Lent — 1s pour pointer, 1s pour ramener.', 'Amplitude max sans douleur.', 'Le mollet doit travailler en pointage.'],
      caution: 'Stop si crampe ou douleur derrière le mollet.',
    },
    {
      id: 'reh-cheville-abc', n: 'Alphabet cheville', zone: 'cheville',
      phases: ['subaigue', 'retour'], kind: 'mobilite',
      dose: '2 × alphabet complet (A à Z)', gear: 'aucun',
      how: 'Assis, jambe tendue, pied en l\'air. Dessine l\'alphabet en majuscules avec le gros orteil, en mobilisant uniquement la cheville (genou immobile).',
      cues: ['Le genou reste fixe — c\'est la cheville qui bouge.', 'Lettres lentes et bien formées.', 'Pause 5s entre chaque mot de 5 lettres.'],
      caution: 'Stop si douleur sur l\'extérieur de la cheville (ligaments).',
    },
    {
      id: 'reh-cheville-mollet-banding', n: 'Mollet à l\'élastique', zone: 'cheville',
      phases: ['subaigue', 'retour'], kind: 'banding',
      dose: '3 × 15 reps', gear: 'elastiques',
      how: 'Assis, jambe tendue. Élastique passé sous l\'avant-pied, tenu à deux mains avec un peu de tension. Pointe le pied contre la résistance (extension). Redescends lentement.',
      cues: ['2s pour pointer, 3s pour revenir.', 'Le pied va à fond en pointage si possible.', 'Genou tendu pendant tout le mouvement.'],
      caution: 'Stop si crampe ou douleur du tendon d\'Achille.',
    },
    {
      id: 'reh-cheville-equilibre-1pied', n: 'Équilibre unipodal', zone: 'cheville',
      phases: ['retour'], kind: 'proprioception',
      dose: '3 × 30s par pied (yeux ouverts puis fermés)', gear: 'aucun',
      how: 'Tiens-toi sur un pied, l\'autre genou plié à 90°. Reste stable le plus longtemps possible. Progression : yeux ouverts → yeux fermés.',
      cues: ['Près d\'un mur si tu sens que tu vacilles.', 'Légère flexion du genou d\'appui — pas verrouillé.', 'Regard fixé devant si yeux ouverts.'],
      caution: 'Pas de yeux fermés si entorse récente non stabilisée.',
    },

    // ========== HANCHE ==========
    {
      id: 'reh-hanche-clamshell', n: 'Clamshell (coquillage)', zone: 'hanche',
      phases: ['aigue', 'subaigue', 'retour'], kind: 'leger',
      dose: '3 × 15 par côté', gear: 'aucun',
      how: 'Allongé sur le côté, hanches et genoux fléchis à 45°, pieds joints. Soulève le genou du dessus en gardant les pieds collés (= rotation externe de hanche). Redescends contrôlé.',
      cues: ['Bassin reste fixe — pas de bascule arrière.', 'Pieds restent collés tout du long.', 'Fessier moyen sent le travail.'],
      caution: 'Si douleur latérale de hanche persistante, espacer les séances.',
    },
    {
      id: 'reh-hanche-pont', n: 'Pont fessier léger', zone: 'hanche',
      phases: ['subaigue', 'retour'], kind: 'leger',
      dose: '3 × 12 reps avec tenue 2s en haut', gear: 'aucun',
      how: 'Allongé sur le dos, genoux pliés, pieds à plat. Pousse dans les talons pour soulever les hanches jusqu\'à aligner genou-hanche-épaule. Tiens 2s en haut, redescends.',
      cues: ['Contracte les fessiers en haut — pas les lombaires.', 'Pieds bien à plat, largeur hanches.', 'Menton rentré.'],
      caution: 'Stop si crampe aux ischios ou douleur lombaire.',
    },
    {
      id: 'reh-hanche-9090', n: 'Mobilité 90/90', zone: 'hanche',
      phases: ['subaigue', 'retour'], kind: 'mobilite',
      dose: '3 × 8 transitions par côté', gear: 'aucun',
      how: 'Assis au sol, jambe avant à 90° devant toi (tibia parallèle au corps), jambe arrière à 90° latéralement. Bascule lentement le buste de l\'autre côté pour passer en position miroir. Lent.',
      cues: ['Buste droit pendant la bascule.', 'Mains au sol pour aider si besoin.', 'Amplitude jusqu\'à la zone confort, pas plus.'],
      caution: 'Si douleur antérieure de hanche, raccourcis l\'amplitude.',
    },
    {
      id: 'reh-hanche-banding-abd', n: 'Abduction debout à l\'élastique', zone: 'hanche',
      phases: ['retour'], kind: 'banding',
      dose: '3 × 15 par jambe', gear: 'elastiques',
      how: 'Élastique noué autour des chevilles. Debout, mains sur un mur. Décale lentement une jambe sur le côté contre la résistance, puis reviens contrôlé.',
      cues: ['Bassin neutre — pas de bascule pour aider.', 'Jambe d\'appui légèrement fléchie.', 'Amplitude de 30° max — c\'est suffisant.'],
      caution: 'Stop si compensation lombaire ou douleur de hanche.',
    },

    // ========== CERVICALES ==========
    {
      id: 'reh-cervicales-chin-tuck', n: 'Chin tuck (rentré de menton)', zone: 'cervicales',
      phases: ['aigue', 'subaigue', 'retour'], kind: 'isometrique',
      dose: '3 × 10 tenues de 5s', gear: 'aucun',
      how: 'Assis ou debout, regard à l\'horizon. Rentre le menton vers la gorge sans baisser la tête (comme pour faire un double menton). Tiens 5s. Pas de force, juste un alignement.',
      cues: ['Pas de mouvement vers le bas — c\'est un recul horizontal.', 'Imagine qu\'on tire le sommet du crâne vers le plafond.', 'Tu dois sentir un étirement à la base du crâne.'],
      caution: 'Stop si vertiges ou maux de tête.',
    },
    {
      id: 'reh-cervicales-mobilite', n: 'Mobilité cervicale douce', zone: 'cervicales',
      phases: ['aigue', 'subaigue', 'retour'], kind: 'mobilite',
      dose: '2 × 8 reps de chaque (4 directions)', gear: 'aucun',
      how: 'Assis dos droit. 1) Flexion (menton vers la poitrine). 2) Inclinaisons gauche/droite (oreille vers épaule). 3) Rotations gauche/droite (regard sur l\'épaule). Mouvements TRÈS lents.',
      cues: ['Amplitude jusqu\'à la zone confort uniquement.', 'Pas de cercles complets — chaque direction séparément.', 'Inspire/expire à chaque mouvement.'],
      caution: 'Stop si vertige, nausée, ou douleur qui descend dans le bras.',
    },
    {
      id: 'reh-cervicales-isom', n: 'Cervicales isométriques 4 directions', zone: 'cervicales',
      phases: ['subaigue', 'retour'], kind: 'isometrique',
      dose: '3 × 4 directions × 6s', gear: 'aucun',
      how: 'Place la main devant le front et pousse la tête contre la main sans qu\'elle bouge (flexion isom.). Idem main derrière la tête (extension), main sur la tempe gauche (inclinaison gauche), main sur la tempe droite (inclinaison droite).',
      cues: ['Force modérée 30-40%.', 'Aucun mouvement de la tête.', 'Tiens 6s, relâche 4s.'],
      caution: 'Si maux de tête après la séance, baisser l\'intensité.',
    },
    {
      id: 'reh-cervicales-haussements', n: 'Haussements d\'épaules', zone: 'cervicales',
      phases: ['subaigue', 'retour'], kind: 'mobilite',
      dose: '3 × 12 reps', gear: 'aucun',
      how: 'Debout, bras le long du corps. Hausse les épaules vers les oreilles, tiens 2s, relâche complètement.',
      cues: ['Amplitude max sans crisper le cou.', 'Relâche totalement entre chaque rep.', 'Synchronise avec le souffle (inspire monter, expire relâcher).'],
      caution: 'Stop si la tension augmente au lieu de diminuer.',
    },

    // ========== PECTORAL ==========
    {
      id: 'reh-pectoral-etire-porte', n: 'Étirement pectoral à l\'encadrement', zone: 'pectoral',
      phases: ['aigue', 'subaigue'], kind: 'etirement',
      dose: '3 × 30s par côté', gear: 'aucun',
      how: 'Debout dans l\'encadrement d\'une porte. Avant-bras contre le montant, coude à 90°, pied du même côté en avant. Avance lentement le buste jusqu\'à sentir l\'étirement à l\'avant de l\'épaule et du pectoral. Tiens 30s.',
      cues: ['Étirement modéré — pas une douleur.', 'Pas de bascule lombaire pour aller plus loin.', 'Variations de hauteur du coude (45°, 90°, 135°) pour viser différentes fibres.'],
      caution: 'Stop si pincement antérieur de l\'épaule.',
    },
    {
      id: 'reh-pectoral-roulement', n: 'Auto-massage à la balle', zone: 'pectoral',
      phases: ['subaigue', 'retour'], kind: 'mobilite',
      dose: '2 × 90s par côté', gear: 'aucun',
      how: 'Balle de tennis (ou crosse) coincée entre la poitrine et un mur, sur le pectoral. Roule lentement de haut en bas et latéralement, en t\'arrêtant quelques secondes sur les points sensibles.',
      cues: ['Pression supportable — ne crispe pas l\'épaule.', 'Respire profondément — l\'inspiration aide à relâcher.', 'Évite la zone du sternum et de l\'aisselle.'],
      caution: 'Pas sur les côtes flottantes ou en cas de fracture costale récente.',
    },
    {
      id: 'reh-pectoral-banding', n: 'Pectoral léger à l\'élastique', zone: 'pectoral',
      phases: ['subaigue', 'retour'], kind: 'banding',
      dose: '3 × 12 reps', gear: 'elastiques',
      how: 'Élastique fixé derrière toi à hauteur des épaules, tenu une extrémité dans chaque main. Bras tendus sur le côté à 90°. Ramène les mains devant toi en croisant légèrement.',
      cues: ['Mouvement lent, 2s aller, 2s retour.', 'Pas de blocage des coudes — légèrement fléchis.', 'Si l\'épaule pince, baisse la résistance.'],
      caution: 'Stop si douleur de l\'insertion humérale du pectoral.',
    },
    {
      id: 'reh-pectoral-mur-pompe', n: 'Pompe au mur', zone: 'pectoral',
      phases: ['retour'], kind: 'leger',
      dose: '3 × 15 reps', gear: 'aucun',
      how: 'Mains au mur largeur épaules, pieds à 50-80 cm du mur. Plie les coudes pour rapprocher la poitrine du mur, puis pousse pour revenir. Mouvement contrôlé.',
      cues: ['Corps gainé droit — tête, dos, talons alignés.', 'Coudes à ~45° du buste, pas écartés à 90°.', 'Plus tu recules les pieds, plus c\'est dur.'],
      caution: 'Stop si gêne à l\'épaule. Tu peux régresser à pompe au comptoir si besoin.',
    },
  ];

  // Index pour accès rapide par id.
  const EXERCISE_BY_ID = Object.fromEntries(EXERCISES.map(e => [e.id, e]));

  // computePhase calcule la phase courante à partir de la date de blessure
  // et d'un éventuel override manuel. L'override est prioritaire — c'est
  // le filet de sécurité pour les blessures qui ne suivent pas le calendrier.
  //   < 14 jours  → 'aigue'
  //   14-41 jours → 'subaigue'
  //   ≥ 42 jours  → 'retour'
  // Renvoie un objet { id, label, daysSince, range, summary }.
  function computePhase(injuryDateISO, manualPhase) {
    const phaseInfo = (id) => PHASES.find(p => p.id === id) || PHASES[0];
    if (manualPhase && PHASES.some(p => p.id === manualPhase)) {
      const info = phaseInfo(manualPhase);
      return Object.assign({}, info, { daysSince: daysBetween(injuryDateISO), manual: true });
    }
    const days = daysBetween(injuryDateISO);
    let id;
    if (days < 14) id = 'aigue';
    else if (days < 42) id = 'subaigue';
    else id = 'retour';
    return Object.assign({}, phaseInfo(id), { daysSince: days, manual: false });
  }

  function daysBetween(iso) {
    if (!iso) return 0;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return 0;
    const ms = Date.now() - t;
    return Math.max(0, Math.floor(ms / 86400000));
  }

  // exercisesFor retourne la liste filtrée d'exos pour un set de zones et
  // une phase donnés. Renvoie l'array brut — pas de mise en forme de séance.
  function exercisesFor(zones, phaseId) {
    if (!Array.isArray(zones) || zones.length === 0) return [];
    return EXERCISES.filter(ex =>
      zones.includes(ex.zone) && ex.phases.includes(phaseId)
    );
  }

  // generateSession produit une séance rééduc à partir de l'état du mode :
  //   {active, injuryDate, zones, manualPhase}
  // Retourne un objet :
  //   { id, label, phaseId, exos: [{id, n, dose, kind, ...}], notes }
  // La séance est volontairement courte (4-7 exos) — les protocoles rééduc
  // misent sur la régularité, pas sur le volume.
  function generateSession(rehab) {
    if (!rehab || !rehab.active || !Array.isArray(rehab.zones) || rehab.zones.length === 0) {
      return null;
    }
    const phase = computePhase(rehab.injuryDate, rehab.manualPhase);
    const pool = exercisesFor(rehab.zones, phase.id);
    if (pool.length === 0) {
      return {
        id: 'rehab-empty-' + Date.now(),
        label: 'Séance rééduc — pas d\'exo dispo',
        phaseId: phase.id,
        phaseLabel: phase.label,
        exos: [],
        notes: "Aucun exercice n'est disponible pour cette combinaison zone+phase. Consulte ton kiné pour un protocole adapté.",
      };
    }
    // Prendre 1-2 exos par zone touchée (pour balayer toutes les zones), max 7.
    const byZone = {};
    pool.forEach(ex => {
      byZone[ex.zone] = byZone[ex.zone] || [];
      byZone[ex.zone].push(ex);
    });
    const picked = [];
    const cap = phase.id === 'aigue' ? 4 : (phase.id === 'subaigue' ? 6 : 7);
    // Round-robin : un exo par zone à chaque tour, jusqu'à cap atteint.
    let pass = 0;
    while (picked.length < cap) {
      let added = false;
      for (const zoneId of rehab.zones) {
        const list = byZone[zoneId] || [];
        if (pass < list.length) {
          picked.push(list[pass]);
          added = true;
          if (picked.length >= cap) break;
        }
      }
      pass += 1;
      if (!added) break;
    }
    return {
      id: 'rehab-' + phase.id + '-' + Date.now(),
      label: 'Séance rééduc — phase ' + phase.label.toLowerCase(),
      phaseId: phase.id,
      phaseLabel: phase.label,
      phaseSummary: phase.summary,
      daysSince: phase.daysSince,
      manualPhase: phase.manual,
      exos: picked.map(ex => ({
        id: ex.id,
        n: ex.n,
        zone: ex.zone,
        kind: ex.kind,
        dose: ex.dose,
        gear: ex.gear,
        how: ex.how,
        cues: ex.cues,
        caution: ex.caution,
      })),
      notes: phase.summary +
        ' En cas de douleur (pas un simple inconfort), arrête immédiatement.',
    };
  }

  // Expose le module sur window pour app.js.
  window.Rehab = {
    DISCLAIMER_VERSION,
    DISCLAIMER_HTML,
    ZONES,
    PHASES,
    EXERCISES,
    EXERCISE_BY_ID,
    computePhase,
    exercisesFor,
    generateSession,
  };
})();
