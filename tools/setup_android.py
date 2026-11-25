#!/usr/bin/env python3
"""Configure le projet Android généré par `flutter create` pour Voxora Studio (Oboe + MediaNDK + CMake)."""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "android" / "app"
MARK = "// voxora-studio-native"

KTS = f"""
{MARK}
android {{
    buildFeatures {{ prefab = true }}
    externalNativeBuild {{ cmake {{ path = file("src/main/cpp/CMakeLists.txt") }} }}
    defaultConfig {{
        minSdk = maxOf(minSdk ?: 24, 24)
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
        minSdkVersion Math.max((minSdkVersion ?: 24) as int, 24)
        externalNativeBuild {{ cmake {{ arguments "-DANDROID_STL=c++_shared" }} }}
    }}
}}
dependencies {{ implementation 'com.google.oboe:oboe:1.9.0' }}
"""

PERMS = (
    '    <uses-permission android:name="android.permission.RECORD_AUDIO"/>\n'
    '    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>\n'
    '    <uses-permission android:name="android.permission.READ_MEDIA_AUDIO"/>\n'
    '    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32"/>\n'
)


def patch_gradle() -> None:
    for name, block in (("build.gradle.kts", KTS), ("build.gradle", GROOVY)):
        f = APP / name
        if f.exists():
            txt = f.read_text(encoding="utf-8")
            if MARK in txt:
                print(f"{name} : déjà configuré")
            else:
                txt = re.sub(r"minSdk\s*=\s*flutter\.minSdkVersion", "minSdk = 24", txt)
                txt = re.sub(r"minSdkVersion\s+flutter\.minSdkVersion", "minSdkVersion 24", txt)
                f.write_text(txt.rstrip() + "\n" + block, encoding="utf-8")
                print(f"{name} : moteur C++, Oboe et minSdk 24 configurés")
            return
    sys.exit("android/app/build.gradle(.kts) introuvable.")


def patch_manifest() -> None:
    f = APP / "src" / "main" / "AndroidManifest.xml"
    if not f.exists():
        sys.exit("AndroidManifest.xml introuvable.")
    txt = f.read_text(encoding="utf-8")
    if "android.permission.RECORD_AUDIO" in txt:
        print("AndroidManifest.xml : permissions déjà présentes")
        return
    i = txt.find("<application")
    if i < 0:
        sys.exit("Balise <application> introuvable dans AndroidManifest.xml.")
    i = txt.rfind("\n", 0, i) + 1
    f.write_text(txt[:i] + PERMS + txt[i:], encoding="utf-8")
    print("AndroidManifest.xml : permissions audio ajoutées")


def drop_default_test() -> None:
    t = ROOT / "test" / "widget_test.dart"
    if t.exists():
        t.unlink()
        print("test/widget_test.dart supprimé")


if __name__ == "__main__":
    patch_gradle()
    patch_manifest()
    drop_default_test()
