"""Local-only JSON, YAML, HTML, Markdown and stylesheet-reference checks."""

import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

import yaml
from markdown_it import MarkdownIt

from blastradius.models import Issue


def local_target(root: Path, file: str, target: str) -> Path | None:
    """None means a nonlocal/anchor-only reference; escaping paths never exist locally."""
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None
    decoded = unquote(parsed.path)
    if decoded.startswith("/"):
        candidate = root / decoded.lstrip("/")
    else:
        candidate = root / Path(file).parent / decoded
    candidate = candidate.resolve()
    if not candidate.is_relative_to(root):
        raise ValueError("Reference leaves the scan root")
    return candidate


def missing_target(root: Path, file: str, target: str) -> bool:
    try:
        candidate = local_target(root, file, target)
        return candidate is not None and not candidate.exists()
    except (OSError, ValueError):
        return True


def _json_pointer(document, fragment):
    fragment = unquote(fragment)
    if not fragment:
        return True
    if not fragment.startswith("/"):
        # JSON Schema named anchors are local metadata, not JSON Pointers.
        pending, seen = [document], set()
        while pending:
            current = pending.pop()
            if isinstance(current, (dict, list)):
                if id(current) in seen:
                    continue
                seen.add(id(current))
            if isinstance(current, dict):
                if current.get("$anchor") == fragment or current.get("$dynamicAnchor") == fragment or current.get("$id") == f"#{fragment}":
                    return True
                pending.extend(current.values())
            elif isinstance(current, list):
                pending.extend(current)
        return False
    current = document
    for token in fragment[1:].split("/"):
        if re.search(r"~(?![01])", token):
            return False
        token = token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict) and token in current:
            current = current[token]
        elif isinstance(current, list) and re.fullmatch(r"0|[1-9][0-9]*", token) and int(token) < len(current):
            current = current[int(token)]
        else:
            return False
    return True


def check_json(root: Path, file: str, content: str) -> list[Issue]:
    try:
        document = json.loads(content, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Non-JSON value {value}")))
    except (ValueError, RecursionError) as error:
        return [Issue(file, getattr(error, "lineno", 1), "invalid_json", "medium", message=str(error))]
    issues = []
    # A syntax-aware pass above ensures these are actual JSON string values.
    for match in re.finditer(r'"\$ref"\s*:\s*("(?:[^"\\]|\\.)*")', content):
        target = json.loads(match[1])
        line = content.count("\n", 0, match.start()) + 1
        try:
            url = urlsplit(target)
            if url.scheme or url.netloc:
                continue
            candidate = local_target(root, file, target)
            referenced = document
            if candidate is not None:
                if not candidate.is_file():
                    raise ValueError("Referenced file does not exist")
                if url.fragment:
                    if candidate.stat().st_size > 2_000_000:
                        # Report the unvalidated reference honestly instead of reading an unbounded file.
                        raise ValueError("Referenced JSON exceeds the 2 MB reference-validation limit")
                    referenced = json.loads(candidate.read_text(encoding="utf-8-sig"))
            if url.fragment and not _json_pointer(referenced, url.fragment):
                raise ValueError("JSON fragment does not exist")
        except (OSError, ValueError, RecursionError) as error:
            issues.append(Issue(file, line, "broken_json_ref", "medium", target, str(error)))
    return issues


def check_yaml(file: str, content: str) -> list[Issue]:
    issues = []
    scalar_lines = set()
    for number, line in enumerate(content.splitlines(), 1):
        if "\t" in re.match(r"^[ \t]*", line)[0]:
            issues.append(Issue(file, number, "tabs_in_yaml", "medium", message="Tab character in YAML indentation."))
    try:
        # Compose nodes rather than constructing Python objects: custom tags stay inert,
        # alias trees are not expanded, and multi-document YAML is accepted.
        pending = list(yaml.compose_all(content, Loader=yaml.SafeLoader))
        visited = set()
        while pending:
            node = pending.pop()
            if node is None or id(node) in visited:
                continue
            visited.add(id(node))
            if isinstance(node, yaml.ScalarNode) and node.style in {"|", ">"}:
                scalar_lines.update(range(node.start_mark.line + 2, node.end_mark.line + 1))
            elif isinstance(node, yaml.MappingNode):
                pending.extend(child for pair in node.value for child in pair)
            elif isinstance(node, yaml.SequenceNode):
                pending.extend(node.value)
    except (yaml.YAMLError, RecursionError) as error:
        mark = getattr(error, "problem_mark", None)
        line = mark.line + 1 if mark else 1
        if not any(item.type == "tabs_in_yaml" and item.line == line for item in issues):
            message = getattr(error, "problem", None) or "Invalid or excessively nested YAML."
            issues.append(Issue(file, line, "invalid_yaml", "medium", message=message))
    return [issue for issue in issues if not (issue.type == "tabs_in_yaml" and issue.line in scalar_lines)]


class AssetParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.references = []
        self.base = None

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "base":
            if self.base is None:
                self.base = values.get("href")
            return
        fields = {"src", "poster"}
        if tag in {"a", "link", "area"}:
            fields.add("href")
        if tag == "object":
            fields.add("data")
        for field in fields:
            if values.get(field):
                self.references.append((self.getpos()[0], values[field]))
        if values.get("srcset"):
            # URLs are non-whitespace tokens; data-URL commas stay within their URL.
            remaining = values["srcset"]
            while remaining:
                remaining = remaining.lstrip(" ,\t\r\n")
                match = re.match(r"\S+" if remaining.startswith("data:") else r"[^\s,]+,?", remaining)
                if not match:
                    break
                target = match[0]
                remaining = remaining[match.end():]
                if target.endswith(","):
                    target = target.rstrip(",")
                elif remaining:
                    _, separator, remaining = remaining.partition(",")
                    if not separator:
                        remaining = ""
                self.references.append((self.getpos()[0], target))

    handle_startendtag = handle_starttag


def check_html(root: Path, file: str, content: str, *, offset=0) -> list[Issue]:
    parser = AssetParser()
    parser.feed(content)
    issues = []
    for line, target in parser.references:
        resolved = urljoin(parser.base, target) if parser.base else target
        if missing_target(root, file, resolved):
            issues.append(Issue(file, line + offset, "missing_asset", "medium", target, "Local asset or page does not exist."))
    return issues


def check_markdown(root: Path, file: str, content: str) -> list[Issue]:
    issues = []
    for token in MarkdownIt("commonmark").parse(content):
        line = token.map[0] + 1 if token.map else 1
        if token.type == "html_block":
            for issue in check_html(root, file, token.content, offset=line - 1):
                issues.append(Issue(file, issue.line, "broken_link", "low", issue.target, issue.message))
        if token.type != "inline":
            continue
        for child in token.children or []:
            target = child.attrGet("href") if child.type == "link_open" else child.attrGet("src") if child.type == "image" else None
            if target and missing_target(root, file, target):
                issues.append(Issue(file, line, "broken_link", "low", target, "Local link or image does not exist."))
            if child.type == "html_inline":
                for issue in check_html(root, file, child.content, offset=line - 1):
                    issues.append(Issue(file, issue.line, "broken_link", "low", issue.target, issue.message))
            if child.type in {"softbreak", "hardbreak"}:
                line += 1
            elif child.type in {"text", "code_inline"}:
                line += child.content.count("\n")
    return issues


def check_css_references(root: Path, file: str, references: list[dict]) -> tuple[list[Issue], list[dict]]:
    issues, limitations = [], []
    for reference in references:
        target = reference["target"]
        if "#{" in target or target.startswith(("~", "$")):
            limitations.append({"file": file, "line": reference["line"], "target": target, "reason": "Sass interpolation or package load paths are not statically resolved."})
            continue
        try:
            candidate = local_target(root, file, target)
            if candidate is None:
                continue
            choices = [candidate]
            if file.endswith(".scss"):
                for suffix in (".scss", ".css"):
                    named = candidate if candidate.suffix else candidate.with_suffix(suffix)
                    choices.extend([named, named.with_name("_" + named.name)])
                    choices.extend([candidate / ("index" + suffix), candidate / ("_index" + suffix)])
            exists = any(choice.is_file() and choice.resolve().is_relative_to(root) for choice in choices)
        except (OSError, ValueError):
            exists = False
        if not exists:
            issues.append(Issue(file, reference["line"], "missing_css_import", "medium", target, "Local stylesheet import does not exist."))
    return issues, limitations
