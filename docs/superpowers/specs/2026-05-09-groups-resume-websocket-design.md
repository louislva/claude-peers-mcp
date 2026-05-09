# claude-peers v0.3 -- Groupes, resume d'identité, transport WebSocket

**Date** : 2026-05-09
**Statut** : Spec validée, pré-implémentation
**Scope** : Refonte simultanée de quatre domaines : isolation par groupe cryptographique, persistence d'identité entre sessions, transport WebSocket pour le push de messages, séparation routing/display de l'identifiant peer.

## 1. Objectifs

1. Permettre à un même utilisateur d'isoler ses sessions Claude Code en plusieurs domaines logiques (perso, work, shared, ...) sur un broker partagé, avec switch facile entre groupes.
2. Stabiliser l'identifiant d'une session Claude Code à travers les redémarrages dans le même répertoire de travail.
3. Remplacer le polling 1s actuel par un push WebSocket temps réel, avec fallback de polling élargi.
4. Découpler l'identifiant de routage interne de l'identifiant d'affichage, pour que le renommage `set_id` soit cosmétique et sans cascade.

## 2. Hypothèses et contexte

- Aucune session production ne tourne actuellement sur le MCP. Pas de migration de données, on part d'une base vierge.
- Le broker tourne sur un LXC accessible via SSH (loopback `127.0.0.1:7899`, jamais exposé au LAN).
- `server.ts` est spawné par SSH stdio depuis `client.ts`, donc tourne sur le même hôte que `broker.ts`. La WebSocket entre les deux est en pure loopback.
- L'utilisateur est unique pour cette v0.3 (usage perso et pro, mais une seule personne).

## 3. Décisions de design verrouillées

| # | Décision | Justification |
|---|---|---|
| D1 | Scope = phases 1 à 4 dans une seule release v0.3 | Pas d'usage en cours, autant tout refondre d'un coup |
| D2 | Authentification du `group_secret` = TOFU (Trust On First Use) | Le broker enregistre `secret_hash` au premier register, valide strict ensuite. Zéro config utilisateur, protège contre les fautes de frappe |
| D3 | Résolution du groupe : fichier local > fichier projet > config user > env var > sentinel `'default'` | Le plus spécifique gagne, fichier > env. Calque la hiérarchie CLAUDE.md |
| D4 | `.claude-peers.json` versionné dans le repo, `.claude-peers.local.json` gitignored | Le repo dit "quel groupe pour ce projet", l'utilisateur dit "comment se connecter à ce groupe" |
| D5 | Clé d'identité de resume = `(host, cwd, group_id)` | Naturel, gère les worktrees, évite les collisions sur sessions parallèles dans le même repo |
| D6 | Pas de `group_secret` configuré -> groupe `'default'` (pas d'auth, ouvert) | Comportement zéro-config qui reproduit le legacy |
| D7 | `set_id` refusé si nom pris par un autre peer (active OU dormant) | Garantit l'unicité stricte du display name dans un groupe |
| D8 | Modèle d'identité à deux niveaux : `instance_token` (UUID immutable, routing) + `peer_id` (display name mutable) | Découple renommage et routing, élimine les cascades |
| D9 | Pas de migration -- on supprime la DB existante et on recrée le schéma | Pas d'usage en prod, simplifie le code de plus de 60 lignes |

## 4. Architecture cible

### 4.1 Topologie inchangée

```
Local PC                                     Broker host (LXC)
+-----------------------+                    +---------------------------------+
| Claude Code           |                    |                                 |
|   |                   |                    |                                 |
|   v stdio (MCP)       |                    |                                 |
| client.ts ---ssh----> |                    |  bun /srv/claude-peers/server.ts|
|                       |    handshake       |     |                           |
|                       |    + stdio relay   |     v ws + http loopback        |
+-----------------------+                    |  bun /srv/claude-peers/broker.ts|
                                             |     |                           |
                                             |     v                           |
                                             |  /var/lib/claude-peers/peers.db |
                                             +---------------------------------+
```

### 4.2 Schéma SQLite (création directe, pas de migration)

```sql
CREATE TABLE groups (
  group_id TEXT PRIMARY KEY,
  secret_hash TEXT,                          -- NULL pour 'default' (pas d'auth)
  name TEXT,                                 -- libellé optionnel
  created_at TEXT NOT NULL
);
INSERT INTO groups (group_id, secret_hash, name, created_at)
  VALUES ('default', NULL, 'default', datetime('now'));

CREATE TABLE peers (
  instance_token TEXT PRIMARY KEY,           -- UUID v4, routing immutable
  peer_id TEXT NOT NULL,                     -- display name, unique par groupe
  group_id TEXT NOT NULL DEFAULT 'default',
  pid INTEGER NOT NULL,                      -- pid bun server.ts (local broker)
  cwd TEXT NOT NULL,
  git_root TEXT,
  tty TEXT,
  summary TEXT NOT NULL DEFAULT '',
  registered_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  host TEXT NOT NULL DEFAULT '',             -- hostname client (depuis handshake)
  client_pid INTEGER NOT NULL DEFAULT 0,     -- pid Claude Code côté client
  project_key TEXT,                          -- URL git remote normalisée
  status TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'dormant'
  UNIQUE (peer_id, group_id),
  FOREIGN KEY (group_id) REFERENCES groups(group_id)
);
CREATE INDEX idx_peers_group ON peers(group_id);
CREATE INDEX idx_peers_status ON peers(status);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_token TEXT NOT NULL,                  -- instance_token, jamais peer_id
  to_token TEXT NOT NULL,
  group_id TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (from_token) REFERENCES peers(instance_token),
  FOREIGN KEY (to_token) REFERENCES peers(instance_token)
);
CREATE INDEX idx_messages_pending ON messages(to_token, delivered);

CREATE TABLE peer_sessions (
  session_key TEXT PRIMARY KEY,              -- sha256(host || \0 || cwd || \0 || group_id)
  instance_token TEXT NOT NULL,
  group_id TEXT NOT NULL,
  host TEXT NOT NULL,
  cwd TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  FOREIGN KEY (instance_token) REFERENCES peers(instance_token)
);
CREATE INDEX idx_sessions_lookup ON peer_sessions(group_id, host, cwd);
```

### 4.3 Modèle d'identité

| Champ | Rôle | Mutabilité | Exposé à Claude/utilisateur |
|---|---|---|---|
| `instance_token` | Clé de routage interne, FK des messages, clé du wsPool, clé peer_sessions | Immutable | Non |
| `peer_id` | Display name affiché par `list_peers`, `whoami`, `send_message` | Mutable via `set_id` | Oui |

L'API MCP parle exclusivement de `peer_id` (alias `id` dans les anciennes signatures conservées). Le `instance_token` est interne au broker.

### 4.4 Configuration

#### Fichier user `~/.config/claude-peers/config.json` (Linux/macOS) ou `%APPDATA%\claude-peers\config.json` (Windows)

```json
{
  "remote": "user@broker-host",
  "remote_server_path": "/srv/claude-peers/server.ts",
  "ssh_opts": [],
  "groups": {
    "perso":  "secret-perso-aaaa",
    "work":   "secret-work-bbbb",
    "shared": "secret-shared-cccc"
  },
  "default_group": "perso",
  "summary_provider": "auto",
  "summary_base_url": null,
  "summary_api_key": null,
  "summary_model": "claude-haiku-4-5-20251001"
}
```

Le dictionnaire `groups` mappe nom logique vers secret. Le `default_group` est le nom utilisé quand rien n'override.

#### Fichier projet `.claude-peers.json` (commité, racine du repo ou cwd)

```json
{ "group": "work" }
```

#### Fichier local `.claude-peers.local.json` (gitignored, racine du repo ou cwd)

```json
{ "group": "perso" }
```

Override personnel sur ce clone.

#### Ordre de résolution (premier trouvé gagne)

1. `.claude-peers.local.json` le plus proche du cwd, en remontant jusqu'au git_root
2. `.claude-peers.json` le plus proche du cwd, en remontant jusqu'au git_root
3. `default_group` du user config
4. Env var `CLAUDE_PEERS_GROUP`
5. Sentinel `'default'`

Le nom résolu est ensuite mappé vers son secret via `userConfig.groups[name]`. Si le nom n'est pas dans le dictionnaire user, log d'avertissement explicite et fallback sur `'default'`.

### 4.5 Handshake étendu

Le `client.ts` envoie sur stdin première ligne :

```json
{
  "client_meta": {
    "host": "olivier-pc",
    "client_pid": 12345,
    "cwd": "/home/olivier/projects/foo",
    "git_root": "/home/olivier/projects/foo",
    "git_branch": "main",
    "recent_files": ["src/index.ts", "README.md"],
    "project_key": "github.com/vocsap/foo",
    "tty": null,
    "group_id": "a1b2c3d4...",
    "group_secret_hash": "...sha256 complet..."
  }
}
```

Le secret en clair n'est jamais transmis. Le `group_id` est calculé côté client : `sha256(secret).slice(0, 32)`.

### 4.6 Flow `/register` (broker)

1. Reçoit `(group_id, group_secret_hash, host, cwd, ...)`.
2. Vérifie le groupe :
   - Si `group_id == 'default'` -> ignore `secret_hash`, ok.
   - Sinon row `groups WHERE group_id = ?` :
     - Existe et `secret_hash` matche -> ok.
     - Existe et `secret_hash` ne matche pas -> 401.
     - N'existe pas -> insère `groups(group_id, secret_hash, NULL, now)`, ok (TOFU).
3. Calcule `session_key = sha256(host || \0 || cwd || \0 || group_id)`.
4. Lookup `peer_sessions WHERE session_key = ?` :
   - Trouvée -> regarde la row `peers` correspondante :
     - Existe en `dormant` -> bascule en `active`, met à jour `pid`, `last_seen`, retourne `(peer_id, instance_token)` du dormant ressuscité.
     - Existe en `active` (collision : un autre process Claude Code a déjà pris cette session_key) -> log warning, génère un nouveau `instance_token` et un nouveau `peer_id` dérivé (avec suffixe), insère sans toucher à `peer_sessions` (l'autre garde la session de référence). Retourne le couple frais.
     - N'existe pas (purge passée) -> insère nouvelle row `peers` réutilisant le `instance_token` mémorisé dans `peer_sessions`, retourne `(peer_id_dérivé, instance_token)`.
   - Pas trouvée -> nouveau register :
     - Génère `instance_token = crypto.randomUUID()`.
     - Génère `peer_id = deriveDefaultId(host, cwd, group_id)` (cf. 4.7).
     - Insère row `peers` et row `peer_sessions`.
5. Met à jour `peer_sessions.last_active_at`.

### 4.7 Génération du `peer_id` par défaut

```ts
function deriveDefaultId(host: string, cwd: string, groupId: string): string {
  const sanitize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const hostPart = sanitize(host).slice(0, 20);
  const cwdPart = sanitize(cwd.split(/[/\\]/).pop() || "").slice(0, 12);
  const base = cwdPart ? `${hostPart}-${cwdPart}` : hostPart;
  let candidate = base;
  let suffix = 1;
  const MAX_SUFFIX = 1000;  // garde-fou contre une boucle pathologique
  while (db.query("SELECT 1 FROM peers WHERE peer_id = ? AND group_id = ?")
                  .get(candidate, groupId)) {
    suffix += 1;
    if (suffix > MAX_SUFFIX) {
      // Fallback ultra rare : suffixe avec timestamp
      candidate = `${base}-${Date.now().toString(36)}`;
      break;
    }
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}
```

Exemples :
- `(olivier-pc, ~/projects/claude-peers-mcp, perso)` -> `olivier-pc-claude-peers-mcp`
- `(olivier-pc, ~/projects/foo, perso)` -> `olivier-pc-foo`, puis `olivier-pc-foo-2` si collision

### 4.8 Cycle de vie peer

```
            register / resume                /resume
   (rien) -------------------> active <------------- dormant
                                  |  ^                ^
                                  |  | heartbeat      |
                                  |  +----------------+
                                  | disconnect / pid mort
                                  v
                              dormant
                                  |
                                  | TTL (24h, configurable)
                                  v
                              (purgé)
```

`cleanStalePeers()` tourne au boot et toutes les 30s :
1. Pour chaque peer `active`, `process.kill(pid, 0)` -> si fail, bascule `status='dormant'`.
2. `DELETE FROM peers WHERE status = 'dormant' AND last_seen < datetime('now', '-24 hours')`.
3. Cascade : suppression des `peer_sessions` orphelines, des `messages` non livrés à des peers disparus.

TTL configurable par `CLAUDE_PEERS_DORMANT_TTL_HOURS`, défaut 24.

`SIGINT`/`SIGTERM` dans `server.ts` appelle `/disconnect` (bascule en `dormant`), pas `/unregister` (qui DELETE).

### 4.9 Transport WebSocket

#### Côté broker

- Endpoint `ws://127.0.0.1:7899/ws`.
- Première frame attendue du client : `{ type: "auth", instance_token: "..." }`.
- Vérif : `SELECT 1 FROM peers WHERE instance_token = ? AND status = 'active'`. Si fail -> close 1008.
- Succès -> `wsPool.set(instance_token, ws)`, flush des messages pending pour ce token.
- Heartbeat ping serveur toutes les 30s, idle timeout 600s.
- À `close`, `wsPool.delete(instance_token)`.

#### Côté server.ts

- Connecte WebSocket après le `/register` initial, en utilisant `instance_token` pour s'auth (et non `peer_id` qui pourrait changer).
- Reconnexion avec backoff exponentiel : 1s, 2s, 4s, ..., max 30s.
- En cas de déconnexion prolongée, le polling fallback toutes les 30s ramasse les messages manqués.
- Sur message reçu (frame `{type: "message", ...}`), pousse dans le canal MCP via `mcp.notification("notifications/claude/channel", ...)`.

#### Modification de `handleSendMessage`

```ts
function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Résoudre to_peer_id -> to_token dans le groupe du sender
  const sender = db.query("SELECT instance_token, group_id FROM peers WHERE instance_token = ?")
                   .get(body.from_token);
  if (!sender) return { ok: false, error: "Sender not registered" };

  const target = db.query("SELECT instance_token FROM peers WHERE peer_id = ? AND group_id = ?")
                   .get(body.to_peer_id, sender.group_id);
  if (!target) return { ok: false, error: `Peer '${body.to_peer_id}' not found in your group` };

  const result = insertMessage.run(sender.instance_token, target.instance_token, sender.group_id,
                                   body.text, new Date().toISOString());
  const messageId = result.lastInsertRowid;

  // Push WebSocket immédiat si target connecté
  const ws = wsPool.get(target.instance_token);
  if (ws && ws.readyState === 1) {
    const senderInfo = db.query(
      "SELECT peer_id, summary, host, cwd FROM peers WHERE instance_token = ?"
    ).get(sender.instance_token) as { peer_id: string; summary: string; host: string; cwd: string };
    const sentAt = new Date().toISOString();
    ws.send(JSON.stringify({
      type: "message",
      id: messageId,
      from_peer_id: senderInfo.peer_id,
      from_summary: senderInfo.summary,
      from_host: senderInfo.host,
      from_cwd: senderInfo.cwd,
      text: body.text,
      sent_at: sentAt
    }));
    markDelivered.run(messageId);
  }
  return { ok: true };
}
```

### 4.10 Outils MCP

| Outil | Entrée | Sortie | Notes |
|---|---|---|---|
| `list_peers` | `{ scope: "machine"\|"directory"\|"repo" }` | Liste de peers du groupe courant uniquement | Filtré implicitement par group_id du caller. Format inclut `peer_id`, `host`, `cwd`, `summary`, `last_seen`, jamais `instance_token` |
| `send_message` | `{ to_peer_id: string, message: string }` | `{ ok: boolean, error? }` | Renommage `to_id` -> `to_peer_id` pour clarté. Cible doit être dans le même group_id que le sender |
| `set_summary` | `{ summary: string }` | `{ ok: true }` | Inchangé |
| `check_messages` | `{}` | `{ messages: [...] }` | Inchangé, polling fallback exposé à Claude |
| `whoami` | `{}` | Voir 4.10.1 | Nouveau |
| `list_groups` | `{}` | Voir 4.10.2 | Nouveau |
| `switch_group` | `{ name: string }` | `{ ok, new_peer_id, group_name }` | Nouveau |
| `set_id` | `{ new_id: string }` | `{ peer_id, previous? }` | Nouveau |

#### 4.10.1 `whoami` -- format de sortie

```json
{
  "peer_id": "olivier-pc-foo",
  "host": "olivier-pc",
  "client_pid": 12345,
  "cwd": "/home/olivier/projects/foo",
  "git_root": "/home/olivier/projects/foo",
  "project_key": "github.com/vocsap/foo",
  "group_name": "perso",
  "summary": "Refactor du module bar",
  "registered_at": "2026-05-09T14:32:18Z",
  "ws_connected": true
}
```

`group_name` résolu en inversant `userConfig.groups`. Si non trouvé, retourne `"<unknown>"` ou `"default"`.

#### 4.10.2 `list_groups` -- format de sortie

```json
{
  "current": "perso",
  "available": [
    { "name": "perso",  "active_peers": 3 },
    { "name": "work",   "active_peers": 1 },
    { "name": "shared", "active_peers": 0 }
  ]
}
```

Endpoint broker `/group-stats` :
```sql
SELECT group_id, COUNT(*) AS active_peers
FROM peers WHERE status = 'active'
GROUP BY group_id;
```

Le mapping `group_id -> name` se fait côté server.ts à partir du user config.

#### 4.10.3 `switch_group` -- comportement

1. Lookup `secret = userConfig.groups[name]`. Absent -> erreur "Group 'name' not in user config".
2. Calcule `new_group_id = sha256(secret).slice(0, 32)`.
3. POST `/disconnect { instance_token }` -> session courante en dormant.
4. POST `/register { ..., group_id: new_group_id, secret_hash }` -> resume si session dormante existe pour `(host, cwd, new_group_id)`, sinon nouveau peer.
5. Reconnecte WebSocket avec le nouveau `instance_token`.
6. Met à jour les variables module `myInstanceToken`, `myPeerId`, `myGroupId`.
7. Retourne `{ ok: true, new_peer_id, group_name }`.

Les messages dormants dans l'ancien groupe restent attachés à l'ancien `instance_token` -- récupérables au prochain switch retour via le mécanisme de resume.

#### 4.10.4 `set_id` -- comportement

1. Validation regex `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$` côté server.ts. Fail -> erreur explicite.
2. POST `/set-id { instance_token, new_peer_id }`.
3. Broker vérifie unicité dans `(peer_id, group_id)` toutes statuts confondus (active OU dormant) :
   - Conflit -> 409 `"peer_id 'xxx' already taken in group 'yyy'"`.
   - OK -> `UPDATE peers SET peer_id = ? WHERE instance_token = ?`.
4. Le `wsPool` n'est pas affecté (keyed par `instance_token`).
5. Retourne `{ peer_id: "olivier-pro", previous: "olivier-pc-foo" }`.

### 4.11 CLI

`bun cli.ts peers` accepte un nouveau flag `--include-dormant` pour afficher les sessions endormies (debug). Par défaut, n'affiche que les `active`.

Aucun autre changement de CLI dans cette v0.3.

## 5. Tests

| Fichier | Couverture |
|---|---|
| `tests/broker-groups.test.ts` | TOFU création groupe ; rejet 401 secret_hash divergent ; isolation list_peers ; send_message cross-group rejeté |
| `tests/broker-resume.test.ts` | Stabilité peer_id sur (host, cwd, group) ; resume après disconnect ; expiration TTL |
| `tests/broker-set-id.test.ts` | Renommage simple ; collision active 409 ; collision dormant 409 ; messages survivent au rename |
| `tests/broker-websocket.test.ts` | Auth frame valide -> wsPool ; auth invalide -> close 1008 ; push immédiat sur send_message ; flush au reconnect |
| `tests/broker-status.test.ts` | Cleanup pid mort -> dormant ; dormant > TTL -> DELETE ; list_peers exclut dormants par défaut |
| `tests/client-config.test.ts` | Hiérarchie .local > .json > user config > env > default ; remontée jusqu'au git_root ; nom absent du dictionnaire -> warning + default |
| `tests/server-handshake.test.ts` | Parsing JSON ; calcul group_id correct ; absence de secret -> 'default' |

Smoke test bundling : `bun build --target=bun broker.ts server.ts client.ts cli.ts --outdir=/tmp/cp-check`.

## 6. Plan de livraison

1. Branche `feature/groups-resume-ws`.
2. Une PR vers `main`, séquencée en commits logiques :
   - `feat(broker): schema v0.3 with groups, instance_token, sessions, status`
   - `feat(shared): config hierarchy and group resolution`
   - `feat(server): handshake with group_id, websocket transport, resume support`
   - `feat(client): config file lookup, group secret hashing in handshake`
   - `feat(mcp): whoami, list_groups, switch_group, set_id tools`
   - `feat(broker): websocket push and dormant cleanup`
   - `test: groups, resume, websocket, set-id, status, config, handshake`
   - `docs: README v0.3 with groups, .claude-peers.json, set_id`
3. `package.json` -> `version: "0.3.0"`.
4. README v0.3 réécrit : section "Groups" (config user + .claude-peers.json), exemples switch, troubleshooting "ws_connected: false", "comment vérifier dans quel groupe je suis avec whoami".
5. CLAUDE.md : décrire séparation routing/display, nouveaux outils, flux resume.
6. Pré-déploiement sur le LXC : stop service, `rm /var/lib/claude-peers/peers.db`, redéploie code, restart.

## 7. Hors-scope (à itérer plus tard)

- Skill CLI `/peers` (slash command qui bypass le LLM).
- Rôles (manager/developer/tester) et group doc partagé.
- mTLS ou auth crypto au-delà du SSH ambient.
- Multi-utilisateurs sur un même broker avec ACL fines.

## 8. Risques et points de vigilance

| Risque | Mitigation |
|---|---|
| Bug dans la WebSocket cause perte silencieuse de messages | Polling fallback 30s ramasse systématiquement les pending. `whoami.ws_connected` rend l'état observable |
| Résolution de groupe ambiguë (deux fichiers à des niveaux différents) | Premier trouvé gagne en remontant ; cas documenté dans le README |
| Collision de `peer_id` lors d'un resume après changement d'host (ex: laptop renommé) | `session_key` inclut `host` ; un changement d'host = nouveau peer_id, c'est le comportement attendu |
| Secrets fuités via `.claude-peers.json` commit accidentel | Le format n'autorise QUE `{"group": "name"}`, pas de champ secret. Validation côté client.ts qui rejette tout autre champ |
| Switch_group laisse des messages orphelins dans l'ancien groupe | Acceptable : les messages sont attachés à `instance_token` qui survit au switch. Récupérables au switch retour |
