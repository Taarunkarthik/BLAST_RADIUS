import json

import pytest


@pytest.fixture
def repository(tmp_path):
    def make(files):
        for name, content in files.items():
            path = tmp_path / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                path.write_bytes(content)
            else:
                path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
        return tmp_path
    return make

