# pi-keycloak-agentgateway

Extension **native Pi 1.x** (1.0.0 ou ultérieur) pour connecter plusieurs Agent Gateways avec un client OAuth public Keycloak. Connexion navigateur PKCE S256, callback local, Device Code optionnel avec PKCE, refresh géré par Pi et streaming OpenAI Chat Completions ou Responses.

Node.js **22.19 ou ultérieur** est requis. La version Pi est vérifiée au chargement : toute version **1.x** est acceptée ; une autre version majeure désactive l'extension avec un message explicite jusqu'à validation de ses API. Voir [Compatibilité Pi](#compatibilité-pi). Aucun système d'entreprise ni identifiant réel n'est inclus ou nécessaire aux tests.

## Compatibilité Pi

| Version Pi | Statut |
|---|---|
| < 1.0.0 | Non prise en charge : extension désactivée avec un message |
| 1.0.0 – 1.0.2 | Prise en charge, avec un avertissement au démarrage (voir ci-dessous) |
| 1.0.3 – 1.3.0 | Prise en charge, testée et recommandée |
| 1.x ultérieure | Chargée, avec un avertissement « plus récente que les versions testées » |
| ≥ 2.0.0 | Non prise en charge tant que l'API n'a pas été revalidée |

Les API utilisées (`pi.registerProvider(Provider)`, `OAuthAuth`, `@earendil-works/pi-ai/compat`, `ctx.modelRegistry.getProviderAuthStatus`) sont identiques sur toute la série 1.x. La suite complète de tests (CLI réel compris) est exécutée sur chaque version listée dans `src/compat.ts` :

```sh
npm run test:pi-versions            # toutes les versions testées
npm run test:pi-versions -- 1.0.0   # une version précise
```

**Limite de Pi 1.0.0–1.0.2 :** si une requête est annulée (Échap) pendant un refresh, Pi n'enregistre pas le token renouvelé (corrigé dans Pi 1.0.3). L'extension réutilise ce token en mémoire jusqu'à la fin de la session Pi, mais un redémarrage immédiat imposera un nouveau `/login`. `/agentgateway-doctor` affiche la version de Pi détectée et son statut.

## Installation depuis ce projet

Pi 1.x (1.0.0 ou ultérieur, 1.0.3+ recommandé) doit déjà être installé. Dans un terminal, depuis le dossier du projet :

```sh
npm ci
npm run build
npm test
npm run typecheck
npm run lint
pi install .
```

Sous PowerShell, employer `npm.cmd` et `pi.cmd` si la politique d'exécution bloque les lanceurs `.ps1`. `pi install .` enregistre ce dossier dans les paramètres personnels de Pi ; conserver le dossier à cet emplacement. Pour une exécution ponctuelle : `pi -e ./dist/index.js`. Redémarrer Pi ou utiliser `/reload` après un changement de configuration ou de build.

Créer `~/.pi/agent/keycloak-agentgateway.json` à partir de [l'exemple](examples/keycloak-agentgateway.json), puis remplacer **tous** les placeholders et confirmer les paramètres avec l'administrateur. Ce fichier ne doit contenir aucun secret. Les nombres de l'exemple sont illustratifs. `validated: false` bloque tout appel LLM tant que le modèle n'a pas été vérifié.

Pour conserver le fichier ailleurs :

```sh
export PI_KEYCLOAK_CONFIG=/chemin/absolu/keycloak-agentgateway.json
pi
```

```powershell
$env:PI_KEYCLOAK_CONFIG = 'C:\chemin\keycloak-agentgateway.json'
pi.cmd
```

Les variables doivent être définies dans l'environnement qui lance Pi, pas dans un shell démarré ensuite par l'agent. Si `PI_CODING_AGENT_DIR` est défini, le chemin par défaut est ce dossier, suivi de `keycloak-agentgateway.json`. `PI_KEYCLOAK_CONFIG_JSON` remplace **la totalité** du fichier par un objet JSON de même schéma ; aucune fusion implicite entre contextes. Les mêmes validations s'appliquent. Ne jamais y placer de credentials.

## Parcours de connexion

Dans l'interface interactive de Pi :

1. Exécuter `/agentgateway-doctor` pour vérifier la configuration et la découverte OIDC.
2. Saisir `/login`, choisir **Agent Gateway – mon-contexte**, puis l'option OAuth **Keycloak – Browser (PKCE)**. Si plusieurs méthodes sont activées, choisir la méthode voulue.
3. Pi ouvre le navigateur et affiche le lien. Terminer l'authentification sur Keycloak ; le callback revient sur `127.0.0.1`. Échap annule l'opération. Si le navigateur ne démarre pas, ouvrir le lien affiché sur le même poste.
4. Saisir `/model`, sélectionner le modèle du provider `agentgateway-mon-contexte`, puis envoyer un message court.

`/login` et `/model` sont des commandes **dans Pi**, pas des commandes shell. `pi --list-models agentgateway` liste les modèles disponibles après authentification. L'extension enregistre toujours le catalogue, mais Pi filtre les modèles non authentifiés dans ses sélecteurs.

Pi conserve les credentials dans son `auth.json`, généralement `~/.pi/agent/auth.json`. L'extension retourne un `OAuthCredential` aux API de Pi et n'écrit jamais ce fichier. `/logout` supprime le credential local ; la révocation de la session distante se fait dans Keycloak.

## Préparer Keycloak et les modèles

Faire confirmer l'issuer exact du realm, le client ID **public**, Authorization Code avec PKCE **S256**, les scopes et les éventuels mappers audience/rôles. La redirect URI autorisée doit correspondre exactement à `http://127.0.0.1:49170/callback` ou aux valeurs configurées. Un autre port nécessite la modification correspondante dans Keycloak. `localhost`, les interfaces publiques et le port `0` ne sont pas acceptés.

L'extension lit `<issuer>/.well-known/openid-configuration`. L'issuer retourné doit être identique ; tous les endpoints doivent utiliser HTTPS et la **même origine** que l'issuer. Aucune URL token/device n'est déduite arbitrairement. Les installations utilisant plusieurs origines OAuth nécessitent une adaptation contrôlée de cette politique.

Le contrat Agent Gateway doit être confirmé :

| `api` | Requête envoyée relativement à `baseUrl` |
|---|---|
| `openai-completions` | `POST /chat/completions`, SSE |
| `openai-responses` | `POST /responses`, SSE |

Consulter le catalogue documenté de la gateway (par exemple `/models` **seulement si l'administrateur confirme cet endpoint**), sa configuration interne ou ses responsables. Un catalogue ne prouve pas nécessairement les limites, les capacités vision/raisonnement ni le protocole. Confirmer l'ID, `contextWindow`, `maxTokens`, `input`, `reasoning` et l'API par un essai autorisé ; alors seulement définir `validated: true`. L'extension refuse les identifiants contenant un marqueur évident de placeholder lorsqu'ils sont marqués validés. Elle ne devine aucun modèle et ne récupère pas automatiquement un catalogue.

Les coûts omis sont affichés comme zéro dans Pi, faute de tarif connu ; cela **ne signifie pas** que le service est gratuit. Les coûts configurés utilisent l'unité Pi : par million de tokens. La sélection Sea CLI reste indépendante : déclarer explicitement chaque contexte avec sa gateway, son issuer et son client public. Aucun appel à `sea context list/use`, ni lecture de credentials OpenCode.

## Configuration

Le [schéma JSON](schema/keycloak-agentgateway.schema.json) aide l'éditeur. Le validateur TypeScript applique aussi les contraintes croisées : noms/provider IDs uniques, IDs de modèles uniques par contexte, `maxTokens <= contextWindow`, normalisation HTTPS et absence de secrets/champs inconnus. Une configuration invalide désactive cette extension et laisse Pi fonctionner ; le message est affiché au démarrage et par le diagnostic. Les autres extensions ne sont pas affectées.

| Champ de contexte | Défaut / contrainte |
|---|---|
| `name` | Requis ; 1–64 caractères, minuscules ASCII, chiffres, `_`, `-` ; premier caractère alphanumérique |
| `providerId` | `agentgateway-<name>` ; même format de suffixe ; unique |
| `baseUrl`, `issuer`, `clientId`, `api` | Requis ; URLs HTTPS sans userinfo, query ni fragment ; slash final normalisé |
| `models` | Liste explicite non vide ; champs requis dans l'exemple ; `validated` vaut `false` par défaut |
| `scopes` | `['openid', 'offline_access']` ; dédupliqués, `openid` toujours ajouté. Pour ne pas demander offline, fournir `['openid']` plus les scopes autorisés |
| `callbackHost`, `callbackPort`, `redirectPath` | `127.0.0.1`, `49170`, `/callback` ; port 1–65535, chemin simple |
| `browserTimeoutSeconds` | 300 ; 1–3600 ; flux navigateur/manuellement saisi, échanges compris |
| `deviceTimeoutSeconds` | 600 ; 1–3600, plafonné par l'expiration du code Device |
| `requestTimeoutSeconds` | 10 ; 1–120 ; chaque requête OIDC, lecture du corps comprise |
| `gatewayTimeoutSeconds` | 300 ; 1–3600 ; délai total du streaming |
| `refreshLeewaySeconds` | 30 ; 0–300 ; marge retranchée à l'expiration, plafonnée à 10 % de la durée du token |
| `enableDevice` | `false` ; activer uniquement si le client autorise le grant Device ; endpoint découvert également requis |
| `enableManual` | `false` ; activer après confirmation de la redirect URI autorisée |
| `reuseRefreshTokenWhenOmitted` | `false` ; `true` seulement si le contrat du serveur garantit que l'ancien refresh reste valide quand le champ est absent |

À la racine, `logLevel` accepte `error`, `warn` (défaut), `info`, `debug`. Les logs sont des événements prédéfinis sans corps, URL OAuth, credentials ou exceptions brutes. `$schema` est facultatif ; adapter son chemin si l'exemple est copié ailleurs.

Les surcharges `models.json` de destination ou d'API sont refusées à l'envoi. Modifier `baseUrl`, `issuer`, `clientId`, `providerId`, API ou scopes nécessite une nouvelle connexion : une empreinte lie le credential à ces paramètres, avant refresh comme avant dérivation du Bearer. Ne pas modifier les credentials à la main.

## Device Code et repli manuel

Avec `enableDevice: true` et un endpoint disponible, `/login` propose **Keycloak – Device Code (PKCE)**. Le lien, le code utilisateur, la durée et l'intervalle sont affichés. Le polling respecte `authorization_pending`, augmente l'intervalle de 5 secondes après `slow_down`, ralentit après une panne réseau et s'arrête sur refus, expiration, timeout ou annulation. Le challenge S256 est envoyé à l'autorisation Device, puis le verifier au token endpoint : ce comportement est couvert dans le plugin de référence. Sa compatibilité avec le client de l'entreprise reste à vérifier.

Avec `enableManual: true`, la méthode manuelle ouvre une autorisation PKCE **sans listener**. Après authentification, copier l'**URL complète** de redirection locale dans Pi, même si le navigateur affiche une erreur de connexion. Un code seul n'est pas accepté : l'extension doit vérifier le `state`, l'origine et le chemin. Sur SSH, ne choisir ce mode que si cette procédure est autorisée ; préférer Device Code lorsqu'il est disponible. Ne jamais partager l'URL copiée. Si le port est occupé, seules les alternatives explicitement activées sont proposées.

## Refresh, rotation et inactivité

Pi vérifie les credentials à chaque résolution d'authentification. À moins de cinq minutes de validité, il appelle `oauth.refresh` sous le verrou du credential store, puis enregistre ensemble access/refresh avant de libérer le verrou. La vérification est répétée sous verrou. Depuis Pi 1.0.3, une annulation de l'appel LLM ne jette pas un refresh déjà commencé : Pi le laisse terminer et persister. Une fois la requête token envoyée, l'extension la laisse aboutir dans son propre délai (`requestTimeoutSeconds`) plutôt que de l'abandonner. Elle garde aussi en mémoire, pour la session, les rotations obtenues : si Pi n'a pas enregistré le résultat (Pi 1.0.0–1.0.2 après annulation), le refresh suivant réutilise ce résultat au lieu de rejouer un refresh token déjà révoqué. Ces garanties sont testées avec le runtime réel de chaque version supportée.

`expires` est un timestamp Unix en **millisecondes**, calculé à partir du début de l'échange, de `expires_in` et de la marge configurée. Le refresh renvoyé remplace le précédent. Un login sans refresh token est refusé, sans credential partiel. Le refresh ne fait pas de retry aveugle, car le serveur peut avoir tourné le token même si la réponse a été perdue. Les access tokens plus courts que cinq minutes peuvent conduire Pi à rafraîchir plus fréquemment, toujours sous verrou.

Une reprise après une nuit fonctionne si le refresh reste autorisé. Demander `offline_access` ne garantit pas son octroi : consentement, client scopes et politiques du realm s'appliquent. Les offline tokens restent soumis aux limites **Offline Session Idle** et, si activée, **Offline Session Max**, ainsi qu'à la révocation et à la rotation. Sans accès offline, les limites de session ordinaires peuvent nécessiter `/login`. Voir le [guide Keycloak](https://www.keycloak.org/docs/latest/server_admin/index.html#_offline-access). Aucune connexion quotidienne n'est promise indépendamment de ces politiques.

Les sessions Pi et OpenCode sont indépendantes. Ne pas copier leurs refresh tokens, même entre deux fichiers utilisateurs : le premier refresh peut invalider le token partagé.

## Diagnostic et dépannage

`/agentgateway-doctor` affiche la version de Pi et son statut de compatibilité, puis vérifie la configuration chargée, la découverte OIDC, l'écart approximatif de l'horloge d'après le header HTTP `Date`, les modèles déclarés et un `HEAD` **anonyme** vers `baseUrl`. Il indique si Pi possède un credential configuré, sans en vérifier la validité ni déclencher de refresh. Un `401`, `403` ou `405` sur ce HEAD ne démontre pas une panne. Aucun prompt ni token n'est envoyé par le diagnostic. L'écart `Date` reste indicatif (latence/proxy) ; vérifier NTP pour confirmer.

| Symptôme | Action |
|---|---|
| Provider absent | Vérifier Pi 1.x (`pi --version`), `pi list`, chemin du package, configuration, puis `/reload` |
| Modèle absent de `/model` | Effectuer `/login` pour son provider ; vérifier ID et contexte |
| Modèle non validé | Confirmer protocole/capacités/limites puis `validated: true` et `/reload` |
| Issuer introuvable/incohérent | Vérifier l'URL exacte du realm et sa découverte ; ne pas utiliser une URL de console admin |
| `invalid_client`, `unauthorized_client` | Vérifier client public, client ID et grant autorisé |
| `invalid_request`, page Keycloak refusant la redirection | Vérifier la redirect URI exacte et PKCE S256 ; un refus avant callback peut terminer en timeout dans Pi |
| Port callback occupé | Libérer le port ou en configurer un autorisé ; choisir un repli explicitement activé |
| État OAuth invalide | Abandonner la tentative ; refaire `/login`, sans réutiliser un ancien lien |
| Device absent/refusé | Vérifier `enableDevice`, découverte et autorisation du client ; ne pas supposer le grant disponible |
| `invalid_grant` | Session expirée/révoquée ou refresh partagé : refaire `/login`, examiner politiques offline/rotation |
| Gateway 401/403 | Vérifier audience, rôles, contexte, révocation et horloge avec l'administrateur |
| Gateway 404 | Confirmer ID du modèle et contrat `/chat/completions` ou `/responses` |
| Redirection gateway | Configurer directement l'URL canonique autorisée ; toutes les redirections sont refusées |
| Configuration du contexte modifiée | Refaire `/login` pour lier de nouveaux credentials |
| TLS/réseau | Installer la CA interne dans la confiance Node/système selon la procédure locale ; ne jamais désactiver la vérification TLS |

Les erreurs HTTP et SSE brutes sont masquées. Les diagnostics de transport restent contrôlés. Aucun retry LLM automatique n'est ajouté par l'extension, y compris sur 401, pour éviter de rejouer une requête déjà traitée. Les éventuelles politiques de reprise générales de Pi restent celles de Pi. Pi encapsule les erreurs OAuth dans `ModelsError` tout en conservant notre message explicatif ; l'erreur de révocation indique de refaire `/login`.

## Distribution npm, réseau interne et installation hors ligne

Le package n'est pas publié automatiquement. Après publication **autorisée** dans le registre choisi, installer avec `pi install npm:pi-keycloak-agentgateway@1.0.0`. Configurer le registre et les certificats d'entreprise via les mécanismes npm/Node habituels, par exemple `npm_config_registry` ; ne pas commettre de token de registre. Les dépendances Pi sont fournies par l'hôte, déclarées en peers conformément au [format de package Pi](https://pi.dev/docs/latest/packages).

Produire une archive sur une machine disposant des dépendances de build :

```sh
npm ci
npm run ci
npm run bundle:offline
```

Le fichier `artifacts/pi-keycloak-agentgateway-1.0.0.tgz` contient le JavaScript compilé, les types, l'exemple, le schéma et la documentation. Un fichier adjacent `.tgz.sha256` contient sa somme de contrôle. Aucune dépendance d'exécution supplémentaire n'est nécessaire au-delà de Pi et Node. Le lockfile épingle les dépendances de développement. Le cache `.npm-cache` reste local et non distribué.

Transférer l'archive par le canal autorisé, vérifier sa somme SHA-256, puis l'extraire dans un dossier durable sur le poste cible, où Pi 1.x doit déjà être provisionné :

```sh
mkdir pi-keycloak-agentgateway
tar -xzf pi-keycloak-agentgateway-1.0.0.tgz -C pi-keycloak-agentgateway
pi install ./pi-keycloak-agentgateway/package
```

Ces commandes fonctionnent aussi sous PowerShell avec `pi.cmd` et `tar.exe`. **Ne pas lancer `npm install` dans le dossier extrait** : Pi fournit ses modules au chargement. Le test T17 effectue cette installation avec les accès réseau bloqués et sans `node_modules` dans l'archive. Ne pas donner directement le `.tgz` à `pi install` : la procédure validée utilise le dossier extrait.

Pour éviter les recherches réseau de catalogue par Pi lui-même, lancer avec `PI_OFFLINE=1`. Cela ne supprime pas le besoin d'accès au Keycloak et à la gateway du réseau interne lors du login et du chat. Recompiler les sources en environnement isolé exige un registre npm interne ou un cache de **toutes** les dépendances de développement ; ce cache n'est pas nécessaire pour installer le tarball précompilé.

## Validation et limites

`npm run ci` exécute TypeScript, lint/format et les tests. La CI déclare Linux/Windows et Node 22/24 ; les résultats locaux ne prouvent pas à eux seuls les autres combinaisons. La [matrice T01–T20](docs/TESTS.md) précise les tests automatisés et le parcours E2E à exécuter sur une instance autorisée.

Lire [l'audit des API Pi et OpenCode](docs/API-AUDIT.md) et [SECURITY.md](SECURITY.md) avant le déploiement. L'issuer, le client, les scopes d'audience, le contrat de gateway et le catalogue internes restent à confirmer. La version du package OpenCode effectivement utilisée dans l'entreprise n'était pas disponible pour comparaison ; l'implémentation suit les sources publiques inspectées. L'intégration automatique Sea CLI V2 est volontairement hors périmètre tant qu'un contrat stable n'est pas documenté.
