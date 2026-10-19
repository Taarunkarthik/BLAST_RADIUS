"""Read-only syntax and local-reference checks; scanned code is never executed."""

import ast
import configparser
import importlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tomllib
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from importlib.metadata import distribution
from pathlib import Path
from types import ModuleType
from typing import cast
from urllib.parse import unquote, urljoin, urlsplit

import yaml
from markdown_it import MarkdownIt

from blastradius.models import Issue


class CheckerUnavailable(RuntimeError):
    """An optional parser cannot run; its files remain unsupported."""


def optional_parser(name: str) -> ModuleType | None:
    try:
        package = name.split(".", 1)[0]
        # Do not import a scanned sqlglot.py/mako.py that shadows the installed
        # dependency on sys.path. Looking up a top-level spec does not execute it.
        installed = Path(str(distribution(package).locate_file(package))).resolve()
        spec = importlib.util.find_spec(package)
        if spec is None or spec.origin is None or not Path(spec.origin).resolve().is_relative_to(installed):
            return None
        return importlib.import_module(name)
    except (ImportError, OSError, ValueError):
        return None


def _error_line(message: str, content: str) -> int:
    match = re.search(r"\bline[ :]+(\d+)", message, re.IGNORECASE)
    if match:
        return max(1, int(match[1]))
    return content.count("\n") + 1 if "end of document" in message else 1


def check_toml(file: str, content: str) -> list[Issue]:
    try:
        tomllib.loads(content)
    except (tomllib.TOMLDecodeError, RecursionError) as error:
        line = getattr(error, "lineno", None) or _error_line(str(error), content)
        return [Issue(file, line, "invalid_toml", "medium", message=str(error))]
    return []


def check_ini(file: str, content: str) -> list[Issue]:
    try:
        # Values are inert; percent signs and interpolation-like strings are valid.
        configparser.ConfigParser(interpolation=None).read_string(content, source=file)
    except configparser.Error as error:
        line = getattr(error, "lineno", None)
        if line is None:
            errors = getattr(error, "errors", [])
            line = errors[0][0] if errors else 1
        return [Issue(file, line, "invalid_ini", "medium", message=f"Invalid INI syntax ({type(error).__name__}).")]
    return []


def check_svg(file: str, content: str) -> list[Issue]:
    try:
        # ElementTree does not retrieve external entities or execute SVG scripts.
        ET.fromstring(content)
    except ET.ParseError as error:
        return [Issue(file, error.position[0], "invalid_svg", "medium", message=str(error))]
    return []


def check_python(file: str, content: str) -> list[Issue]:
    try:
        ast.parse(content, filename=file)
    except (SyntaxError, ValueError, RecursionError) as error:
        return [Issue(file, getattr(error, "lineno", None) or 1, "invalid_python", "medium",
                      message=getattr(error, "msg", None) or "Invalid or excessively nested Python syntax.")]
    return []


def check_dotenv(file: str, content: str) -> list[Issue]:
    issues = []
    for line, text in enumerate(content.splitlines(), 1):
        text = text.strip()
        if not text or text.startswith("#") or re.match(r"export(?:\s|$)", text):
            continue
        if not re.match(r"[A-Za-z_][A-Za-z0-9_]*\s*=", text):
            # Never echo environment values in diagnostics.
            issues.append(Issue(file, line, "invalid_dotenv", "medium", message="Expected KEY=value, an export declaration, or a comment."))
    return issues


def available_bash() -> str | None:
    bash = shutil.which("bash")
    # Windows' legacy WSL launcher is not a Bash executable: it can initialize a
    # distro or hang instead of honoring Bash's no-execution/startup flags.
    if bash and os.name == "nt" and Path(bash).parent.name.lower() in {"system32", "sysnative"}:
        return None
    return bash


def check_shell(file: str, content: str) -> list[Issue]:
    bash = available_bash()
    if bash is None:
        raise CheckerUnavailable("Bash is not installed.")
    # A clean startup environment prevents BASH_ENV and exported shell functions
    # from executing before -n. Feed only the already bounded text via stdin.
    env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP") if key in os.environ}
    env.update(LANG="C", LC_ALL="C")
    try:
        result = subprocess.run(
            [bash, "--noprofile", "--norc", "-n"], input=content, text=True,
            encoding="utf-8", errors="replace", capture_output=True, timeout=10,
            env=env, check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as error:
        raise OSError("Shell syntax check exceeded its deadline.") from error
    except OSError as error:
        raise CheckerUnavailable("Bash could not be started.") from error
    if result.returncode == 0:
        return []
    if result.returncode != 2 or not re.search(r"\bline[ :]+\d+", result.stderr):
        # Windows may expose a WSL launcher named bash without a usable shell.
        raise CheckerUnavailable("Bash is installed but unavailable.")
    return [Issue(file, _error_line(result.stderr, content), "invalid_shell", "medium",
                  message="Bash reported a shell syntax error.")]


def check_sql(file: str, content: str) -> list[Issue]:
    parser = optional_parser("sqlglot")
    if parser is None:
        raise CheckerUnavailable("Install the languages extra for SQL parsing.")
    try:
        # Default SQLGlot dialect is a broad syntax superset, not a database check.
        parser.parse(content, error_level=parser.ErrorLevel.RAISE)
    except parser.errors.ParseError as error:
        return [Issue(file, detail.get("line") or 1, "invalid_sql", "medium",
                      message=detail.get("description") or "Invalid SQL syntax.")
                for detail in error.errors] or [Issue(file, 1, "invalid_sql", "medium", message="Invalid SQL syntax.")]
    except (parser.errors.TokenError, RecursionError) as error:
        return [Issue(file, _error_line(str(error), content), "invalid_sql", "medium", message="Invalid or excessively nested SQL syntax.")]
    return []


def check_mako(file: str, content: str) -> list[Issue]:
    lexer = optional_parser("mako.lexer")
    exceptions = optional_parser("mako.exceptions")
    if lexer is None or exceptions is None:
        raise CheckerUnavailable("Install the languages extra for Mako parsing.")
    try:
        # Lexer parses template/Python syntax only. Template() would compile and
        # execute module-level Python, so it must never be used for scanning.
        lexer.Lexer(content, filename=file).parse()
    except (exceptions.SyntaxException, exceptions.CompileException, RecursionError) as error:
        return [Issue(file, getattr(error, "lineno", None) or 1, "invalid_mako", "medium", message="Invalid Mako template syntax.")]
    return []


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
    scalar_lines: set[int] = set()
    for number, line in enumerate(content.splitlines(), 1):
        prefix = re.match(r"^[ \t]*", line)
        if prefix and "\t" in prefix[0]:
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
        error_line = mark.line + 1 if mark else 1
        if not any(item.type == "tabs_in_yaml" and item.line == error_line for item in issues):
            message = getattr(error, "problem", None) or "Invalid or excessively nested YAML."
            issues.append(Issue(file, error_line, "invalid_yaml", "medium", message=message))
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
            target = cast(str | None, child.attrGet("href") if child.type == "link_open" else child.attrGet("src") if child.type == "image" else None)
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
