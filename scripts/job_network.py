"""Capture job counters before dependencies are installed; standard-library only."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.domain import AssetError  # noqa: E402
from app.job_network import start  # noqa: E402

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", default="private/job-network.json")
try:
    print(json.dumps(start(parser.parse_args().output)))
except AssetError as error:
    print(json.dumps({"error_code": error.code}))
    sys.exit(1)
