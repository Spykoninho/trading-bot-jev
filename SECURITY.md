# Politique de sécurité

Ce bot peut manipuler des clés API d'exchange (lecture de marché, passage d'ordres, et potentiellement retraits selon la configuration de la clé). Une fuite de clé ou une faille du code peut donc avoir un impact financier direct.

## Signaler une vulnérabilité

Merci de **ne pas ouvrir d'issue publique**. Signalez toute faille via l'onglet [Security advisories](https://github.com/Spykoninho/trading-bot-jev/security/advisories) du dépôt GitHub, en privé.

## Bonnes pratiques pour vos clés API

- Créez une clé dédiée à ce bot, avec les droits **spot uniquement**.
- **Désactivez les retraits** sur cette clé.
- Activez la **liste blanche d'IP** si votre exchange le permet.
- Ne commitez jamais votre fichier `.env` (il est déjà dans `.gitignore`) ni vos clés en clair ailleurs dans le dépôt.
