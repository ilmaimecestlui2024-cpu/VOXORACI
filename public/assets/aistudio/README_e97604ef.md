# Voxora Live : auto-tune en direct (Flutter + C++)

Application Android de correction de voix en direct : détection de hauteur (YIN), correction vers une gamme,
effets de studio (égaliseur 3 bandes, compresseur, réverbération, écho) et enregistrement WAV.

## Obtenir l'APK sans rien installer (GitHub Actions)

1. Pousse ce dépôt sur GitHub (branche `main`).
2. Onglet **Actions** > workflow **Build APK** > dernière exécution.
3. Télécharge l'artefact **voxora-apk** (il contient `app-release.apk`) et installe-le sur ton téléphone Android.

Le workflow génère le projet Android, branche le moteur C++ et compile l'APK à chaque `push`.

## Compiler sur ton ordinateur

Prérequis : Flutter 3.27 ou plus récent, Android SDK + NDK, Python 3.

```bash
git clone <url-du-depot> voxora && cd voxora
flutter create --platforms=android --project-name voxora --org com.voxora .
git checkout -- lib/main.dart pubspec.yaml   # restaure les fichiers du dépôt
python3 tools/setup_android.py               # branche le moteur C++ (Oboe) et les permissions micro
flutter pub get
flutter run --release                        # téléphone Android branché (pas l'émulateur)
```

`tools/setup_android.py` peut être relancé sans risque.

## Utilisation

- Mets un **casque filaire**. Sans casque, le micro capte le haut-parleur (larsen). Le Bluetooth ajoute 150 ms ou plus de retard.
- Touche « Démarrer le direct », chante, et règle la tonalité, la gamme, la correction et la vitesse.
- « Enregistrer » sauvegarde la voix corrigée en WAV dans le dossier de l'appli.

## Structure

- `android/app/src/main/cpp/voxora.cpp` : flux micro et sortie Oboe à faible latence, détection de hauteur (YIN), correction vers la gamme, décaleur de hauteur, effets.
- `lib/main.dart` : interface, courbe de hauteur en direct, appels au moteur par `dart:ffi`.
- `tools/setup_android.py` : configuration Gradle (CMake, Oboe) et permissions du projet Android généré.
- `.github/workflows/build.yml` : compilation automatique de l'APK.

Latence attendue : environ 20 ms de traitement, plus celle du téléphone (souvent 20 à 40 ms).

## Limites actuelles

- L'instrumental et le multi-pistes ne sont pas encore dans la version native.
- Le moteur C++ a été vérifié sur ordinateur (compilation et test de la correction de hauteur avec un faux flux audio), mais pas encore sur un vrai téléphone.
