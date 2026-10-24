# OCR PDF (français / anglais)

Application Android : reconnaissance de caractères (OCR) hors ligne pour PDF et images, traduction, lecture vocale et exports multiples.

## Fichiers du dépôt (tous à la racine)

- `index.html`, `style.css`, `app.js` : l'application
- `README.md` : ce guide
- `.github/workflows/build-apk.yml` : compilation de l'APK (voir l'étape 2)

## Dépôt GitHub depuis le téléphone

1. Créez un dépôt (par exemple `ocr-pdf`), puis **Add file → Upload files** et déposez `index.html`, `style.css`, `app.js`, `README.md`.
2. Le fichier de compilation doit se trouver dans un dossier : **Add file → Create new file**, tapez comme nom `.github/workflows/build-apk.yml` (les « / » créent les dossiers), collez le contenu du fichier `build-apk.yml` fourni, puis **Commit**.
3. Onglet **Actions → Compiler l'APK → Run workflow**. Durée : 8 à 12 minutes. Les échecs survenus avant que tous les fichiers soient déposés peuvent être ignorés.
4. Récupérez l'APK dans **Releases** (fichier `OCR-PDF.apk`) ou dans l'artefact de l'exécution, puis installez-le (autoriser les sources inconnues).

## Fonctions

- OCR français + anglais (modèles inclus, sans Internet) ; texte intégré des PDF numériques repris directement
- Choix des pages, qualité 144/216/288 dpi, prétraitement (gris + contraste, noir et blanc)
- Traduction anglais → français (et inverse) : MyMemory gratuit, ou Gemini avec clé gratuite
- Lecture vocale : voix, vitesse, hauteur, pause, lecture depuis le curseur
- Exports : TXT, Markdown, HTML, DOCX, PDF texte, PDF consultable (image + texte invisible), JSON ; contenu original, traduit ou bilingue
- Nettoyage du texte, rechercher/remplacer, annulation, indicateur de pages à relire, historique local
