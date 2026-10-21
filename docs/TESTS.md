# Validation et matrice d'acceptation

Commande reproductible : `npm ci && npm run ci`. `npm run ci` inclut typecheck, lint/format, compilation et tests `node:test`. `npm run test:pi-versions` rejoue la suite complète dans une copie isolée du projet pour chaque version de Pi 1.x listée dans `src/compat.ts` (1.0.0 à 1.3.0), avec tous les paquets `@earendil-works/*` épinglés sur la version testée ; la CI exécute ce job. Les serveurs utilisent des données synthétiques ; le transport injecté **dans les tests uniquement** mappe les noms HTTPS `.example` vers des serveurs loopback HTTP. Aucune exception HTTP n'existe dans la configuration livrée. Le test d'installation bloque le réseau dans le processus CLI Pi et n'utilise aucun registre.

| ID | Couverture automatisée |
|---|---|
| T01 | `config.test.mjs`, `offline.test.mjs` : multi-contextes, vrais providers chargés par le CLI |
| T02 | `config.test.mjs` : issuer/clientId manquant, message contrôlé et extension désactivée sans crash global |
| T03 | `oauth.test.mjs`, `refresh.test.mjs` : S256, callback, redirect_uri identique, stockage via `ModelRuntime.login` |
| T04 | `oauth.test.mjs` : state erroné, pas d'échange token, fermeture |
| T05 | `oauth.test.mjs` : timeout et annulation, port réutilisable |
| T06 | `oauth.test.mjs` : port réellement occupé et choix de repli autorisé |
| T07 | `device.test.mjs` : pending, slow_down, PKCE, expiration, refus, annulation, horloge simulée |
| T08 | `refresh.test.mjs`, `gateway.test.mjs` : refresh anticipé puis nouveau Bearer réellement reçu |
| T09 | `refresh.test.mjs` : deux `Models.getAuth` concurrents puis deux processus Pi partageant un fichier ; un échange effectif et refresh tournant persisté ; annulation pendant un refresh : rotation conservée (persistée par Pi ≥ 1.0.3, réutilisée en mémoire sinon), jamais de rejeu du token révoqué |
| T10 | `refresh.test.mjs` : fichiers Pi temporaires, credential datant de la veille, nouveau runtime sans nouveau login |
| T11 | `refresh.test.mjs` : invalid_grant, instruction /login, aucun retry et credential préservé |
| T12 | `gateway.test.mjs`, `refresh.test.mjs` : deux origines/tokens distincts et changement de contexte bloqué avant réseau |
| T13 | `gateway.test.mjs` : Completions et Responses SSE, usage, Unicode, outils, hooks, reprise après résultat d'outil et annulation |
| T14 | `gateway.test.mjs` : destinations de redirection 302/307/308 jamais contactées |
| T15 | `oauth.test.mjs`, `gateway.test.mjs` : erreur réseau, serveur silencieux, mauvais JSON, réponse excessive et 503 sans boucle |
| T16 | `device.test.mjs`, `oauth.test.mjs`, `gateway.test.mjs` : debug sans secrets et messages serveur masqués |
| T17 | `offline.test.mjs` : vrai tarball, extraction sans node_modules, `pi install` et `--list-models`, réseau interdit |
| T18 | `oauth.test.mjs` : issuer/endpoint/PKCE incohérents rejetés |
| T19 | `oauth.test.mjs` : refresh absent au login/refresh, réutilisation uniquement sur opt-in documenté |
| T20 | `device.test.mjs`, `config.test.mjs` : offline_access non octroyé et scope retiré explicitement ; avertissement sans faux engagement |
| COMPAT | `compat.test.mjs` : Pi 1.x accepté, autres majeures refusées, chargement sur la version installée ; `npm run test:pi-versions` rejoue T01–T20 sur Pi 1.0.0 à 1.3.0 |

Les assertions réseau vérifient le Bearer reçu par les mock gateways. Les tests de stockage n'écrivent jamais eux-mêmes un `auth.json` : les fixtures passent par les API Pi et les lectures d'assertion ne quittent pas les répertoires temporaires.

## Essai manuel requis avant production

Les tests T01–T20 ont une couverture automatique, mais ils ne démontrent ni l'autorisation d'un client interne ni la conformité d'une gateway réelle. Sur un environnement de test **autorisé** :

1. Relever les versions Pi/extension, issuer/client public/scopes, redirect URI, API et modèle confirmés. Ne pas consigner de secrets.
2. Installer le package, configurer le modèle confirmé, lancer `/agentgateway-doctor`, vérifier l'horloge et les CA.
3. Faire `/login` navigateur. Vérifier la page Keycloak et le retour automatique ; ne pas photographier le code ou l'URL de callback.
4. Choisir le modèle via `/model`, envoyer un message court, puis un essai d'outil autorisé. Vérifier usage et arrêt du streaming.
5. Attendre l'expiration d'un access token puis répéter ; tester après une nuit et après redémarrage selon les politiques réelles.
6. Si autorisés, essayer Device Code, repli manuel, annulation et port occupé.
7. Tester deux contextes distincts ; vérifier les traces **sans headers sensibles** côté gateways. Changer la destination sous un même provider et confirmer qu'une nouvelle connexion est exigée.
8. Révoquer la session de test dans Keycloak, constater l'erreur de reconnexion, puis se reconnecter. Tester aussi un client sans offline_access accordé.
9. Valider le bundle sur le poste isolé avec accès seulement aux services internes autorisés.

Consigner réussite/échec, versions et paramètres non sensibles selon la politique locale. L'ouverture effective d'un navigateur interactif, le consentement, les mappers audience/rôles et les limites de session sont des validations d'infrastructure ; aucun résultat n'est inventé pour ces points.
