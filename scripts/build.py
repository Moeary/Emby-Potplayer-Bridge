"""Build the frozen Native Host and copy the unpacked extension."""

from __future__ import annotations

import shutil
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
HOST_SOURCE = ROOT / "src" / "python-host" / "main.py"
EXTENSION_SOURCE = ROOT / "src" / "chrome-extension"
HOST_DIST = DIST / "native-host"
EXTENSION_DIST = DIST / "extension"
PYINSTALLER_WORK = ROOT / ".build" / "pyinstaller"
EXE_NAME = "PotPlayerBridgeHost.exe"


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def _remove_generated(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def build_native_host() -> Path:
    if not HOST_SOURCE.is_file():
        raise FileNotFoundError(f"找不到 Native Host 源码：{HOST_SOURCE}")
    HOST_DIST.mkdir(parents=True, exist_ok=True)
    _remove_generated(HOST_DIST / EXE_NAME)
    PYINSTALLER_WORK.mkdir(parents=True, exist_ok=True)

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--console",
        "--onefile",
        "--name",
        "PotPlayerBridgeHost",
        "--distpath",
        str(HOST_DIST),
        "--workpath",
        str(PYINSTALLER_WORK),
        "--specpath",
        str(PYINSTALLER_WORK),
        str(HOST_SOURCE),
    ]
    print("Running: " + " ".join(command))
    subprocess.run(command, cwd=ROOT, check=True)
    executable = HOST_DIST / EXE_NAME
    if not executable.is_file():
        raise FileNotFoundError(f"PyInstaller 未生成：{executable}")
    return executable


def copy_extension() -> Path:
    if not EXTENSION_SOURCE.is_dir():
        raise FileNotFoundError(f"找不到扩展目录：{EXTENSION_SOURCE}")
    _remove_generated(EXTENSION_DIST)
    shutil.copytree(EXTENSION_SOURCE, EXTENSION_DIST)
    return EXTENSION_DIST


def build() -> tuple[Path, Path]:
    DIST.mkdir(parents=True, exist_ok=True)
    executable = build_native_host()
    extension = copy_extension()
    print(f"Native Host: {executable}")
    print(f"Extension directory: {extension}")
    return executable, extension


if __name__ == "__main__":
    build()
