#!/usr/bin/env python3
"""Branche le moteur C++ (Oboe + CMake) sur le projet Android généré par `flutter create`.

À lancer une seule fois, à la racine du projet, après `flutter create`.
Le script peut être relancé sans risque : il ne modifie rien s'il est déjà appliqué.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "android" / "app"
MARK = "// voxora-native"

KTS = f"""
{MARK}
android {{
    buildFeatures {{ prefab = true }}
    externalNativeBuild {{ cmake {{ path = file("src/main/cpp/CMakeLists.txt") }} }}
    defaultConfig {{
        externalNativeBuild {{ cmake {{ arguments += "-DANDROID_STL=c++_shared" }} }}
    }}
}}
dependencies {{ implementation("com.google.oboe:oboe:1.9.0") }}
"""

GROOVY = f"""
{MARK}
android {{
    buildFeatures {{ prefab true }}
    externalNativeBuild {{ cmake {{ path "src/main/cpp/CMakeLists.txt" }} }}
    defaultConfig {{
        externalNativeBuild {{ cmake {{ arguments "-DANDROID_STL=c++_shared" }} }}
    }}
}}
dependencies {{ implementation 'com.google.oboe:oboe:1.9.0' }}
"""

PERMS = (
    '    <uses-permission android:name="android.permission.RECORD_AUDIO"/>\n'
    '    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>\n'
)


def patch_gradle() -> None:
    for name, block in (("build.gradle.kts", KTS), ("build.gradle", GROOVY)):
        f = APP / name
        if f.exists():
            txt = f.read_text(encoding="utf-8")
            if MARK in txt:
                print(f"{name} : déjà configuré")
            else:
                f.write_text(txt.rstrip() + "\n" + block, encoding="utf-8")
                print(f"{name} : moteur C++ et Oboe ajoutés")
            return
    sys.exit("android/app/build.gradle(.kts) introuvable : lance d'abord "
             "`flutter create --platforms=android --project-name voxora .`")


def patch_manifest() -> None:
    f = APP / "src" / "main" / "AndroidManifest.xml"
    if not f.exists():
        sys.exit("AndroidManifest.xml introuvable : lance d'abord `flutter create`.")
    txt = f.read_text(encoding="utf-8")
    if "android.permission.RECORD_AUDIO" in txt:
        print("AndroidManifest.xml : permissions déjà présentes")
        return
    i = txt.find("<application")
    if i < 0:
        sys.exit("Balise <application> introuvable dans AndroidManifest.xml.")
    # on insère au début de la ligne de <application>
    i = txt.rfind("\n", 0, i) + 1
    f.write_text(txt[:i] + PERMS + txt[i:], encoding="utf-8")
    print("AndroidManifest.xml : permissions micro ajoutées")


def drop_default_test() -> None:
    t = ROOT / "test" / "widget_test.dart"
    if t.exists():  # le test généré par Flutter référence une classe qui n'existe pas ici
        t.unlink()
        print("test/widget_test.dart (modèle par défaut) supprimé")


if __name__ == "__main__":
    patch_gradle()
    patch_manifest()
    drop_default_test()
