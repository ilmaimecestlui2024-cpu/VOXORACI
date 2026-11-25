# Voxora Studio — Studio Vocal, Mixage & Mastering Android (Flutter + C++ / Oboe)

Application complète de production vocale sur Android avec moteur audio natif C++ à faible latence (`Oboe`), décodage streaming disque sans limite via `MediaNDK` (`WAV`, `MP3`, `AAC/M4A`, `OGG`, `FLAC`), chaîne d'effets vocaux complète, multi-piste, suite de mastering et export hors-ligne `WAV` (16/24-bit) & `M4A/AAC`.

## Architecture

- `android/app/src/main/cpp/voxora.cpp` :
  - Flux Oboe `LowLatency` + thread de streaming disque lock-free (aucune allocation ni verrou bloquant dans `onAudioReady`).
  - Importation streaming par blocs (zéro saturation mémoire même sur des pistes de plusieurs heures).
  - Chaîne vocale complète : Noise Gate, Auto-Tune YIN + interpolation cubique, Formant/Timbre, De-Esser, EQ 3 bandes RBJ, Compresseur vocal, Doubler/Chorus stéréo, Réverbération de Schroeder, Delay stéréo.
  - Bus de masterisation : EQ Master, Glue Bus Compressor, Exciter harmonique, Imager Stéréo M/S, Limiteur brickwall (-1.0 dBTP par défaut) + rendu hors-ligne rapide.
- `lib/` : Interface DAW Flutter modulaire (Mode Sombre Studio / Clair Studio synchronisé, Multi-piste avec waveform & scrubbing, Effets Voix + presets personnalisés, Mastering & Export, Mes Exports).
- `tools/setup_android.py` & `.github/workflows/build.yml` : intégration CMake/Oboe/MediaNDK et compilation APK automatisée.

## Compilation APK (GitHub Actions)

1. Pousse le dépôt sur GitHub (branche `main`).
2. Ouvre l'onglet **Actions** → **Build Voxora Studio APK**.
3. Télécharge l'artefact `voxora-studio-apk` (`app-release.apk`).
