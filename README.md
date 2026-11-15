# Calaméo PDF Export

Extension Chrome Manifest V3 qui ajoute un bouton **PDF** au lecteur Calaméo. Elle crée un PDF à partir des pages servies au lecteur, pour toute la publication ou une sélection de pages.

## Fonctionnalités

- Bouton flottant **PDF**, isolé du style de la page Calaméo.
- Export de toutes les pages ou d'une sélection, par exemple `1-3, 8, 12-15`.
- Barre de progression et annulation pendant la lecture des pages.
- PDF assemblé localement dans le navigateur, sans service de conversion externe.
- Nom de fichier dérivé du titre de la publication.
- Compatible avec Chrome, Brave et Edge sous Chromium 116 ou plus récent.

## Installer en local

1. Ouvrir `chrome://extensions` dans Chrome, `brave://extensions` dans Brave ou `edge://extensions` dans Edge.
2. Activer le **Mode développeur**.
3. Cliquer sur **Charger l'extension non empaquetée**.
4. Sélectionner le dossier `calameo-pdf-export`.
5. Ouvrir une publication sur `calameo.com/read/...` et cliquer sur **PDF**.

Le dossier doit rester au même endroit tant que l'extension est chargée depuis le disque.

## Utiliser une sélection

Choisir **Une sélection**, puis saisir des numéros ou des plages séparés par des virgules :

```text
1-3, 8, 12-15
```

Les pages sont ajoutées dans l'ordre croissant et les doublons sont supprimés. Les numéros doivent rester compris entre la première et la dernière page du document.

## Fonctionnement et confidentialité

Le lecteur charge les images de pages SVG Calaméo. L'extension lit le lien signé déjà présent dans le lecteur, récupère les pages choisies sur les serveurs d'images Calaméo, puis assemble les images dans un PDF local. Le lien signé n'est ni enregistré ni transmis à un service tiers. Aucun fichier n'est envoyé à un serveur de conversion.

Le PDF est un document image : le texte reconnu ou affiché dans une publication n'est pas ajouté comme calque OCR sélectionnable. Les liens interactifs et médias du lecteur ne sont pas reproduits.

## Limites

- Le lecteur doit avoir chargé au moins une page et fournir le nombre total de pages dans ses métadonnées.
- Les pages doivent être accessibles avec le lien de ressource fourni pendant la session du lecteur.
- Les publications très volumineuses peuvent demander beaucoup de mémoire au navigateur.

## Structure

- `manifest.json` : permissions et correspondance du lecteur Calaméo.
- `content.js` : bouton, interface et saisie des pages.
- `background.js` : messages, téléchargement local et cycle de vie du document hors écran.
- `offscreen.html` / `offscreen.js` : lecture des pages et génération PDF.
