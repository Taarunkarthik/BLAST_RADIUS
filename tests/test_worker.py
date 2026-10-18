import pytest

from blastradius.worker import NodeWorker, WorkerError


def test_worker_handles_multiple_requests_in_one_process():
    with NodeWorker() as worker:
        pid = worker.process.pid
        first = worker.request("ping")
        second = worker.request("ping")
        assert first == second
        assert first["protocol"] == 1
        assert worker.process.pid == pid
        with pytest.raises(WorkerError, match="Unknown parser method"):
            worker.request("unknown")
        assert worker.request("ping") == first
    assert worker.process.poll() is not None
