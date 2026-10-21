# Spécification technique — Extension Pi Keycloak OAuth pour Agent Gateway

**Statut :** prêt pour implémentation par Codex  
**Langue :** français  
**Nom de travail :** `pi-keycloak-agentgateway`  
**Objectif :** remplacer l'authentification OpenCode `opencode-keycloak-auth` par un provider Pi natif offrant OAuth/OIDC Keycloak, PKCE, refresh automatique et sélection de contextes Agent Gateway.

> **Instruction à Codex :** implémente ce projet de bout en bout, tests inclus. Inspecte d'abord les versions installées des API Pi et du plugin OpenCode de référence ; ne devine aucune signature TypeScript. Lorsqu'une information d'infrastructure manque (issuer, client ID, modèles, scopes, contextes), rends-la configurable et fournis un exemple avec placeholders, sans inventer de valeur réelle.

## 1. Contexte et références

Configuration OpenCode actuelle observée :

- Plugin `opencode-keycloak-auth@latest`.
- Provider `agentgateway-<context_name>`.
- URL de gateway `https://agentgateway.{WORKSPACE}.{TENANT}.naval-group.dev/v1`.
- Authentification Keycloak par navigateur, Authorization Code + PKCE S256, callback local automatique.
- Authentification par contexte Sea CLI, notamment `sea context list` et `sea context use`.
- Refresh token géré par OpenCode sans recréer manuellement les JWT courts (ancien flux `sea ai token create`).

**Sources de référence à examiner avant implémentation :**

1. Plugin : https://github.com/AyRickk/opencode-keycloak-auth
2. Pi, custom providers : https://pi.dev/docs/latest/custom-provider
3. Pi, extensions : https://pi.dev/docs/latest/extensions
4. Pi, dépôt principal : https://github.com/badlogic/pi-mono (vérifier repo et packages réellement utilisés par la version cible)

**Attention :** les API de Pi évoluent. La documentation actuelle distingue un **provider natif** complet et une forme historique `pi.registerProvider(name, ProviderConfig)`. Choisir la variante supportée par la version cible ; privilégier le provider natif si elle supporte explicitement l'authentification OAuth. Ne pas porter aveuglément du code OpenCode ni importer ses API dans Pi.

## 2. Livrables demandés

- Package TypeScript d'extension Pi, installable localement et distribuable en package npm/tarball.
- Enregistrement d'un provider Pi par contexte : `agentgateway-<context_name>`.
- Flux `/login` natif de Pi : `Keycloak – Browser (PKCE)` ; si faisable, `Device Code` et saisie de code manuelle en repli.
- Appels LLM vers l'endpoint Agent Gateway avec `Authorization: Bearer <access_token>`.
- Sauvegarde par Pi des credentials OAuth dans `~/.pi/agent/auth.json` **via ses APIs**, jamais par écriture directe en fonctionnement normal.
- Renouvellement automatique du token, y compris après arrêt/reprise et longues périodes d'inactivité.
- Configuration multi-contextes, modèles, issuer, clientId, scopes, callback et timeouts.
- README de mise en route, documentation de sécurité et dépannage.
- Tests unitaires et d'intégration avec mock Keycloak et mock OpenAI-compatible gateway.
- Build reproductible, validation TypeScript, lint et CI.

## 3. Exigences fonctionnelles

### F01 — Configuration

L'extension doit accepter un fichier non sensible tel que `~/.pi/agent/keycloak-agentgateway.json` (nom configurable si l'API Pi le recommande), ainsi qu'une éventuelle surcharge par variables d'environnement. Exemple *indicatif*, à valider/adapter dans le code :

```json
{
  "contexts": [
    {
      "name": "mon-contexte",
      "providerId": "agentgateway-mon-contexte",
      "baseUrl": "https://agentgateway.WORKSPACE.TENANT.naval-group.dev/v1",
      "api": "openai-completions",
      "issuer": "https://keycloak.example.internal/realms/agents",
      "clientId": "client-public-a-renseigner",
      "scopes": ["openid", "offline_access"],
      "callbackHost": "127.0.0.1",
      "callbackPort": 49170,
      "redirectPath": "/callback",
      "browserTimeoutSeconds": 300,
      "models": [
        {
          "id": "ID_MODELE_A_RENSEIGNER",
          "name": "Modèle Agent Gateway",
          "contextWindow": 128000,
          "maxTokens": 8192,
          "input": ["text"],
          "reasoning": false
        }
      ]
    }
  ]
}
```

Les capacités, les tailles de contexte et les API exactes des modèles ci-dessus sont **illustratives** : ne pas les présumer correctes. Documenter comment récupérer les modèles réels (catalogue de la gateway, configuration interne, ou déclaration manuelle). Interdire la mise en production tant que l'identifiant et les limites du modèle ne sont pas validés. Ne jamais enregistrer de mot de passe, client secret, access token ou refresh token dans ce fichier.

Validation stricte : IDs uniques, noms de contexte sûrs, URL HTTPS de la gateway et de l'issuer, exceptions HTTP limitées au callback loopback, ports valides, scopes dédupliqués, schéma de configuration documenté, erreurs explicites. Les valeurs et domaines affichés dans les captures ne constituent pas des endpoints OAuth confirmés.

### F02 — Registration Pi

Enregistrer chaque `providerId` avec l'URL de la gateway, l'API de streaming compatible et les modèles déclarés. Choisir entre `openai-completions` et `openai-responses` après vérification du contrat réellement exposé ; fournir un mécanisme de configuration pour les deux si la version de Pi les accepte. Ne pas réimplémenter la couche streaming quand Pi sait déjà parler le protocole. Le provider doit apparaître dans `/model` et dans la liste des choix de `/login`.

### F03 — OAuth Authorization Code + PKCE

- Déclencher l'authentification via `/login` du provider Pi.
- Charger `/.well-known/openid-configuration` à partir de l'issuer configuré, vérifier l'issuer retourné et les endpoints ; ne jamais composer arbitrairement les URLs en production.
- Générer `state` et `code_verifier` cryptographiquement aléatoires, créer un `code_challenge` S256.
- Ouvrir l'authorization URL au navigateur via les callbacks Pi disponibles.
- Démarrer un serveur HTTP **uniquement sur 127.0.0.1** avec chemin et port configurés, vérifier strictement `state`, gérer `error`/`error_description` et échanger le code avec le token endpoint.
- Respecter `redirect_uri` à l'octet près entre l'autorisation et le token exchange.
- Limiter la durée de vie du listener, fermer systématiquement après succès, annulation, timeout ou échec.
- En cas de navigateur absent ou port indisponible, proposer une méthode alternative seulement si la configuration Keycloak l'autorise.
- Client OAuth public, pas de client secret. Utiliser les méthodes prises en charge par l'IdP, jamais de Resource Owner Password grant.

### F04 — Device Authorization Grant (souhaité pour V1)

- Utiliser `device_authorization_endpoint` de la découverte OIDC si disponible.
- Afficher `verification_uri`, `user_code`, expiration et intervalle via les callbacks Pi.
- Respecter `authorization_pending`, `slow_down`, intervalle, timeout, annulation et erreurs OAuth.
- Ne pas promettre le mode device si Keycloak ou le client ne l'autorise pas.
- Vérifier dans le plugin de référence si le déploiement Keycloak requiert PKCE pour le device flow et adapter l'implémentation selon les capacités réellement constatées.

### F05 — Stockage et refresh

- Retourner à Pi ses credentials au format attendu par **la version installée** : typiquement `{ access, refresh, expires }`, où `expires` est un timestamp Unix en **millisecondes**.
- Le stockage standard est `~/.pi/agent/auth.json`. Ne jamais modifier manuellement ce fichier à l'exécution ; confier les écritures au credential manager de Pi.
- Utiliser `refreshToken(credentials)` et `getApiKey(credentials)` (ou l'équivalent du provider natif actuel) : `getApiKey` doit fournir l'access token, pas le refresh token.
- Actualiser les tokens avant expiration avec une marge appropriée, en s'appuyant d'abord sur le mécanisme natif Pi.
- Important : gérer les refresh tokens tournants. Si Pi ne sérialise pas déjà les refreshs, implémenter un verrou/dédoublonnage **par provider et refresh token** ; persister atomiquement la paire nouvel access/refresh par les API Pi.
- Préserver la valeur précédente du refresh token si le serveur n'en renvoie pas de nouveau **uniquement si le contrat du serveur le permet**.
- Gérer `invalid_grant`, invalidation/révocation, horloge décalée, panne réseau, 401 gateway, erreurs transitoires et longue inactivité sans boucle infinie.
- En cas d'expiration définitive du refresh token : afficher une erreur claire avec instruction de refaire `/login`, ne jamais redemander les identifiants en boucle.
- `offline_access` doit être configurable (par défaut demandé si autorisé), sans supposer qu'il sera accordé. Expliquer les politiques Keycloak *Offline Session Idle/Max*, consentement et rotation.
- Pas de partage silencieux du même refresh token entre Pi et OpenCode ; connexion indépendante par défaut.

### F06 — Contextes Sea CLI

- Supporter plusieurs contextes simultanément, chaque contexte ayant un provider ID et des credentials isolés.
- Ne **pas** présumer du format interne ni d'une API machine-readable de `sea context list/use`. V1 : déclaration explicite des contextes dans la configuration Pi.
- Fonctionnalité optionnelle V2 : détecter le contexte courant via Sea CLI si un contrat de sortie stable est documenté et testé ; fournir un mapping explicite nom -> WORKSPACE/TENANT/gateway/providerId.
- Un changement de contexte ne doit jamais envoyer un access token au domaine d'un autre contexte.
- Désactiver ou avertir clairement si la configuration change de baseUrl/issuer/clientId sous un même provider ID avec des credentials persistés.

### F07 — Appel gateway et streaming

- Utiliser le runtime Pi pour les requêtes LLM. Injection `Bearer` du token valide sur la requête à l'hôte exact de la gateway configurée.
- Ne jamais faire fuiter l'Authorization header lors d'une redirection inter-origine.
- Conserver les comportements Pi de streaming, tool calls, annulation, contexte et reprise ; si une API Pi nécessite un adaptateur, limiter la modification au strict nécessaire et couvrir les cas par tests.
- En cas de 401, ne déclencher au maximum qu'un refresh/retry contrôlé si cela est sûr pour les requêtes, puis remonter une erreur exploitable.

### F08 — Exploitabilité

- Logs `error/warn/info/debug` sans token, code, verifier, cookies ni body de réponse sensible.
- Messages lisibles : issuer introuvable, mauvais clientId, redirect URI non autorisée, callback occupé, état OAuth invalide, device non activé, `invalid_grant`, erreur audience/roles, modèle inconnu.
- Commande ou script de diagnostic non intrusif : configuration valide, découverte OIDC, modèles connus, statut authentifié (sans secrets), horloge et accessibilité gateway.
- Documentation installation en ligne et hors ligne (réseau npm interne / environnement on-prem) ; aucune dépendance externe obligatoire si l'implémentation avec APIs standards est possible.

## 4. Architecture cible

```text
Pi (/login, /model, chat)
    |
    +-- Extension TypeScript pi-keycloak-agentgateway
    |      +-- configuration/context registry
    |      +-- pi.registerProvider(...) par contexte
    |      +-- OIDC discovery + Authorization Code/PKCE
    |      +-- device authorization (si supporté)
    |      +-- refresh coordination
    |
    +-- Gestionnaire d'authentification Pi
    |      +-- ~/.pi/agent/auth.json (géré par Pi)
    |
    +-- HTTPS Agent Gateway /v1
                +-- validation Keycloak JWT (aud/roles côté gateway)
                +-- modèles OpenAI-compatibles
```

Structure de code recommandée (modifiable si l'écosystème Pi l'exige) :

```text
src/index.ts                 # point d'entrée Pi et registerProvider
src/config.ts                # parsing, validation, contexte
src/oidc/discovery.ts        # découverte et validation des endpoints
src/oidc/pkce.ts             # code_verifier/challenge/state
src/oidc/browser.ts          # listener loopback + auth code
src/oidc/device.ts           # grant device
src/oidc/tokens.ts           # échange, refresh, rotation, timeouts
src/provider.ts              # adaptateur provider Pi
src/logging.ts               # redaction
src/diagnostics.ts           # validation sans secrets
tests/*.test.ts
examples/keycloak-agentgateway.json
README.md
SECURITY.md
package.json
```

## 5. Contrats et API : instructions de validation à Codex

Avant de coder, inspecter **l'API réelle** de la version cible de Pi :

1. Signature `ExtensionAPI` et `pi.registerProvider`.
2. Forme recommandée d'un provider natif vs `ProviderConfig` historique.
3. Typages OAuth (login, refreshToken, getApiKey, callbacks, cancellation/AbortSignal).
4. Moment où Pi rafraîchit les credentials et garantie de sérialisation du stockage.
5. Définition des modèles, baseUrl et API IDs (`openai-completions`, `openai-responses`).
6. Méthode d'installation/rechargement d'une extension depuis un fichier ou package.

Ne **pas** supposer que `/login <provider>` fonctionne comme une commande shell : documenter l'interface interactive réelle et vérifier le parcours. Ne pas ajouter de champs non reconnus dans `~/.pi/agent/auth.json`. Éviter la dépendance aux structures internes non publiques de Pi.

## 6. Compatibilité avec le plugin OpenCode de référence

Lire au minimum README, fichiers `src/` OAuth et tests du dépôt de référence. Identifier et porter les comportements, pas le couplage OpenCode :

- OAuth Code + PKCE S256, callback loopback et éventuel fallback manuel.
- Device flow.
- Découverte OIDC, validation de la config.
- Marge d'expiration et anti-double refresh sur rotation.
- Gestion des scopes `openid` et `offline_access`.
- Messages de diagnostic utiles.

Ne pas importer les modules `@opencode/*` dans le package Pi. Respecter la licence MIT du projet source et conserver les notices de copyright pertinentes si du code est copié/adapté. Vérifier également le code correspondant à la version effective utilisée dans l'entreprise (le package interne peut différer du dépôt public).

## 7. Sécurité (critères bloquants)

1. Aucune collecte de username/password ni client secret ; OAuth public + PKCE.
2. Vérification de `state` et de la réponse OIDC ; endpoints OAuth HTTPS validés contre l'issuer configuré.
3. Listener HTTP seulement sur loopback ; fermer à chaque sortie de flux.
4. Aucune journalisation de secrets, codes d'autorisation, PKCE verifier, Authorization header ou dumps `auth.json`.
5. Restrictions des hôtes où le Bearer peut être envoyé ; zéro fuite en redirections inter-domaines.
6. Validation des noms/URL provenant des contextes Sea ; pas d'injection de commande shell.
7. Ne pas lire les credentials OpenCode par défaut et ne pas transférer des refresh tokens entre applications.
8. Expliquer que `~/.pi/agent/auth.json` est sensible : permissions restrictives (idéalement `0600`) et exclusion des sauvegardes/logs non sécurisés ; utiliser les API Pi pour écrire.
9. Ne pas contourner TLS, ignorer la vérification des certificats ou désactiver PKCE.
10. Respecter les règles de publication du code et des paramètres d'infrastructure internes : exemples avec placeholders uniquement.

## 8. Matrice de tests

| ID | Scénario | Résultat attendu |
|---|---|---|
| T01 | Config valide + plusieurs contextes | Providers distincts visibles dans Pi |
| T02 | Config issuer/clientId manquante | Erreur compréhensible, sans crash global |
| T03 | Login navigateur PKCE | Callback validé, credentials Pi persistés |
| T04 | State incorrect | Login rejeté, aucun token stocké |
| T05 | Timeout/cancel du login | Listener fermé, pas de credential partiel |
| T06 | Callback port occupé | Erreur ou méthode alternative claire |
| T07 | Device flow `authorization_pending`/`slow_down` | Polling conforme, fin sur succès ou timeout |
| T08 | Token expirant bientôt | Refresh automatique, Bearer nouveau |
| T09 | Deux refresh simultanés avec rotation | Un échange effectif, état cohérent |
| T10 | Pi redémarré après une nuit | Refresh sans login si token encore valide |
| T11 | Refresh définitivement révoqué (`invalid_grant`) | Échec explicite et invitation à se reconnecter |
| T12 | Deux contextes distincts | Aucune confusion de credentials ou d'URL |
| T13 | Gateway OpenAI-compatible streaming | Réponse/usage/tool calls reçus correctement |
| T14 | Redirection hors domaine | Aucun Bearer envoyé à la destination |
| T15 | Auth serveur indisponible | Erreur bornée, pas de retry infini |
| T16 | Logs en debug | Aucun secret/token/code/verifier détectable |
| T17 | Installation offline depuis bundle local | Pi charge l'extension sans accès au registre |
| T18 | OIDC metadata issuer incohérent | Connexion rejetée |
| T19 | Token réponse sans refresh token | Comportement conforme au contrat Pi/Keycloak |
| T20 | Aucun `offline_access` accordé | Explication correcte des limites de session |

Tests sans accès aux systèmes de l'entreprise : serveurs factices localhost pour OIDC/token/gateway, horloge simulée, tokens et secrets synthétiques. Prévoir un test manuel E2E sur une instance autorisée de test uniquement.

## 9. Critères d'acceptation / Definition of Done

- `npm ci && npm run build && npm test && npm run typecheck` passent (adapter aux scripts fournis).
- Sur Pi compatible, l'extension est chargée sans patch du core et enregistre un ou plusieurs providers.
- `/login` permet le parcours navigateur PKCE avec Keycloak et crée les credentials via Pi.
- `/model` permet de choisir un modèle déclaré du bon contexte.
- Un appel à la gateway utilise le bon access token ; streaming compatible.
- Expiration d'access token et rotation du refresh token ne nécessitent pas de login quotidien tant que la session Keycloak reste valide.
- Les déconnexions définitives sont détectées et documentées ; aucun token n'est exposé.
- Tests T01–T20 couverts ou explicitement marqués comme tests E2E manuels avec justification.
- README avec installation, config type, login, troubleshooting, sécurité, limitations et procédure offline.
- Aucun endpoint interne réel, identifiant ou secret dans le dépôt.

## 10. Phasage proposé

**P0 — cadrage :** vérifier API Pi et code source OpenCode ; produire une courte note des différences et dépendances.

**P1 — MVP :** config multi-contextes, provider registration, login navigateur PKCE, stockage Pi, refresh, modèle et streaming OpenAI-compatible, tests critiques.

**P2 — robustesse :** device flow, fallback manuel, diagnostic, déduplication du refresh, erreurs avancées, packaging offline.

**P3 — ergonomie optionnelle :** intégration Sea CLI documentée, découverte de modèles si endpoint existant, commandes de statut non sensibles.

## 11. Prompt de lancement pour Codex

> Implémente le projet décrit dans ce fichier en TypeScript. Commence par examiner la version réellement installée des packages Pi et la documentation officielle du custom provider ; inspecte également le dépôt GitHub `AyRickk/opencode-keycloak-auth` pour comprendre le flux Keycloak. Réalise un MVP fonctionnel, puis les cas de robustesse et la suite de tests. N'invente pas d'issuer, de clientId, de modèle ou d'endpoint interne : utilise la configuration et des placeholders. N'accède pas aux credentials OpenCode et laisse Pi gérer `auth.json`. N'ajoute jamais de logs contenant des secrets. Exécute les tests et livre un README permettant à un utilisateur de réaliser `/login`, `/model` et un appel gateway. Documente toute fonctionnalité non vérifiée plutôt que de la présenter comme opérationnelle.

---

### Notes de validation / points encore inconnus

- Issuer exact du Keycloak de l'organisation.
- Client ID public et redirect URIs autorisées.
- Scopes supplémentaires pour audience `aud` et rôles gateway.
- Catalogue et contrat OpenAI réel de l'Agent Gateway.
- Contrat stable (ou non) de Sea CLI pour les contextes.
- Version précise de Pi choisie pour le projet.

**Ces éléments doivent rester configurables et être confirmés en environnement autorisé avant mise en production.**
