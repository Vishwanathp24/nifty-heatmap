"""Render entry point: `uvicorn backend.main:app` from the repo root.

The backend modules import each other as top-level modules (import sources,
from engine import ...), so put this folder on sys.path before loading app.py.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app  # noqa: E402,F401
