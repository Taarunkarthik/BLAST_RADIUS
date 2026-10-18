import pytest

from blastradius.checkers import check_html, check_json, check_markdown, check_yaml


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

