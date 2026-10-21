# Sécurité

Cette extension traite des credentials OAuth. Toute extension Pi s'exécute avec les droits du processus et doit être considérée comme du code de confiance. Faire examiner le package et ses mises à jour par l'organisation avant diffusion.

## Garanties de l'extension

- Client public uniquement. Aucun champ username/password/client secret, aucun password grant, aucune lecture des credentials OpenCode.
- State aléatoire, PKCE S256 et verifier propres à chaque tentative ; vérification du state avant tout code ou erreur de callback. En mode manuel, URL complète obligatoire.
- Découverte HTTPS, issuer exact et endpoints limités à son origine. Pas de redirections OIDC ; aucune option permettant de contourner TLS ou PKCE.
- Listener uniquement sur `127.0.0.1`, port/chemin explicites, réponses sans code/token, fermeture après succès, refus, timeout, annulation ou erreur.
- Les credentials portent `agentgatewayBinding`, empreinte SHA-256 de provider ID, gateway, issuer, client ID, API et scopes. Le type public `OAuthCredentials` de Pi accepte les données propres au provider. Une empreinte manquante/différente interdit refresh et dérivation d'authentification jusqu'à un nouveau `/login`. Elle n'est pas une signature contre un attaquant local capable de modifier `auth.json`.
- Le Bearer est l'access token, jamais le refresh. Le transport vérifie l'endpoint HTTPS exact, retire cookies et proxy-authorization, force le Bearer résolu et bloque toutes les redirections. Les surcharges de destination des modèles sont rejetées.
- Le parseur JSON OAuth limite les corps à 64 Kio ; les requêtes et listeners ont des délais. Les erreurs serveur, leurs descriptions, les exceptions réseau et les erreurs SSE brutes ne sont pas journalisées.
- Le logger accepte seulement des événements fixes. Les codes Device et les URLs d'autorisation apparaissent uniquement dans l'interaction de login nécessaire à l'utilisateur. Ne pas capturer ce dialogue dans un enregistrement partagé.
- Aucun retry OAuth aveugle, ni rejeu LLM ajouté par l'extension sur 401. Une réponse de refresh perdue peut nécessiter `/login` si le serveur a déjà tourné le token.

## Stockage, postes et administrateurs

`~/.pi/agent/auth.json` (ou le dossier agent personnalisé) contient des **secrets en clair**. Pi en est le gestionnaire ; l'extension ne l'ouvre pas et ne l'écrit pas. Les tests de persistance utilisent des fichiers temporaires et des tokens synthétiques par les API Pi.

Sur Unix, restreindre le fichier à `0600` et son dossier à l'utilisateur. Sur Windows, vérifier les ACL pour limiter l'accès au compte concerné et aux administrateurs autorisés. Pi applique un mode restrictif à la création, mais des modes/ACL déjà présents, sauvegardes et politiques de synchronisation doivent être vérifiés. Exclure ce fichier des dépôts, sauvegardes non chiffrées, collecteurs de logs et tickets d'assistance. Ne jamais envoyer un dump d'authentification pour diagnostic.

Pi 1.x sérialise la mutation de credentials via un verrou de fichier et écrit access/refresh ensemble. Son implémentation utilise `writeFileSync` sous verrou, **sans remplacement par renommage atomique** : l'extension ne peut pas promettre une résistance à une coupure disque/processus au milieu de cette écriture. Elle respecte l'API de stockage publique ; améliorer la durabilité physique relève de Pi. Le crash après rotation distante et avant persistance est également une limite inhérente au protocole. Pi 1.0.0–1.0.2 abandonne en outre l'écriture lorsque l'appel est annulé pendant le refresh : l'extension conserve alors la rotation **en mémoire du processus uniquement** (indexée par l'empreinte SHA-256 du refresh token remplacé, 16 entrées au maximum) pour ne pas rejouer un token révoqué. Rien n'est écrit sur disque par l'extension ; après redémarrage, un nouveau `/login` est nécessaire.

L'empreinte empêche les confusions accidentelles entre contextes. Elle ne remplace pas la validation JWT côté gateway (signature, issuer, audience, rôles, expiration). Les ID tokens ne sont ni consommés pour établir une identité locale ni enregistrés. Les access tokens sont traités comme opaques ; aucune prétention de validation cryptographique locale.

Les modèles marqués `validated: true` expriment une validation humaine préalable, pas une découverte automatique des capacités. Aucun endpoint interne ni paramètre secret ne doit être publié dans les exemples. Le fichier de configuration, bien que sans secrets, reste sensible pour son intégrité : protéger ses droits d'écriture et les variables d'environnement de Pi.

Le diagnostic n'envoie aucun token mais contacte les origines configurées. Les erreurs de succès métier, prompts, réponses et hooks de streaming restent traités par Pi et les autres extensions de confiance. Ce package ne contrôle pas leurs journaux, la télémétrie de l'hôte ni les journaux de la gateway.

## Signalement

Signaler une vulnérabilité au mainteneur ou au canal privé désigné par l'organisation. Inclure version Pi/package, scénario reproductible synthétique et messages nettoyés ; ne pas joindre de JWT, refresh token, cookie, code, URL de callback complète ni fichier `auth.json`. Aucun canal de signalement externe n'est préconfiguré dans ce projet.
