# Déployer le bot sur un serveur (Docker)

Le bot tourne dans un conteneur qui redémarre seul. Le tableau de bord n'a pas d'authentification :
il n'est publié que sur `127.0.0.1` du serveur et se consulte par tunnel SSH. N'ouvre jamais le port 3210.

## Installation

```bash
git clone https://github.com/Spykoninho/trading-bot-jev.git && cd trading-bot-jev
mkdir -p data
```

Crée un fichier `.env` lisible par toi seul (`chmod 600 .env`) :

```bash
# id -u et id -g du propriétaire du dossier data/
BOT_UID=1000
BOT_GID=1000
# Vide = portefeuille papier ; --real = vrais ordres sur Bitvavo
BOT_FLAGS=

TYPESAFE_API_KEY=

# Réel uniquement
BITVAVO_API_KEY=
BITVAVO_API_SECRET=
BITVAVO_OPERATOR_ID=1
START_CASH=1000
```

## Commandes

| Action | Commande |
| --- | --- |
| Démarrer ou appliquer un changement de `.env` | `docker compose up -d` |
| Mettre à jour le code | `git pull && docker compose up -d --build` |
| Suivre les journaux | `docker compose logs -f --tail 50` |
| État du conteneur | `docker compose ps` |
| Arrêter | `docker compose down` |

Tableau de bord depuis ton poste : `ssh -N -L 3210:127.0.0.1:3210 utilisateur@serveur`, puis
<http://localhost:3210>.

## Du papier au réel

1. Laisse tourner en papier (`BOT_FLAGS=` vide) jusqu'à avoir vu au moins un achat et une vente.
2. Clé API Bitvavo : droits « lecture » et « trading » seulement, **sans retrait**, IP du serveur en liste
   blanche. Le bot ne peut pas vérifier ces droits : Bitvavo ne les expose pas.
3. Convertis sur Bitvavo le montant voulu en USDC. Renseigne les trois variables `BITVAVO_*`,
   `START_CASH` (un très petit montant pour la répétition, minimum 5 USDC par ordre) et `BOT_FLAGS=--real`.
4. Repars d'un état neuf : `docker compose down`, archive `data/state.json`
   (`mv data/state.json data/state.papier.json`), puis `docker compose up -d`.
5. Contrôle dans les journaux la ligne `mode=ORDRES RÉELS sur Bitvavo`, puis compare le premier achat et la première vente
   avec l'application Bitvavo avant d'augmenter `START_CASH`.

Le circuit événementiel reste désactivé en réel (règle non validée) ; `BOT_FLAGS=--real --events` l'active.

## Sauvegarde

Tout l'état est dans `data/` (`state.json`, `events.json`). Une copie régulière de ce dossier suffit.
