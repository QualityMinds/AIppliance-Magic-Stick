"""Test-only import paths; never copied to runtime images."""
from pathlib import Path
import sys

for root in Path(__file__).resolve().parents:
    if (root / 'core/magicstick_core/private_mesh').is_dir():
        sys.path[:0] = [str(root / path) for path in (
            'core', 'core/magicstick_core/private_mesh', 'dashboard/apps/api')]
        break
