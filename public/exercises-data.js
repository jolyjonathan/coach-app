/* =============================================================
 * Coach Adaptatif — exercises-data.js
 * =============================================================
 * Bibliotheque d'exercices + helpers de capacite (supportsWeight,
 * capWeight, notes halteres). EXTRAIT d'app.js (audit modularite,
 * action 4) : c'est du CONTENU, pas de la logique — il vit dans son
 * propre fichier, editable sans toucher au code applicatif.
 *
 * Script classique (pas de module) : les symboles top-level (EX,
 * EX_BY_ID, supportsWeight, ...) sont partages avec app.js via la
 * portee globale, comme les modules scientifiques. DOIT etre charge
 * AVANT app.js (cf. index.html et tests/run-tests.js).
 * ============================================================= */

/* =================== EXERCISE LIBRARY =================== */
// zones: chest, back, legs, shoulders, arms, core
// desc : phrase courte pour expliquer l'exo
// how  : comment bien le faire (2-3 phrases)
// tips : points-clés / erreurs fréquentes
const EX = [
  {id:'squat',n:'Squat',z:['legs'],gear:['barre','halteres','pdc'],pain:['genou','dos'],
   desc:'Flexion des jambes sur deux appuis, charge sur le haut du dos ou devant.',
   how:"Pieds largeur épaules, pointes légèrement ouvertes. Descends en pliant hanches ET genoux, dos droit, poitrine haute. Remonte en poussant dans les talons.",
   tips:['Genoux alignés sur la pointe des pieds, pas vers l\'intérieur.','Descends jusqu\'à cuisses parallèles au sol (ou plus bas si mobilité OK).','Ventre gainé pour protéger les lombaires.','Inspire en descendant, souffle en poussant.']},
  {id:'goblet',n:'Goblet Squat',z:['legs'],gear:['halteres'],pain:['genou'],
   desc:'Squat avec un haltère tenu devant la poitrine — idéal pour apprendre la technique.',
   how:"Tiens un haltère à deux mains contre la poitrine, coudes pointés vers le bas. Squat classique, le poids t'aide à garder le buste droit.",
   tips:['Coudes à l\'intérieur des genoux en bas.','Torse vertical — si tu bascules en avant, baisse la charge.','Bon exercice pour mobilité cheville/hanche.']},
  {id:'fentes',n:'Fentes alternées',z:['legs'],gear:['pdc','halteres'],pain:['genou'],
   desc:'Grand pas en avant, genou arrière vers le sol. Une jambe à la fois.',
   how:"Grand pas vers l'avant, descends en pliant les deux genoux à 90°. Le genou arrière frôle le sol sans toucher. Remonte et change de jambe.",
   tips:['Genou avant au-dessus de la cheville, pas devant l\'orteil.','Torse droit, regard à l\'horizon.','Alterne jambe droite / jambe gauche à chaque rep.']},
  {id:'sdt',n:'Soulevé de terre',z:['back','legs'],gear:['barre'],pain:['dos'],
   desc:'Soulève une charge du sol à la station debout — exercice roi pour chaîne postérieure.',
   how:"Barre au-dessus du milieu du pied. Hanches hautes, dos neutre, barre proche des tibias. Pousse dans le sol en tirant les hanches en avant ; épaules et hanches montent ensemble.",
   tips:['Dos JAMAIS arrondi — si ça lâche, baisse la charge.','Barre qui frôle les jambes tout le mouvement.','Verrouille hanches/genoux en haut sans hyperextension lombaire.','Si mal au dos, arrête et passe au SDT roumain avec haltères.']},
  {id:'sdtrm',n:'SDT roumain',z:['back','legs'],gear:['barre','halteres'],pain:['dos'],
   desc:'Soulevé de terre jambes quasi-tendues — cible ischios et fessiers.',
   how:"Départ debout, charge devant. Pousse les hanches en arrière (pas les genoux qui plient), descends la charge le long des jambes jusqu'à sentir l'étirement des ischios. Remonte par contraction des fessiers.",
   tips:['Genoux déverrouillés mais quasi-tendus (pas de flexion).','Dos parfaitement neutre — c\'est l\'exercice qui te l\'apprend.','Descente jusqu\'au milieu du tibia environ, selon souplesse.']},
  {id:'hipthrust',n:'Hip thrust',z:['legs'],gear:['barre','halteres','pdc'],needs:['banc'],pain:[],
   desc:'Poussée de hanches en pont, épaules sur un banc — meilleur pour les fessiers.',
   how:"Épaules contre un banc bas, pieds à plat au sol. Charge sur le pli des hanches. Pousse les hanches vers le plafond jusqu'à aligner genoux-hanches-épaules. Contracte les fessiers 1s en haut.",
   tips:['Menton rentré, regard vers les genoux.','Pieds écartés largeur hanches, bien à plat.','Évite de cambrer les lombaires — c\'est le fessier qui travaille.']},
  {id:'dc',n:'Développé couché',z:['chest','arms'],gear:['barre','halteres'],needs:['banc'],pain:['epaule'],
   desc:'Pousser une charge au-dessus de la poitrine, allongé sur un banc.',
   how:"Allongé sur le banc, pieds au sol, omoplates serrées. Barre (ou haltères) au-dessus du sternum, coudes à ~45° du corps. Descends jusqu'à frôler la poitrine, remonte en poussant droit.",
   tips:['Omoplates serrées/retroussées pendant tout le mouvement — stabilise l\'épaule.','Coudes ni collés au corps ni à 90° : ~45° protège l\'épaule.','Jamais de rebond sur la poitrine.','Si tu charges lourd, un pareur est utile.']},
  {id:'pompes',n:'Pompes',z:['chest','arms','core'],gear:['pdc'],pain:['epaule','poignet'],
   desc:'Poussée du corps au sol sur les mains — le basique du haut du corps.',
   how:"Mains légèrement plus larges que les épaules, corps aligné tête-talons. Descends en gardant les coudes à ~45°, poitrine vers le sol. Pousse pour remonter sans casser l'alignement.",
   tips:['Abdos gainés — pas de banane ni de cul en l\'air.','Si trop dur : pompes sur les genoux ou inclinées sur un meuble.','Coudes pas trop ouverts (épaules) ni trop serrés (triceps dominants).']},
  {id:'dip',n:'Dips',z:['chest','arms'],gear:['pdc'],pain:['epaule'],
   desc:'Poussée verticale entre deux barres parallèles — pectoraux bas + triceps.',
   how:"Bras tendus sur deux barres, corps suspendu. Descends en pliant les coudes jusqu'à ~90°, buste légèrement penché en avant pour pecs (ou vertical pour triceps). Remonte.",
   tips:['Descente contrôlée — pas de chute.','Ne descends pas trop bas si l\'épaule gêne.','Débutant : dips sur chaise (pieds au sol) avant dips complets.']},
  {id:'ecarte',n:'Écartés haltères',z:['chest'],gear:['halteres'],needs:['banc'],pain:['epaule'],
   desc:'Ouverture des bras à l\'horizontale, allongé — isolation pectoraux.',
   how:"Allongé sur le banc, haltères au-dessus de la poitrine, bras légèrement fléchis. Écarte les bras en arc de cercle jusqu'à sentir l'étirement. Remonte par contraction des pecs.",
   tips:['Coudes verrouillés en flexion légère — ne se plient pas pendant le mouvement.','Charges modérées : c\'est un exo d\'isolation, pas de record.','Descente jusqu\'au plan du banc, pas plus bas (épaule).']},
  {id:'tract',n:'Tractions',z:['back','arms'],gear:['traction'],pain:['epaule','coude'],
   desc:'Se hisser à une barre fixe — exercice roi pour le dos.',
   how:"Prise supination (paumes vers soi) ou pronation (dos des mains vers soi), largeur épaules. Tire jusqu'à passer le menton au-dessus. Descente contrôlée jusqu'à bras quasi-tendus.",
   tips:['Omoplates serrées d\'abord, puis les bras tirent.','Pas de kipping (mouvement de hanches) si objectif muscle.','Trop dur ? → tractions assistées élastique ou tirage vertical.']},
  {id:'row',n:'Rowing buste penché',z:['back','arms'],gear:['barre','halteres'],pain:['dos'],
   desc:'Tirer une charge vers le ventre, buste incliné — dos épais.',
   how:"Buste penché à 30-45°, dos neutre, genoux légèrement pliés. Tire la charge vers le bas du ventre, coudes près du corps. Pause 1s, redescends contrôlé.",
   tips:['Dos GARDÉ neutre — si ça tire sur les lombaires, charge trop lourde.','Tire avec les coudes, pas avec les bras.','Pause en haut pour sentir la contraction dorsale.']},
  {id:'rowelast',n:'Rowing élastique',z:['back','arms'],gear:['elastiques'],pain:[],
   desc:'Rowing assis avec un élastique — alternative sûre au buste penché.',
   how:"Assis au sol, élastique autour des pieds, dos droit. Tire les poignées vers le nombril, coudes près du corps, épaules basses. Relâche contrôlé.",
   tips:['Dos droit tout le mouvement, poitrine ouverte.','Tire jusqu\'à ce que les coudes dépassent le torse.','Super pour apprendre le geste avant de charger.']},
  {id:'tirage',n:'Tirage nuque élastique',z:['back'],gear:['elastiques'],pain:[],
   desc:'Tirage vertical avec élastique fixé en hauteur — simule le lat pull-down.',
   how:"Élastique fixé en hauteur. Agenouillé ou assis, tire les poignées vers les épaules, coudes qui descendent sur les côtés. Contracte le dos en bas du mouvement.",
   tips:['Évite de tirer derrière la nuque (risque épaule) — devant la poitrine.','Torse légèrement incliné en arrière.','Omoplates qui descendent et se rapprochent.']},
  {id:'militaire',n:'Développé militaire',z:['shoulders','arms'],gear:['barre','halteres'],pain:['epaule'],
   desc:'Pousser une charge au-dessus de la tête, debout — épaules solides.',
   how:"Debout, charge au niveau des épaules (devant). Pousse verticalement jusqu'à bras tendus au-dessus de la tête. Descends contrôlé au niveau du menton / épaules.",
   tips:['Abdos/fessiers gainés — pas de cambrure lombaire.','Pousse DROIT au-dessus de la tête, pas devant.','Si douleur épaule, essaye l\'arnold press (haltères avec rotation).']},
  {id:'lateraux',n:'Élévations latérales',z:['shoulders'],gear:['halteres','elastiques'],pain:['epaule'],
   desc:'Élever les bras sur les côtés — isole les deltoïdes latéraux.',
   how:"Debout, haltères le long du corps, léger buste vers l'avant. Élève les bras sur les côtés jusqu'à l'horizontale, coudes légèrement pliés. Descends contrôlé.",
   tips:['Charges légères — priorité à la forme, pas au poids.','Coude au-dessus du poignet à la fin du mouvement.','N\'élève PAS au-dessus de l\'horizontale (pincement épaule).']},
  {id:'curl',n:'Curl biceps',z:['arms'],gear:['halteres','barre','elastiques'],pain:['coude'],
   desc:'Flexion du coude avec charge — isole les biceps.',
   how:"Debout, coudes collés au corps. Plie les bras pour ramener la charge vers les épaules, contraction en haut. Descends LENTEMENT (3s) pour maximiser.",
   tips:['Coudes FIXES près du corps — pas de balancer.','Poignets neutres, pas cassés en arrière.','Pas besoin de charger lourd : cherche la contraction, pas le record.']},
  {id:'triceps',n:'Extension triceps',z:['arms'],gear:['halteres','elastiques'],pain:['coude'],
   desc:'Extension du coude, bras au-dessus de la tête — isole les triceps.',
   how:"Debout ou assis, un haltère tenu à deux mains au-dessus de la tête. Plie les coudes pour descendre la charge derrière la tête. Remonte en tendant les bras.",
   tips:['Coudes pointés vers le plafond, fixes — seul l\'avant-bras bouge.','Mouvement contrôlé — pas de à-coups.','Alternative : kick-back haltère (buste penché).']},
  {id:'gainage',n:'Gainage (planche)',z:['core'],gear:['pdc'],pain:[],timed:true,floor:true,
   desc:'Position immobile sur avant-bras et pointes de pieds — renforce la sangle abdo-lombaire.',
   how:"Avant-bras au sol, coudes sous les épaules, corps aligné tête-talons. Gaine abdos, fessiers, et ne laisse pas les hanches tomber ni monter. Respire calmement.",
   tips:['Alignement PARFAIT : si les fesses montent ou tombent, arrête.','Regard vers le sol, nuque alignée avec le dos.','Mieux vaut 30s parfaites que 2min avachies.']},
  {id:'crunch',n:'Crunch',z:['core'],gear:['pdc'],pain:['dos'],
   desc:'Enroulement du buste, allongé dos au sol — grand droit abdo.',
   how:"Allongé, genoux pliés, pieds au sol. Mains croisées sur la poitrine. Enroule le buste en décollant les omoplates du sol (pas tout le dos). Redescends contrôlé.",
   tips:['On n\'arrache PAS la nuque avec les mains.','Petit mouvement — juste les omoplates qui décollent.','Souffle en montant, inspire en descendant.']},
  {id:'mountain',n:'Mountain climbers',z:['core','legs'],gear:['pdc'],pain:['poignet'],
   desc:'Alternance rapide de genoux vers la poitrine en position de pompes — cardio + core.',
   how:"Position de pompes (bras tendus). Amène alternativement un genou vers la poitrine, l'autre reste en arrière. Alterne rapidement sans casser l'alignement du dos.",
   tips:['Hanches qui restent STABLES — pas de yoyo.','Rythme soutenu pour l\'effet cardio.','Si poignets sensibles : appuis sur les poings ou parallettes.']},
  {id:'kbswing',n:'Kettlebell swing',z:['legs','back','core'],gear:['kettlebell'],pain:['dos'],
   desc:'Balancement explosif d\'une kettlebell entre les jambes — chaîne postérieure + cardio.',
   how:"Pieds largeur épaules, KB tenue à deux mains devant. Hinge des hanches (pas un squat), propulse la KB en avant avec une poussée de bassin. Laisse-la revenir en swing contrôlé.",
   tips:['C\'est les hanches qui propulsent, pas les bras.','Dos neutre pendant tout le mouvement.','Arrête à hauteur des épaules (swing russe), pas au-dessus.']},
  {id:'kbgoblet',n:'Goblet KB Squat',z:['legs'],gear:['kettlebell'],pain:['genou'],
   desc:'Squat en tenant une kettlebell contre la poitrine.',
   how:"KB tenue par les cornes contre la poitrine, coudes bas. Squat classique, le poids devant t'aide à garder le buste droit. Descente profonde possible.",
   tips:['Coudes à l\'intérieur des genoux en bas.','Très bon pour apprendre la mobilité.']},
  {id:'trxrow',n:'TRX rowing',z:['back','arms'],gear:['trx'],pain:[],
   desc:'Tirage horizontal suspendu aux sangles — dos sans charge.',
   how:"Sangles à hauteur de hanches, saisis les poignées, incline-toi en arrière corps droit. Tire la poitrine vers les mains, coudes près du corps. Plus les pieds sont avancés, plus c'est dur.",
   tips:['Corps gainé comme une planche inversée.','Omoplates qui se serrent en tirant.','Règle la difficulté en reculant ou avançant les pieds.']},
  {id:'trxpush',n:'TRX pompes',z:['chest','core','arms'],gear:['trx'],pain:['epaule','poignet'],
   desc:'Pompes avec les mains dans les sangles — instabilité → plus de core.',
   how:"Mains dans les poignées TRX à hauteur poitrine (sangles basses). Corps droit, pompes classiques. Plus les sangles sont basses, plus c'est dur.",
   tips:['Abdos bien gainés — le TRX instable amplifie les défauts.','Mouvement lent et contrôlé.']},
  {id:'dcincline',n:'Développé incliné',z:['chest','shoulders','arms'],gear:['halteres','barre'],needs:['banc'],pain:['epaule'],
   desc:'Développé couché avec banc incliné à 30-45° — cible haut de pecs.',
   how:"Banc incliné à 30-45°. Omoplates serrées, coudes à ~45°, descends jusqu'à la poitrine haute, remontes droit au-dessus.",
   tips:['Plus le banc est incliné, plus les épaules bossent (limite à 45°).','Ne cambre pas les lombaires pour tricher.']},
  {id:'bulgare',n:'Fente bulgare',z:['legs'],gear:['pdc','halteres','kettlebell'],needs:['banc'],pain:['genou'],unilateral:true,
   desc:'Fente avec le pied arrière surélevé sur un banc — unilatéral intense.',
   how:"Pied arrière sur un banc derrière toi, pied avant un grand pas devant. Descends en pliant le genou avant, torse droit. Remonte en poussant dans le talon avant.",
   tips:['Genou avant aligné sur la pointe du pied.','Torse vertical, charge sur la jambe avant.','Exercice dur : commence poids du corps.']},

  /* ============ CALISTHÉNIE / POIDS DU CORPS ============
   * Utilisables partout — chez soi, en extérieur, en park, ou en salle.
   * Beaucoup ciblent des zones peu couvertes par le matériel classique. */
  {id:'pistol',n:'Pistol squat',z:['legs','core'],gear:['pdc'],pain:['genou'],unilateral:true,
   desc:'Squat sur une seule jambe, l\'autre tendue devant — unilatéral extrême.',
   how:"Debout sur une jambe, l\'autre tendue devant toi. Descends en pliant le genou, buste légèrement penché pour garder l\'équilibre. Remonte en poussant dans le talon.",
   tips:['Tiens un pilier / TRX / élastique au début pour équilibrer.','Progresse d\'abord par des box squats unilatéraux.','Pied d\'appui bien à plat, genou aligné.']},
  {id:'jumpsquat',n:'Squat sauté',z:['legs'],gear:['pdc'],pain:['genou','dos'],
   desc:'Squat explosif avec saut — puissance et cardio.',
   how:"Squat classique, puis détends les jambes pour sauter verticalement. Réceptionne-toi genoux souples, enchaîne directement sur la descente du squat suivant.",
   tips:['Atterris doucement, pas de choc sec sur les genoux.','Bras vers le haut pour le momentum.','Si genoux sensibles : passe en squat simple.']},
  {id:'boxjump',n:'Box jump',z:['legs'],gear:['pdc'],pain:['genou'],
   desc:'Saut explosif sur une caisse / banc solide — puissance.',
   how:"Face à une caisse stable (30-60cm). Fléchis, lance les bras en arrière puis saute pour te poser les deux pieds sur la caisse. Redescends en marchant, pas en sautant.",
   tips:['Atterris PLIÉ, pas raide — absorbe.','Redescends marche par marche pour ménager les tendons.','Hauteur progressive — sécurité avant record.']},
  {id:'stepup',n:'Montées sur banc',z:['legs'],gear:['pdc','halteres','kettlebell'],needs:['banc'],pain:['genou'],unilateral:true,
   desc:'Monter sur un banc une jambe à la fois — fonctionnel et unilatéral.',
   how:"Pied entier posé sur le banc. Pousse dans le talon pour monter debout, ramène l\'autre pied à côté. Redescends contrôlé. Alterne à chaque répétition ou fais une série par jambe.",
   tips:['Pas d\'élan avec la jambe arrière — c\'est la jambe avant qui fait tout.','Banc à hauteur de genou environ.','Charge tenue le long du corps avec haltères.']},
  {id:'gluteb',n:'Glute bridge',z:['legs','core'],gear:['pdc','halteres','barre'],pain:[],
   desc:'Pont fessier au sol — fessiers et chaîne postérieure sans matériel.',
   how:"Allongé sur le dos, genoux pliés, pieds à plat proche des fessiers. Pousse les hanches vers le plafond en contractant les fessiers. Pause 1s en haut, redescends.",
   tips:['Serre les fessiers en haut, pas les lombaires.','Menton rentré, nuque neutre.','Charge possible sur le pli des hanches.']},
  {id:'wallsit',n:'Chaise contre mur',z:['legs'],gear:['pdc'],pain:['genou'],timed:true,
   desc:'Position assise contre un mur, cuisses parallèles au sol — endurance quadriceps.',
   how:"Dos collé au mur, descends en glissant jusqu\'à cuisses parallèles (genoux à 90°). Tiens la position. Respire calmement.",
   tips:['Genoux exactement au-dessus des chevilles, pas devant.','Dos entièrement plaqué au mur.','Débutant : angle plus ouvert (moins bas).']},
  {id:'mollet',n:'Mollets debout',z:['legs'],gear:['pdc','halteres','kettlebell'],pain:[],
   desc:'Élévation sur pointes de pieds — gastrocnémiens.',
   how:"Debout, pieds largeur hanches. Monte sur la pointe des pieds au maximum, pause 1s en haut, redescends contrôlé. Progression : une jambe à la fois ou sur une marche pour amplitude.",
   tips:['Amplitude complète : pointe haute, talon plus bas que la marche.','Charge dans les mains pour progression.','3-4 séries de 15-20 reps pour résultat.']},
  {id:'pompediam',n:'Pompes diamant',z:['chest','arms'],gear:['pdc'],pain:['epaule','poignet','coude'],
   desc:'Pompes mains rapprochées en losange — triceps dominants.',
   how:"Mains au sol pouces et index se touchant en forme de losange sous le sternum. Pompes classiques — coudes qui frôlent le torse en descendant.",
   tips:['Exercice plus dur que les pompes normales : prends-le après une progression.','Coudes longs du corps, pas ouverts.','Genoux au sol pour démarrer.']},
  {id:'pikepush',n:'Pike push-up',z:['shoulders','arms'],gear:['pdc'],pain:['epaule','poignet'],
   desc:'Pompes en V inversé — préparation au handstand push-up.',
   how:"Position de pompe, recule les pieds vers les mains, fesses hautes, corps en V. Plie les coudes pour amener le sommet du crâne vers le sol entre les mains. Pousse pour remonter.",
   tips:['Plus les fesses sont hautes, plus c\'est les épaules qui bossent.','Pieds surélevés sur un banc = progression.','Objectif : handstand push-up contre un mur.']},
  {id:'invrow',n:'Rowing inversé',z:['back','arms'],gear:['traction'],pain:['epaule'],
   desc:'Rowing suspendu sous une barre basse — alternative aux tractions.',
   how:"Barre à hauteur de hanches. Allonge-toi dessous, saisis la barre prise pronation largeur épaules, corps gainé droit. Tire la poitrine vers la barre, coudes près du corps. Redescends contrôlé.",
   tips:['Plus les pieds sont avancés, plus c\'est dur.','Corps rigide comme une planche inversée.','Parfait en park sur une barre basse ou entre deux supports.']},
  {id:'superman',n:'Superman',z:['back','core'],gear:['pdc'],pain:['dos'],timed:true,floor:true,
   desc:'Extension lombaire bras et jambes tendus, allongé sur le ventre — lombaires et fessiers.',
   how:"Allongé sur le ventre, bras tendus devant, jambes tendues. Décolle simultanément bras et jambes du sol en contractant lombaires et fessiers. Tiens 2s, redescends.",
   tips:['Menton rentré, regard vers le sol — pas de cassure nuque.','Contraction fessiers ET lombaires ensemble.','Version timed : tenue 20-40s.']},
  {id:'hollow',n:'Hollow body hold',z:['core'],gear:['pdc'],pain:['dos'],timed:true,floor:true,
   desc:'Position \"banane inversée\" — gainage profond spécifique gym.',
   how:"Allongé sur le dos, bas du dos plaqué au sol. Décolle simultanément épaules, bras (tendus derrière la tête) et jambes (tendues). Forme de banane inversée. Respire.",
   tips:['Bas du dos COLLÉ au sol en permanence — si ça décolle, plie les genoux.','Bras le long des oreilles.','20-40s est déjà très bien.']},
  {id:'sideplank',n:'Gainage latéral',z:['core'],gear:['pdc'],pain:['epaule'],timed:true,unilateral:true,floor:true,
   desc:'Planche sur un avant-bras et un pied — obliques.',
   how:"Sur le côté, avant-bras au sol coude sous l\'épaule, pieds empilés. Décolle les hanches du sol, corps aligné tête-pieds. Tiens. Change de côté.",
   tips:['Hanches bien hautes — pas de cassure au niveau des abdos latéraux.','Épaule stable au-dessus du coude.','Facile : appui sur le genou plutôt que le pied.']},
  {id:'birddog',n:'Bird-dog',z:['core','back'],gear:['pdc'],pain:[],
   desc:'À quatre pattes, extension bras + jambe opposés — antigravitaire lombaire.',
   how:"À quatre pattes, dos neutre. Tends simultanément le bras droit devant et la jambe gauche derrière jusqu\'à ligne droite. Pause 2s. Reviens et alterne.",
   tips:['Hanches STABLES — pas de bascule gauche/droite.','Bras et jambe à l\'horizontale, pas plus haut.','Très bon pour lombalgie légère (anti-douleur).']},
  {id:'deadbug',n:'Dead bug',z:['core'],gear:['pdc'],pain:[],
   desc:'Allongé sur le dos, bras + jambe opposés s\'abaissent en alternance — stabilisation lombaire.',
   how:"Allongé, bras tendus vers le plafond, jambes pliées hanches/genoux à 90°. Abaisse simultanément bras droit au-dessus de la tête et jambe gauche tendue vers le sol, sans toucher. Reviens, alterne.",
   tips:['Bas du dos COLLÉ au sol tout le mouvement.','Mouvement lent et contrôlé.','Exercice roi pour activer le core profond.']},
  {id:'rustwist',n:'Russian twist',z:['core'],gear:['pdc','halteres','kettlebell'],pain:['dos'],
   desc:'Rotation du buste assis en V — obliques.',
   how:"Assis, buste incliné en arrière ~45°, pieds décollés ou au sol. Mains jointes ou charge, tourne le buste à droite, touche à côté de la hanche, puis à gauche.",
   tips:['Le mouvement vient du buste, pas seulement des bras.','Dos droit, pas arrondi — si ça tire les lombaires, reviens sans charge.','Pieds au sol si débutant.']},
  {id:'hangleg',n:'Relevés jambes suspendu',z:['core'],gear:['traction'],pain:['epaule'],
   desc:'Suspendu à une barre, remonte les jambes — abdos bas.',
   how:"Suspendu bras tendus à une barre, corps gainé. Remonte les genoux à la poitrine (débutant) ou jambes tendues à l\'horizontale (avancé). Redescends contrôlé, pas de balancement.",
   tips:['Pas de swing du corps — abdos uniquement.','Débutant : genoux pliés. Avancé : jambes tendues.','Très complet : grip, épaules, core.']},
  {id:'burpee',n:'Burpees',z:['legs','chest','core'],gear:['pdc'],pain:['genou','epaule','poignet'],
   desc:'Squat + pompe + saut enchaînés — full body cardio.',
   how:"Debout → squat mains au sol → jette les pieds en arrière (position pompe) → fais une pompe → ramène les pieds sous toi → saute verticalement bras en l\'air. Enchaîne.",
   tips:['Forme > vitesse : ne compromets pas la pompe.','Version soft : sans la pompe ni le saut.','Killer pour le cardio et la coordination.']},
  {id:'highknee',n:'Montées de genoux',z:['legs','core'],gear:['pdc'],pain:['genou'],timed:true,
   desc:'Courir sur place en montant haut les genoux — cardio et fléchisseurs.',
   how:"Sur place, alterne rapidement genou gauche / genou droit à hauteur de hanches. Bras qui pompent comme en course. Rythme soutenu.",
   tips:['Objectif : rapidité et hauteur de genoux.','Reste sur la pointe des pieds.','Excellent échauffement ou finisher cardio.']},

  /* ============ MACHINES DE SALLE ============ */
  {id:'legpress',n:'Presse à cuisses',z:['legs'],gear:['machine'],pain:['dos'],
   desc:'Pousser une charge guidée avec les jambes, assis sur la machine — quadri/fessiers sans charger la colonne.',
   how:"Assis dans la presse, dos plaqué, pieds largeur hanches à plat sur le plateau. Fléchis les genoux jusqu\'à ~90° sans décoller le bas du dos. Pousse pour tendre les jambes sans verrouiller les genoux.",
   tips:['Pieds HAUT sur le plateau = plus de fessiers/ischios.','Pieds bas = plus de quadriceps.','Ne VERROUILLE jamais les genoux en haut.','Bon substitut au squat si dos fragile.']},
  {id:'legext',n:'Leg extension',z:['legs'],gear:['machine'],pain:['genou'],
   desc:'Extension des genoux assis sur une machine — isolation quadriceps.',
   how:"Assis, chevilles derrière le rouleau, dos contre le dossier. Tends les jambes jusqu\'à la quasi-extension, pause 1s contraction, redescends lentement.",
   tips:['Charge modérée — c\'est un exo d\'isolation.','Évite l\'extension complète verrouillée (usure rotulienne).','Mouvement lent, pas de à-coups.']},
  {id:'legcurl',n:'Leg curl',z:['legs'],gear:['machine'],pain:[],
   desc:'Flexion des genoux allongé ou assis, machine — isolation ischios.',
   how:"Selon machine (allongée ou assise) : chevilles contre le rouleau, plie les genoux pour amener les talons vers les fesses. Pause 1s, redescends contrôlé.",
   tips:['Hanches bien plaquées, pas de tricherie par cambrure.','Contraction 1s en haut pour sentir les ischios.','Fait bon duo avec leg extension pour équilibre quadri/ischios.']},
  {id:'latpull',n:'Tirage vertical (poulie)',z:['back','arms'],gear:['machine'],pain:['epaule'],
   desc:'Tirage d\'une barre vers la poitrine, assis sur la machine — dos large.',
   how:"Assis, cuisses sous le pad, saisis la barre prise large pronation. Tire la barre vers la clavicule en serrant les omoplates, coudes qui descendent sur les côtés. Remonte contrôlé sans lâcher la tension.",
   tips:['JAMAIS derrière la nuque (risque épaule).','Torse légèrement incliné en arrière ~20°.','Omoplates qui descendent EN PREMIER, puis les bras tirent.']},
  {id:'cablerow',n:'Rowing assis poulie',z:['back','arms'],gear:['machine'],pain:['dos'],
   desc:'Tirer une poignée vers le ventre, assis face à une poulie basse — dos épais.',
   how:"Assis, pieds contre le cale-pieds, genoux légèrement pliés. Saisis la poignée, buste droit. Tire vers le nombril en serrant les omoplates, coudes près du corps. Relâche contrôlé.",
   tips:['Dos neutre — pas d\'arrondi, pas d\'hyperextension.','Tire avec les coudes, pas avec les bras.','Pause 1s au point de contraction.']},
  {id:'pecdeck',n:'Pec deck',z:['chest'],gear:['machine'],pain:['epaule'],
   desc:'Rapprochement des bras sur machine — isolation pectoraux.',
   how:"Assis, dos plaqué, coudes posés sur les pads à hauteur d\'épaules. Rapproche les pads devant toi en contractant les pecs. Pause 1s, relâche contrôlé.",
   tips:['Coudes à hauteur d\'épaule, pas plus haut (pincement).','Charge modérée — isolation, pas record.','Excellent finisher pecs.']},
  {id:'facepull',n:'Face pull',z:['shoulders','back'],gear:['machine','elastiques'],pain:[],
   desc:'Tirage d\'une corde de poulie vers le visage — arrière d\'épaule et posture.',
   how:"Poulie haute, corde avec poignées. Recule de 2 pas, tire vers le front, coudes hauts et larges. Écartement des mains à la fin. Relâche contrôlé.",
   tips:['Coudes au-dessus des poignets — mouvement horizontal, pas de curl.','Charge légère, priorité à la contraction.','Un des meilleurs exos pour la santé d\'épaule.']},
  {id:'tripush',n:'Triceps poulie',z:['arms'],gear:['machine'],pain:['coude'],
   desc:'Pushdown triceps avec corde ou barre sur poulie haute — isolation.',
   how:"Debout face à la poulie haute, coudes collés au corps. Pousse la corde vers le bas jusqu\'à extension complète des bras, écarte les poignets en bas pour la contraction. Remonte contrôlé.",
   tips:['Coudes FIXES contre le corps — seul l\'avant-bras bouge.','Pause 1s en contraction basse.','Corde > barre pour amplitude et confort coude.']},
  {id:'cablecurl',n:'Curl poulie',z:['arms'],gear:['machine'],pain:['coude'],
   desc:'Curl biceps avec poulie basse — tension constante.',
   how:"Debout face à la poulie basse, barre courbée ou poignées. Coudes collés au corps, curl vers les épaules, pause en contraction, redescente lente (3s).",
   tips:['La poulie garde la tension même en bas du mouvement, contrairement aux haltères.','Coudes IMMOBILES au corps.','Charge légère-modérée, cherche la brûlure.']},

  /* ============ ÉLASTIQUES — exercices portables chez soi ou au park ============ */
  {id:'bandpa',n:'Pull-apart élastique',z:['shoulders','back'],gear:['elastiques'],pain:[],
   desc:'Écartement d\'un élastique tendu devant soi — arrière d\'épaule et posture.',
   how:"Debout, élastique tendu devant toi à hauteur de poitrine, bras tendus. Écarte les bras en les gardant tendus, amène l\'élastique contre la poitrine en serrant les omoplates. Relâche.",
   tips:['Bras TENDUS pendant tout le mouvement.','Serre les omoplates fort en fin de course.','Exo anti-cyphose : fais-en tous les jours si tu bosses assis.']},
  {id:'bandgm',n:'Good morning élastique',z:['back','legs'],gear:['elastiques'],pain:['dos'],
   desc:'Flexion de hanches buste penché avec élastique sous les pieds — chaîne postérieure.',
   how:"Élastique sous les deux pieds, anse autour du cou/nuque protégée. Genoux légèrement pliés. Pousse les hanches en arrière en penchant le buste à ~45°, dos NEUTRE. Remonte par contraction fessiers.",
   tips:['Dos JAMAIS arrondi.','Mouvement de hanches, pas de dos.','Excellent échauffement SDT / bon debut calisthénie.']},
  {id:'bandwalk',n:'Marche latérale élastique',z:['legs'],gear:['elastiques'],pain:[],
   desc:'Pas chassés latéraux avec élastique autour des genoux ou chevilles — moyens fessiers.',
   how:"Élastique autour des cuisses (au-dessus des genoux) ou chevilles. Léger squat, pieds largeur hanches. Fais 10 pas latéraux à droite, 10 à gauche, en gardant la tension sur l\'élastique.",
   tips:['Genoux ne rentrent PAS vers l\'intérieur — c\'est le point clé.','Reste en position semi-squat tout le long.','Bruleur fessiers moyens — essentiel pour stabilité hanche.']},

  /* ============ KETTLEBELL — supplément ============ */
  {id:'kbpress',n:'Développé épaules KB',z:['shoulders','arms'],gear:['kettlebell'],pain:['epaule'],
   desc:'Développé vertical avec une kettlebell par main — épaule stable.',
   how:"KB en position rack (poignée contre la paume, cloche sur l\'avant-bras) à l\'épaule. Pousse verticalement jusqu\'à bras tendu, coude verrouillé. Redescends contrôlé en position rack.",
   tips:['Poignet NEUTRE — pas cassé en arrière.','Gainage abdos/fessiers — pas de cambrure lombaire.','Une main à la fois ou bilateral selon matériel.']},
  {id:'kbtgu',n:'Turkish get-up',z:['core','legs','shoulders'],gear:['kettlebell'],pain:['epaule','dos'],
   desc:'Se relever du sol en tenant une KB au-dessus de la tête — full body, mobilité épaule.',
   how:"Allongé sur le dos, KB tenue à bout de bras au-dessus de l\'épaule droite. En 6-7 étapes méthodiques (coude, main, pont, passage de jambe, fente, debout), relève-toi sans jamais baisser la KB. Reviens par la même séquence.",
   tips:['LENT. Chaque étape doit être maîtrisée — c\'est technique, pas cardio.','Apprends à vide / avec chaussure, puis KB légère.','Bras VERTICAL tout le temps, regard sur la KB.','Un des meilleurs exos full body qui existe.']},

  /* ============ PROPHYLAXIE — Nordic Hamstring (Petersen 2011) ============
   * RCT princeps : -70% d'incidence de claquage ischios chez les footeurs
   * danois avec 3×10 reps eccentriques, 2×/sem. Méta-analyses confirment
   * (van Dyk 2019 : -51% blessures ischios sur 14 RCT). Coûte rien, prend
   * 5 min, protège un muscle qu'on déchire toujours au pire moment. */
  {id:'nordic',n:'Nordic Hamstring',z:['legs','core'],gear:['pdc'],needs:['ancrage'],pain:['dos'],unilateral:false,
   desc:'Excentrique d\'ischios à genoux, pieds bloqués — prévention claquages ischios.',
   how:"À genoux sur un tapis, chevilles bloquées sous quelque chose (banc, partenaire, machine). Mains croisées sur la poitrine. Descends LENTEMENT le buste vers l'avant en gardant le corps gainé (3-5s par rep) en résistant au maximum avec les ischios. Rattrape avec les mains au dernier moment, repousse avec les bras pour revenir.",
   tips:['Phase eccentrique LENTE — c\'est elle qui protège, pas la remontée.','Démarre par 2-3 reps même si tu peux faire plus : courbatures massives sinon.','Progression : amplitude (descendre plus bas) avant le nombre de reps.','3×6-10 reps, 2×/sem, jamais le jour d\'une grosse séance jambes.']},
];

const EX_BY_ID = Object.fromEntries(EX.map(e => [e.id, e]));
// Expose sur window pour que snacks.js (chargé avant) puisse résoudre les
// noms d'exos référencés. Pas un module système — juste une convention.
window.EX_BY_ID = EX_BY_ID;

// Does this exercise accept added weight? True for barre/halteres/kettlebell/machine.
// Bodyweight (pdc), tractions (traction), elastic (elastiques), TRX exos → no weight column.
// Machines use a pin/stack and benefit from the same progressive-overload math,
// though we don't have a user-declared max for them (capWeight won't cap them).
function supportsWeight(exoId) {
  const e = EX_BY_ID[exoId];
  if (!e || e.timed) return false;
  return e.gear.some(g => g === 'barre' || g === 'halteres' || g === 'kettlebell' || g === 'machine');
}

// Pour les exos avec haltères : indique si la charge prescrite s'applique à
// 1 haltère (tenu à 2 mains, ou posé sur les hanches), ou 2 haltères (un par
// main, donc charge totale = 2× la valeur affichée).
//
// Pourquoi pas une propriété directement sur chaque exo ? Pour garder le tableau
// EX lisible. Le défaut implicite est 2 (cas le plus courant), seuls les exos
// "à 1 haltère" sont listés ici.
//
// Le kg affiché reste toujours "par haltère" — cette annotation ne change pas
// la valeur, elle clarifie juste son interprétation pour l'utilisateur.
const DUMBBELL_HANDS_ONE = new Set([
  'goblet',     // haltère tenu à 2 mains contre la poitrine
  'triceps',    // extension overhead à 2 mains
  'hipthrust',  // posé sur le pli des hanches
  'gluteb',     // posé sur le pli des hanches
  'rustwist',   // tenu à 2 mains devant le buste
]);

function dbHandsFor(exoId) {
  const e = EX_BY_ID[exoId];
  if (!e || !e.gear.includes('halteres')) return null;
  return DUMBBELL_HANDS_ONE.has(exoId) ? 1 : 2;
}

// Petit libellé affiché à côté du poids pour préciser 1 vs 2 haltères.
// Retourne '' si l'exo n'utilise pas d'haltères (cas barbell/machine pur).
function dumbbellNote(exoId) {
  const h = dbHandsFor(exoId);
  if (h == null) return '';
  return h === 1 ? '1 haltère (à 2 mains)' : '2 haltères (un par main)';
}

// Cap a suggested weight by the user's declared max (per-exo, based on gear).
function capWeight(exoId, weight) {
  if (weight == null) return null;
  const e = EX_BY_ID[exoId];
  if (!e) return weight;
  const p = S.profile || {};
  const caps = [];
  if (e.gear.includes('barre') && p.maxBarre)     caps.push(p.maxBarre);
  if (e.gear.includes('halteres') && p.maxHalteres) caps.push(p.maxHalteres);
  if (caps.length === 0) return weight;
  return Math.min(weight, Math.max(...caps));
}


/* Exercise illustrations: disabled. Stick-figure poses did not read cleanly
 * enough to help. If/when we ship real photos, re-enable via this helper. */
function renderExoIllustration(_exoId) { return ''; }
