import os
import subprocess
import sys

import pytest

from blastradius.checkers import (
    CheckerUnavailable,
    available_bash,
    check_dotenv,
    check_html,
    check_ini,
    check_json,
    check_mako,
    check_markdown,
    check_python,
    check_shell,
    check_sql,
    check_svg,
    check_toml,
    check_yaml,
)


@pytest.mark.parametrize("checker,file,valid,invalid,line,kind", [
    (check_toml, "project.toml", '[tool]\nname = "demo"\n', '[tool]\nname = ?\n', 2, "invalid_toml"),
    (check_ini, "settings.ini", '[app]\nurl = %(literal)s\npercent = 50%\n', '[app]\nbad line\n', 2, "invalid_ini"),
    (check_svg, "icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', '<svg>\n<path></svg>', 2, "invalid_svg"),
    (check_python, "main.py", 'def main():\n    return 1\n', 'value = 1\ndef broken(:\n', 2, "invalid_python"),
    (check_dotenv, ".env", '# comment\n\nKEY=value\nEMPTY=\nexport FOO=bar\n', '# comment\nnot an assignment\n', 2, "invalid_dotenv"),
    (check_dotenv, ".env.example", 'TOKEN="replace me"\n', 'TOKEN: replace me\n', 1, "invalid_dotenv"),
])
def test_stdlib_checkers_valid_and_invalid(checker, file, valid, invalid, line, kind):
    assert checker(file, valid) == []
    issues = checker(file, invalid)
    assert [(issue.file, issue.line, issue.type, issue.severity) for issue in issues] == [(file, line, kind, "medium")]


def test_toml_end_of_document_and_ini_missing_section():
    assert check_toml("a.toml", 'value = [\n')[0].line == 2
    assert check_ini("a.ini", "name=value\n")[0].type == "invalid_ini"
    assert check_ini("a.ini", "[x]\na=1\na=2\n")[0].line == 3


def test_dotenv_reports_each_bad_line_without_echoing_values():
    issues = check_dotenv(".env", "export NAME\n  # comment\nKEY = value\n123BAD=secret\nsecret line\n")
    assert [issue.line for issue in issues] == [4, 5]
    assert all("secret" not in issue.message and not issue.target for issue in issues)


def test_python_and_svg_are_never_executed_or_fetched(tmp_path):
    marker = tmp_path / "must-not-exist"
    code = f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')\n"
    assert check_python("main.py", code) == []
    svg = '<!DOCTYPE svg SYSTEM "https://invalid.example/dtd"><svg><script>throw Error("inert")</script><image href="https://invalid.example/a.png"/></svg>'
    assert check_svg("icon.svg", svg) == []
    assert not marker.exists()


def test_shell_valid_and_invalid_use_only_bounded_stdin(monkeypatch):
    monkeypatch.setattr("blastradius.checkers.shutil.which", lambda _: "/trusted/bash")
    monkeypatch.setenv("BASH_ENV", "must-not-be-sourced")
    monkeypatch.setenv("ENV", "must-not-be-sourced")
    calls = []
    def run(args, **kwargs):
        calls.append((args, kwargs))
        assert args == ["/trusted/bash", "--noprofile", "--norc", "-n"]
        assert "BASH_ENV" not in kwargs["env"] and "ENV" not in kwargs["env"]
        assert not kwargs.get("shell", False)
        if kwargs["input"] == "if then\n":
            return subprocess.CompletedProcess(args, 2, "", "bash: line 1: syntax error near unexpected token `then'\n")
        return subprocess.CompletedProcess(args, 0, "", "")
    monkeypatch.setattr("blastradius.checkers.subprocess.run", run)
    assert check_shell("script.sh", "echo hello\n") == []
    issue = check_shell("script.sh", "if then\n")[0]
    assert (issue.type, issue.line, issue.severity) == ("invalid_shell", 1, "medium")
    assert len(calls) == 2


def test_shell_real_bash_is_syntax_only(tmp_path, monkeypatch):
    marker = tmp_path / "executed"
    startup = tmp_path / "startup"
    startup.write_text(f"echo executed > '{marker.as_posix()}'\n")
    monkeypatch.setenv("BASH_ENV", str(startup))
    try:
        assert check_shell("script.sh", f"echo executed > '{marker.as_posix()}'\n") == []
    except CheckerUnavailable:
        pytest.skip("No usable bash on PATH")
    assert check_shell("script.sh", "if then\n")[0].type == "invalid_shell"
    assert not marker.exists()


def test_shell_missing(monkeypatch):
    monkeypatch.setattr("blastradius.checkers.shutil.which", lambda _: None)
    with pytest.raises(CheckerUnavailable):
        check_shell("a.sh", "invalid")


def test_shell_unusable_and_timed_out(monkeypatch):
    monkeypatch.setattr("blastradius.checkers.shutil.which", lambda _: "bash")
    monkeypatch.setattr("blastradius.checkers.subprocess.run", lambda *a, **k: subprocess.CompletedProcess(a, 1, "WSL unavailable", ""))
    with pytest.raises(CheckerUnavailable):
        check_shell("a.sh", "invalid")
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 10)
    monkeypatch.setattr("blastradius.checkers.subprocess.run", timeout)
    with pytest.raises(OSError, match="deadline"):
        check_shell("a.sh", "invalid")


@pytest.mark.skipif(os.name != "nt", reason="Windows WSL launcher")
def test_windows_wsl_launcher_stays_unsupported(monkeypatch):
    monkeypatch.setattr("blastradius.checkers.shutil.which", lambda _: r"C:\Windows\System32\bash.exe")
    assert available_bash() is None
    with pytest.raises(CheckerUnavailable):
        check_shell("a.sh", "echo inert")


def test_sql_valid_and_invalid():
    pytest.importorskip("sqlglot")
    assert check_sql("query.sql", "CREATE TABLE things (id INTEGER); SELECT id FROM things;") == []
    issue = check_sql("query.sql", "SELECT 1;\nSELECT * FROM (SELECT 1;")[0]
    assert (issue.type, issue.line, issue.severity) == ("invalid_sql", 2, "medium")
    assert check_sql("query.sql", "SELECT 'unterminated")[0].type == "invalid_sql"


def test_mako_valid_invalid_and_module_python_stays_inert(tmp_path):
    pytest.importorskip("mako")
    marker = tmp_path / "executed"
    template = f'<%!\nfrom pathlib import Path\nPath({str(marker)!r}).write_text("executed")\n%>Hello ${{name}}'
    assert check_mako("view.mako", template) == []
    assert check_mako("view.mako", '<%include file="https://invalid.example/not-fetched"/>') == []
    issue = check_mako("view.mako", "Hello\n${1 + }")[0]
    assert (issue.type, issue.line, issue.severity) == ("invalid_mako", 2, "medium")
    assert check_mako("view.mako", "% if True:\nmissing endif")[0].type == "invalid_mako"
    assert not marker.exists()


def test_optional_python_parsers_missing(monkeypatch):
    monkeypatch.setattr("blastradius.checkers.optional_parser", lambda _: None)
    for checker, file in [(check_sql, "a.sql"), (check_mako, "a.mako")]:
        with pytest.raises(CheckerUnavailable):
            checker(file, "anything")


@pytest.mark.parametrize("module", ["sqlglot", "mako"])
def test_optional_parser_does_not_execute_shadowing_project_module(tmp_path, module):
    marker = tmp_path / "executed"
    (tmp_path / f"{module}.py").write_text(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
    source = (
        "import sys; from blastradius.checkers import optional_parser; "
        f"sys.path.insert(0, {str(tmp_path)!r}); "
        f"assert optional_parser({module!r}) is None"
    )
    result = subprocess.run([sys.executable, "-c", source], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert not marker.exists()


@pytest.mark.parametrize("content", ['{"x":}', '{"x":1,}', '{"x":NaN}', '{"x":Infinity}'])
def test_json_syntax_is_strict(repository, content):
    root = repository({})
    assert check_json(root, "config.json", content)[0].type == "invalid_json"


def test_json_refs_files_pointers_escaped_keys_and_anchors(repository):
    root = repository({"defs.json": {"a/b": {"~key": [True]}, "model": {"$anchor": "person"}}})
    assert not check_json(root, "schema.json", '{"$ref":"defs.json#/a~1b/~0key/0"}')
    assert not check_json(root, "schema.json", '{"$ref":"defs.json#person"}')
    assert not check_json(root, "schema.json", '{"$ref":"https://invalid.example/schema"}')
    issues = check_json(root, "schema.json", '{\n"$ref":"defs.json#/absent"\n}')
    assert issues[0].type == "broken_json_ref"
    assert issues[0].line == 2
    assert check_json(root, "schema.json", '{"$ref":"missing.json"}')


def test_json_local_cycle_does_not_recurse(repository):
    root = repository({})
    assert not check_json(root, "schema.json", '{"$ref":"#"}')


def test_yaml_multidoc_custom_tags_and_aliases_are_inert():
    assert not check_yaml("ci.yaml", 'a: !Custom value\n---\nb: &b [*b]\n')
    assert not check_yaml("ci.yaml", '!!python/object/apply:os.system ["must-not-run"]')
    assert check_yaml("ci.yaml", "a: [unfinished")[0].type == "invalid_yaml"


def test_yaml_tabs_report_line_without_duplicate_parse_error():
    issues = check_yaml("ci.yaml", "a:\n\tb: 1\n")
    assert len(issues) == 1
    assert issues[0].type == "tabs_in_yaml"
    assert issues[0].line == 2


def test_yaml_tabs_inside_block_scalar_are_content():
    assert not check_yaml("ci.yaml", "script: |\n  \tprintf hello\n")


def test_html_assets_base_queries_encoded_paths_and_remote_urls(repository):
    root = repository({"public/a b.png": b"png", "public/main.js": ""})
    content = '''<base href="/public/">
<img src="a%20b.png?v=1#x">
<script src="main.js"></script>
<img src="https://example.invalid/no.png">
<a href="#section">link</a>
<img src="missing.png">
'''
    issues = check_html(root, "pages/index.html", content)
    assert [(item.line, item.target) for item in issues] == [(6, "missing.png")]


def test_html_srcset_with_data_url(repository):
    root = repository({"ok.png": b"png"})
    issues = check_html(root, "index.html", '<img srcset="data:image/png;base64,AAAA 1x, ok.png 2x, missing.png 3x">')
    assert [item.target for item in issues] == ["missing.png"]


def test_html_srcset_without_whitespace(repository):
    root = repository({"ok.png": b"png"})
    issues = check_html(root, "index.html", '<img srcset="ok.png,missing.png">')
    assert [item.target for item in issues] == ["missing.png"]


def test_markdown_uses_parser_skips_code_and_checks_reference_links(repository):
    root = repository({"exists.md": ""})
    text = '''[valid](exists.md#anything)
[bad][ref]

[ref]: missing.md

`[not a link](skip.md)`

```markdown
[also not](skip2.md)
```

![picture](missing.png)
'''
    issues = check_markdown(root, "README.md", text)
    assert [(issue.line, issue.target) for issue in issues] == [(2, "missing.md"), (12, "missing.png")]


def test_links_outside_root_are_not_read(repository):
    root = repository({})
    assert check_markdown(root, "README.md", "[outside](../outside.txt)")[0].type == "broken_link"

