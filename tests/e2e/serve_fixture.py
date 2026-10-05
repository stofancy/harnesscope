"""Runs the actual Python server against temporary synthetic source roots."""
import argparse
import json
import os
from pathlib import Path
import tempfile

from fixture_logs import prepare

parser = argparse.ArgumentParser()
parser.add_argument('--port', required=True, type=int)
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='harnesscope-browser-') as directory:
    root = prepare(directory)
    os.environ.update({
        'CODEX_HOME': str(root / 'codex'),
        'CLAUDE_CONFIG_DIR': str(root / 'claude'),
        'OMP_SESSIONS_DIR': str(root / 'omp'),
        'PI_CODING_AGENT_DIR': str(root / 'omp/agent'),
        'DSH_HOME': str(root / 'dsh'),
        'HARNESCOPE_SESSIONS_DIR': str(root / 'codex/sessions'),
        'HARNESCOPE_ARCHIVE_DIR': str(root / 'codex/archived_sessions'),
        'HARNESCOPE_CACHE_DIR': str(root / 'cache'),
        'HARNESCOPE_PRICING_FILE': str(root / 'pricing.json'),
        'HARNESCOPE_CODEX_CONFIG': str(root / 'codex/config.toml'),
    })
    # The browser test mutates only this known temporary source. Never a real home.
    state = Path('.e2e/fixture-state.json')
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps({'root': str(root)}))
    try:
        import uvicorn
        from harnesscope.server import create_app
        uvicorn.run(create_app(), host='127.0.0.1', port=args.port, log_level='warning')
    finally:
        state.unlink(missing_ok=True)
