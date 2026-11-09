# pen2breakdance

Exporte une maquette **[pen.dev](https://pen.dev)** en fichiers JSON prêts à **copier-coller dans [Breakdance](https://breakdance.com)** (le builder WordPress), avec le même fonctionnement que [Headspin](https://headspinui.com).

Tu maquettes dans pen.dev, tu lances une commande, et chaque section devient un bloc Breakdance natif : Section, Div, Heading, Text, Button, Image, Icon ou Divider, avec la mise en page, les espacements, les couleurs et la typographie.

- Pas d'IA ni de service en ligne : tout tourne en local.
- Une seule commande, aucune dépendance npm.
- Fonctionne avec Node.js 18 ou plus récent.

---

## Prérequis

- **Node.js 18+** : <https://nodejs.org>
- **pen.dev** installé et **ouvert** pendant l'export.
  Le fichier `.pen` sur le disque n'est qu'un pointeur : le contenu de la maquette est géré par l'application. Le script la lit via le serveur MCP local fourni avec pen.dev.

## Installation

```bash
git clone https://github.com/<utilisateur>/pen2breakdance.git
cd pen2breakdance
npm install -g .
```

La commande `pen2bd` est ensuite disponible partout.

## Utilisation

Place-toi dans le dossier qui contient le `.pen`, puis lance :

```bash
cd mon-projet
pen2bd
```

Si le dossier contient plusieurs `.pen`, indique lequel : `pen2bd maquette.pen`.

Le script crée un dossier `export/` :

```
export/
├── global-settings.json   ← réglages globaux Breakdance : palette, polices, bouton primaire
├── medias.txt             ← images utilisées et nom attendu dans WordPress
├── a-verifier.txt         ← réglages à faire à la main après collage
└── accueil/               ← un dossier par page de la maquette
    ├── 00-page-complete.json
    ├── 01-header.json
    ├── 02-hero.json
    └── …
```

Pour importer dans Breakdance :

1. **Une fois par site**, importe `global-settings.json` : dans l'éditeur Breakdance, menu → **Global Settings** → menu ⋯ → **Import Global Settings**, puis **Save**.
   ⚠ D'après la documentation Breakdance, l'import **remplace** les réglages globaux existants, sans fusion. Fais-le sur un site neuf, ou exporte d'abord tes réglages actuels.
2. Ouvre un fichier `.json`, copie tout son contenu (Ctrl+A, Ctrl+C) et colle-le dans l'éditeur Breakdance (Ctrl+V).
   `00-page-complete.json` contient toutes les sections de la page, dans l'ordre.
   Colle-le **sans aucun élément sélectionné** (clique dans le vide de la page avant Ctrl+V). Si une section est sélectionnée, Breakdance risque d'insérer les sections dans un autre ordre.
3. Consulte `a-verifier.txt` pour les quelques réglages à faire à la main.

> ⚠ `export/` est entièrement régénéré à chaque lancement. N'y range pas d'autres fichiers.

## Images

Les sections collées pointent directement vers tes images dans la médiathèque WordPress :

1. Convertis tes images (en WebP par défaut) **en gardant le même nom de fichier**. `medias.txt` donne le nom exact attendu pour chaque image : les espaces deviennent des tirets et les caractères spéciaux sont retirés, comme le fait WordPress.
2. Importe-les dans la médiathèque WordPress, toutes au cours du même mois, pour qu'elles soient dans le même dossier `uploads/AAAA/MM/`.
3. Renseigne `mediaUrl` dans `pen2bd.config.json` avec l'URL de ce dossier, puis relance `pen2bd`.

## Configuration

Au premier lancement, `pen2bd.config.json` est créé à côté du `.pen` :

```json
{
  "prefix": "bbe",
  "mediaUrl": "https://mon-site.fr/wp-content/uploads/2026/11/",
  "mediaFormat": "webp"
}
```

| Clé | Rôle |
|---|---|
| `prefix` | Sert à générer des identifiants de couleurs stables pour ce projet (par défaut, le début du nom du fichier `.pen`). Ne le change pas une fois le site importé. |
| `mediaUrl` | URL du dossier WordPress qui contient les images. |
| `mediaFormat` | Extension des images après conversion (`webp`, `avif`…). Mets `""` pour garder l'extension d'origine. |

Options en ligne de commande :

| Option | Effet |
|---|---|
| `--media-url <url>` | Définit `mediaUrl` (et l'enregistre dans la config). |
| `--out <dossier>` | Dossier de sortie (par défaut `./export`). |
| `--help` | Affiche l'aide. |

## Principe : rien n'est inventé

Le script n'écrit que des réglages Breakdance **vérifiés**, c'est-à-dire relevés dans de vrais exports Breakdance. Quand il ne sait pas convertir quelque chose proprement, il ne devine pas :

- **Un élément qu'il ne sait pas convertir devient une Div.** Si tu trouves une Div là où tu attendais un autre élément (formulaire, accordéon, slider, menu…), c'est que la conversion n'a pas été possible. Remplace-la par l'élément Breakdance adapté.
- **Un réglage visuel sans équivalent Breakdance connu** (dégradé, ombre, position absolue, bordure d'une image…) passe dans le **CSS personnalisé** de l'élément (onglet Advanced → Custom CSS, sélecteur `%%SELECTOR%%`).
- **Un réglage impossible à transmettre** (couleur d'un Divider, icône dans un bouton…) est listé dans **`a-verifier.txt`**, à régler à la main.

Le résultat est donc une base fidèle, que le webdesigner finalise dans Breakdance.

## Correspondances pen.dev → Breakdance

| pen.dev | Breakdance |
|---|---|
| Cadre racine vertical (page) | une page, chaque enfant direct = une **Section** (padding, largeur, fond) |
| Cadre avec mise en page verticale ou horizontale | **Div** avec la mise en page native (alignements, gap, padding) |
| Rangée de colonnes | Div horizontale qui passe en vertical sur tablette (portrait) |
| Texte | **Heading** (h1–h6 si le calque s'appelle `H1`, `H2`…, sinon selon la taille) ou **Text** |
| Cadre avec fond ou bordure contenant un texte | **Button** (style primaire si fond plein, secondaire sinon). Une icône dans le bouton n'est pas reprise. |
| Cadre ou rectangle sans enfant, rempli d'une image | **Image** |
| Cadre rempli d'une image avec du contenu par-dessus | Div avec **image de fond** |
| Rectangle plein de 4 px de haut au maximum | **Divider** (style solid ; couleur et épaisseur à régler, voir `a-verifier.txt`) |
| Petite ellipse pleine (24 px max) | **Icon** cercle (Font Awesome) à la bonne taille et couleur |
| Icône Lucide, Feather ou Phosphor | **Icon** (SVG intégré) |
| Variables couleur pen.dev (`$light`) | couleurs de la **palette** Breakdance (`global-settings.json`), utilisées par les éléments |
| Variables numériques ou police | valeur reportée directement dans les éléments |
| Police la plus utilisée dans les titres / dans le texte | police globale des titres / du texte |
| Autre police sur un élément | réglage de police natif de l'élément |
| Fond et texte du bouton plein le plus fréquent | style global du bouton primaire |
| Tout autre élément (ou combinaison non reconnue) | **Div** : à remplacer à la main |
| Couleurs, bordures, coins arrondis | réglages natifs |
| Dégradé linéaire (seul ou par-dessus une image) | **overlay en dégradé** natif (Background → Overlay) |
| Dégradés radiaux, ombres, flou, positions absolues | CSS personnalisé de l'élément (`%%SELECTOR%%`) |

## Trouver pen.dev

Le script cherche le serveur MCP de pen.dev, dans cet ordre :

1. La variable d'environnement `PEN_MCP_BIN`.
2. La configuration Claude Code (`~/.claude.json`), si pen.dev y est branché.
3. Les emplacements d'installation habituels : AppImage montée sous Linux, `/Applications/Pen.app` sous macOS, `%LOCALAPPDATA%\Programs\Pen` sous Windows.

S'il ne trouve rien, indique le chemin à la main :

```bash
PEN_MCP_BIN="/chemin/vers/resources/app.asar.unpacked/out/mcp-server-xxx" pen2bd
```

## Limites connues

- **Testé uniquement sous Linux.** Les chemins macOS et Windows restent à confirmer.
- Les **liens des boutons** sont exportés vers `#`.
- Les éléments complexes (formulaires, FAQ, sliders, menus) sont exportés en Div à remplacer par l'élément Breakdance adapté.
- Les images sont collées par URL, sans identifiant de médiathèque : pas de `srcset` automatique.
- Le script ne connaît que les réglages relevés dans de vrais exports. Pour enrichir la conversion d'un élément, copie-le depuis Breakdance après l'avoir réglé et ouvre une *issue* avec le JSON obtenu.

## Licence

MIT
