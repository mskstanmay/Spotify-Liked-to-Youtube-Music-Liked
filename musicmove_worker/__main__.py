from __future__ import annotations

import logging
import signal
import sys

from .config import WorkerConfig
from .db import Database
from .worker import MigrationWorker


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    logger = logging.getLogger("musicmove_worker")
    try:
        config = WorkerConfig.from_env()
        db = Database(config.database_url)
        db.open()
    except Exception as error:
        print(f"[worker] startup failed: {error}", file=sys.stderr)
        return 1

    worker = MigrationWorker(db, config, logger=logger)

    def stop(_signum, _frame) -> None:
        worker.stop()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(f"[worker] {worker.id} ready", flush=True)
    try:
        worker.start()
        return 0
    finally:
        try:
            db.remove_runtime(worker.id)
        except Exception:
            pass
        worker.close()
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
