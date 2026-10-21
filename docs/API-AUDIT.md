# Audit des contrats — 21 octobre 2026

## Pi ciblé et vérifications

L'implémentation a été écrite contre **`@earendil-works/pi-coding-agent@1.3.0`** et **`@earendil-works/pi-ai@1.3.0`**, épinglés dans les dépendances de développement et le lockfile. La compatibilité a ensuite été étendue à **toute la série 1.x** (voir « Compatibilité 1.0.0 – 1.3.0 » ci-dessous). Node local : 24.19.0. La cible précédente 0.85.1 a été abandonnée avant implémentation.

Le lien historique `badlogic/pi-mono` redirige vers [earendil-works/pi](https://github.com/earendil-works/pi). Les [custom providers](https://pi.dev/docs/latest/custom-provider) distinguent provider natif et enregistrement historique ; les types et sources **installés en version 1.3.0** sont l'autorité utilisée ici, car `latest` peut évoluer.

| Contrat inspecté dans les packages installés | Conclusion / choix |
|---|---|
| coding-agent `dist/core/extensions/types.d.ts` | `registerProvider(provider: Provider): void` supporté ; factory asynchrone attendue avant sélection des modèles |
| pi-ai `dist/models.d.ts` | `Provider`, `createProvider`, `createModels`, `Models.login/getAuth/streamSimple`, `getModels()` synchrones |
| pi-ai `dist/auth/types.d.ts` | `OAuthAuth.login`, `refresh(credential, signal)`, `toAuth(credential)` ; pas de signatures OpenCode ni du vieux `refreshToken/getApiKey` |
| `ProviderAuthInteraction` | `signal`, `prompt(AuthPrompt)`, `notify(AuthEvent)` ; sélecteur renvoyant un ID, `auth_url`, `device_code`, `manual_code` |
| `OAuthCredential` | `{type:'oauth', access, refresh, expires}` ; `OAuthCredentials` contient `[key:string]: unknown`, autorisant l'empreinte documentée `agentgatewayBinding` |
| pi-ai `dist/auth/resolve.js` | Refresh à moins de cinq minutes ; double vérification sous `CredentialStore.modify` ; délai refresh natif 15 s ; annulation d'un caller ne jette pas une rotation commencée |
| coding-agent `dist/core/auth-storage.js` | Verrou de fichier partagé, lecture de la dernière paire puis écriture ensemble ; ce n'est pas un renommage atomique résistant aux crashs |
| `ModelRuntime` exporté publiquement par coding-agent | `create({authPath,...})`, `registerNativeProvider`, `login`, `getAuth`, `logout`, `listCredentials` utilisés dans les tests de stockage ; pas d'import interne pour l'extension |
| pi-ai `ProviderRequestOptions` | `fetch`, `signal`, `timeoutMs`, `maxRetries`, hooks de payload/réponse/événements disponibles |
| pi-ai `dist/api/openai-*.lazy.d.ts`, `compat.d.ts` | `openAICompletionsApi()` et `openAIResponsesApi()` donnent les implémentations natives de streaming |
| coding-agent `dist/core/extensions/loader.js`, `virtual-modules.js` | Mapping hôte de pi-ai racine et `/compat`. L'import public `/compat` est limité aux fabriques de streaming, afin de fonctionner aussi dans le CLI compilé sans dépendances locales |
| coding-agent `dist/modes/interactive/components/login-dialog.js` | L'événement `auth_url` affiche l'URL et appelle l'ouverture navigateur. Device affiche URI/code ; l'extension ajoute un message durée/intervalle |
| coding-agent `docs/packages.md` | Manifest `pi.extensions`, installation par chemin, modules Pi fournis par l'hôte et peers `*` ; aucun Pi dans `dependencies` de production |

Le provider demeure **natif**, malgré l'import des deux fabriques de streaming depuis l'entrée de compatibilité publique. Le parsing SSE, les outils, le contexte, l'usage et les hooks restent à Pi. L'adaptateur ajoute uniquement les gardes de destination, délais, refus de redirections et messages d'erreur contrôlés. Aucun registre global historique n'est modifié.

La distribution utilise `dist/index.js` et les modules adjacents produits par TypeScript. T17 charge ce résultat avec le **CLI bundle 1.3.0**, pas seulement un mock d'ExtensionAPI. Le package n'embarque ni Pi ni un SDK OpenAI. Le choix des peers `*` suit les instructions du package hôte ; un contrôle runtime (`src/compat.ts`) accepte Pi 1.x et refuse les autres versions majeures.

## Compatibilité 1.0.0 – 1.3.0

Les tarballs publiés de `pi-ai` et `pi-coding-agent` 1.0.0, 1.0.1, 1.0.2, 1.0.3, 1.0.4, 1.1.0, 1.2.0 et 1.3.0 ont été comparés sur les contrats utilisés.

| Contrat | Constat sur 1.0.0 – 1.3.0 |
|---|---|
| `ExtensionAPI.registerProvider(Provider)`, `registerCommand`, `on("session_start")`, `ctx.ui.notify` | Identiques |
| `ModelRegistry.getProviderAuthStatus`, `VERSION` | Identiques |
| `OAuthAuth` (`login`, `refresh`, `toAuth`), `OAuthCredential` | Identiques ; 1.1.0 ajoute seulement un champ optionnel `agentName` |
| `@earendil-works/pi-ai/compat` (`openAICompletionsApi`, `openAIResponsesApi`) | Fichier de types identique ; export présent dès 1.0.0 |
| `virtual-modules.js` (mapping des imports d'extension) | Identique |
| `auth/resolve.js` | **Changement en 1.0.3** : avant, le signal de l'appelant était combiné au signal de refresh, et `modify` n'écrivait pas après annulation |
| `auth-storage.js` | 1.2.0 ajoute des reprises `EPERM` du verrou sous Windows ; sémantique inchangée |
| Dépendances | Paquets `@earendil-works/*` publiés en lockstep ; tests avec toutes les versions sœurs épinglées |

Conséquences : contrôle runtime « Pi 1.x » au lieu d'une version exacte ; échange de token non abandonné une fois envoyé ; rotations conservées en mémoire du processus et réutilisées si Pi ne les a pas enregistrées. Les versions 0.x n'ont pas été évaluées. Une version 2.x est refusée tant que ses API ne sont pas revalidées et ajoutées à `TESTED_PI_VERSIONS`.

## Référence OpenCode

Sources publiques inspectées au commit [`95a9466fd16d506730af7a852d3b5cf1211df5e4`](https://github.com/AyRickk/opencode-keycloak-auth/tree/95a9466fd16d506730af7a852d3b5cf1211df5e4) : README, LICENSE, `src/config.ts`, `src/keycloak.ts`, `src/flows/authcode.ts`, `callback-server.ts`, `device.ts`, `device-poll.ts`, `src/v2/credential.ts`, tests `device-pkce.test.ts` et `v2-refresh.test.ts`. Le registre public annonce `opencode-keycloak-auth@1.0.0` lors de l'inspection.

Comportements retenus : Code + PKCE, callback, Device + PKCE (y compris verifier au polling), scopes offline configurables, rotation et diagnostics de reconnexion. Différences : découverte OIDC réelle au lieu de construction des endpoints ; state obligatoire même en repli manuel ; refus HTTPS/origines/redirections strict ; sérialisation confiée au stockage Pi plutôt qu'un cache OpenCode ; aucun transfert de refresh token ; aucune dépendance `@opencode/*`. Voir [NOTICE](../NOTICE).

Aucune installation de ce plugin n'a été trouvée dans les emplacements npm global et OpenCode usuels vérifiés ; les credentials n'ont pas été consultés. Le package interne de l'entreprise peut différer : version, configuration réelle et disponibilité de Device restent **non vérifiées**. Aucun flux n'est présenté comme testé contre cette infrastructure.

## Décisions de robustesse

Pas de retry LLM sur 401 : on ne peut pas garantir l'absence de traitement distant. Pas de retry automatique d'un refresh tournant après perte de réponse. Pas de calendrier de refresh propre : Pi résout les credentials au prochain appel, y compris après arrêt/reprise. Les tokens plus courts que la fenêtre de cinq minutes peuvent entraîner des refreshs successifs ; ils restent sérialisés par Pi. La découverte est relue à chaque login/refresh, sans cache périmé ni endpoint token persistant.

Les erreurs HTTP/SSE brutes sont masquées pour empêcher un serveur de refléter les secrets dans l'UI/logging de l'hôte. Cette protection masque aussi les messages spécifiques de dépassement de contexte ; l'extension ne prétend donc pas fournir la reconnaissance automatique de toutes les erreurs propriétaires de gateway. Les compteurs de contexte, l'annulation, les outils et les reprises ordinaires de Pi sont conservés et testés.
