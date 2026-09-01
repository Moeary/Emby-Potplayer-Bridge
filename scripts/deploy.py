"""Build and deploy the Native Host, manifest, registry entry, and extension."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
from typing import Any, Mapping

try:
    import winreg
except ImportError:  # pragma: no cover - only used on Windows.
    winreg = None  # type: ignore[assignment]

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.toml"
DIST = ROOT / "dist"
EXTENSION_DIST = DIST / "extension"
HOST_DIST = DIST / "native-host"
HOST_EXE_NAME = "PotPlayerBridgeHost.exe"
HOST_NAME = "com.codex.potplayer_bridge"
EXTENSION_ID = "jfcncnejcohfbggolpklemgiaimadgmn"
REGISTRY_SUBKEY = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"
MANIFEST_NAME = f"{HOST_NAME}.json"


def read_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    if not path.is_file():
        return {}
    with path.open("rb") as handle:
        value = tomllib.load(handle)
    return value if isinstance(value, dict) else {}


def _configured_path(config: Mapping[str, Any], section: str, key: str) -> Path | None:
    section_value = config.get(section)
    if not isinstance(section_value, Mapping):
        return None
    value = section_value.get(key)
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(os.path.expandvars(value.strip().strip('"')))
    return path if path.is_absolute() else ROOT / path


def _existing_registry_manifest() -> Path | None:
    if winreg is None:
        return None
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_SUBKEY) as key:
            value, _ = winreg.QueryValueEx(key, None)
    except OSError:
        return None
    if not isinstance(value, str) or not value.strip():
        return None
    return Path(value)


def _player_from_manifest(path: Path) -> Path | None:
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            manifest = json.load(handle)
        host_path = Path(manifest["path"])
    except (OSError, KeyError, TypeError, ValueError):
        return None
    candidate = host_path.parent / "PotPlayerMini64.exe"
    return candidate if candidate.is_file() else None


def _common_chrome_paths() -> list[Path]:
    roots = [
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("LOCALAPPDATA"),
    ]
    return [
        Path(root) / relative
        for root in roots
        if root
        for relative in (
            Path("Google") / "Chrome" / "Application" / "chrome.exe",
            Path("Chromium") / "Application" / "chrome.exe",
        )
    ]


def find_chrome(config: Mapping[str, Any]) -> Path:
    configured = _configured_path(config, "browser", "chrome")
    if configured is not None:
        if configured.is_file():
            return configured
        raise FileNotFoundError(f"配置的 Chrome 路径不存在：{configured}")

    environment_path = os.environ.get("CHROME_PATH")
    if environment_path and Path(environment_path.strip().strip('"')).is_file():
        return Path(environment_path.strip().strip('"'))
    for candidate in _common_chrome_paths():
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("找不到 Chrome，请在 config.toml 的 [browser] chrome 中填写 chrome.exe 路径")


def _common_potplayer_paths() -> list[Path]:
    roots = [
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("LOCALAPPDATA"),
    ]
    return [
        Path(root) / relative
        for root in roots
        if root
        for relative in (
            Path("DAUM") / "PotPlayer" / "PotPlayerMini64.exe",
            Path("PotPlayer") / "PotPlayerMini64.exe",
        )
    ]


def find_potplayer(config: Mapping[str, Any]) -> Path:
    configured = _configured_path(config, "potplayer", "path")
    if configured is not None:
        if configured.is_file():
            return configured
        raise FileNotFoundError(f"配置的 PotPlayer 路径不存在：{configured}")

    environment_path = os.environ.get("POTPLAYER_PATH")
    if environment_path:
        candidate = Path(environment_path.strip().strip('"'))
        if candidate.is_file():
            return candidate
        raise FileNotFoundError(f"POTPLAYER_PATH 指向的文件不存在：{candidate}")

    registry_manifest = _existing_registry_manifest()
    if registry_manifest is not None:
        candidate = _player_from_manifest(registry_manifest)
        if candidate is not None:
            return candidate

    for candidate in _common_potplayer_paths():
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "找不到 PotPlayerMini64.exe；请在 config.toml 的 [potplayer] path 中填写路径，"
        "或设置 POTPLAYER_PATH。不会进行全盘扫描。"
    )


def extension_id_from_key(key: str) -> str:
    decoded = base64.b64decode(key, validate=True)
    digest = hashlib.sha256(decoded).digest()[:16]
    alphabet = "abcdefghijklmnop"
    return "".join(alphabet[value >> 4] + alphabet[value & 0x0F] for value in digest)


def verify_extension(extension_dir: Path = EXTENSION_DIST) -> None:
    manifest_path = extension_dir / "manifest.json"
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    key = manifest.get("key")
    if not isinstance(key, str) or extension_id_from_key(key) != EXTENSION_ID:
        raise ValueError(f"扩展 ID 校验失败，必须保持 {EXTENSION_ID}")
    if manifest.get("manifest_version") != 3:
        raise ValueError("扩展不是 Manifest V3")


def write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(text)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def write_native_manifest(manifest_path: Path, host_path: Path) -> None:
    manifest = {
        "name": HOST_NAME,
        "description": "Native Messaging bridge for Emby/Jellyfin PotPlayer playback",
        "path": str(host_path.resolve()),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
    }
    write_text_atomic(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


def install_native_host(built_exe: Path, player_path: Path) -> tuple[Path, Path]:
    """Install beside PotPlayer when possible, with a no-admin fallback."""

    preferred_dir = player_path.parent
    installed_dir = preferred_dir
    installed_exe = preferred_dir / HOST_EXE_NAME
    try:
        shutil.copy2(built_exe, installed_exe)
    except OSError as error:
        installed_dir = ROOT / ".deploy" / "native-host"
        installed_dir.mkdir(parents=True, exist_ok=True)
        installed_exe = installed_dir / HOST_EXE_NAME
        shutil.copy2(built_exe, installed_exe)
        sidecar = {
            "potplayer_path": str(player_path.resolve()),
            "note": "Generated by pixi run deploy; contains no media URL or authentication data.",
        }
        write_text_atomic(installed_dir / "PotPlayerBridgeHost.config.json", json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n")
        print(f"PotPlayer 目录不可写，Host 已安装到：{installed_dir}")

    manifest_path = installed_dir / MANIFEST_NAME
    write_native_manifest(manifest_path, installed_exe)
    return installed_exe, manifest_path


def register_native_manifest(manifest_path: Path) -> None:
    if winreg is None:
        raise OSError("当前系统没有 Windows 注册表接口")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGISTRY_SUBKEY) as key:
        winreg.SetValueEx(key, None, 0, winreg.REG_SZ, str(manifest_path.resolve()))


def verify_native_manifest(manifest_path: Path) -> None:
    with manifest_path.open("r", encoding="utf-8-sig") as handle:
        manifest = json.load(handle)
    host_path = Path(manifest.get("path", ""))
    expected_origin = f"chrome-extension://{EXTENSION_ID}/"
    if manifest.get("name") != HOST_NAME or manifest.get("type") != "stdio":
        raise ValueError("Native Messaging manifest 的名称或类型不正确")
    if not host_path.is_file():
        raise FileNotFoundError(f"Native Messaging manifest 指向的 EXE 不存在：{host_path}")
    if expected_origin not in manifest.get("allowed_origins", []):
        raise ValueError("Native Messaging manifest 的 allowed_origins 与扩展 ID 不一致")


def open_extensions_page(chrome_path: Path) -> None:
    subprocess.Popen(
        [str(chrome_path), "chrome://extensions/"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def deploy(*, open_browser: bool = True) -> None:
    # Import here so `deploy.py` can still be imported for unit-level checks.
    sys.path.insert(0, str(ROOT / "scripts"))
    from build import build  # type: ignore[import-not-found]

    config = read_config()
    built_exe, extension_dir = build()
    verify_extension(extension_dir)
    chrome_path = find_chrome(config)
    player_path = find_potplayer(config)
    installed_exe, manifest_path = install_native_host(built_exe, player_path)
    register_native_manifest(manifest_path)
    verify_native_manifest(manifest_path)

    print(f"Chrome：{chrome_path}")
    print(f"PotPlayer：{player_path}")
    print(f"Native Host：{installed_exe}")
    print(f"Native Messaging manifest：{manifest_path}")
    print(f"固定扩展目录：{extension_dir}")
    if open_browser:
        try:
            open_extensions_page(chrome_path)
            print("已打开 chrome://extensions；首次使用请加载固定扩展目录，后续更新点击一次“重新加载”。")
        except OSError as error:
            print(f"无法自动打开 Chrome，请手动打开 chrome://extensions：{error}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build and deploy the PotPlayer bridge")
    parser.add_argument("--no-open", action="store_true", help="部署后不自动打开 chrome://extensions")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        deploy(open_browser=not args.no_open)
    except Exception as error:
        print(f"部署失败：{error}", file=sys.stderr)
        raise SystemExit(1)
