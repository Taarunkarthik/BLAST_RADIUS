"""Small immutable records shared by independent checking and graph stages."""

from dataclasses import asdict, dataclass

JS_EXTENSIONS = frozenset({".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"})
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}
ISSUE_TYPES = frozenset({
    "undeclared_external_package", "missing_local_module", "declared_but_not_installed",
    "invalid_path", "unsupported_resolution", "parse_error", "invalid_css",
    "missing_css_import", "invalid_json", "broken_json_ref", "invalid_yaml",
    "tabs_in_yaml", "missing_asset", "broken_link", "version_mismatch",
    "invalid_toml", "invalid_ini", "invalid_svg", "invalid_python", "invalid_dotenv",
    "invalid_shell", "invalid_sql", "invalid_mako",
})


@dataclass(frozen=True)
class Issue:
    file: str
    line: int
    type: str
    severity: str
    target: str = ""
    message: str = ""

    def __post_init__(self):
        if self.type not in ISSUE_TYPES or self.severity not in SEVERITY_ORDER:
            raise ValueError("Unknown issue type or severity")

    def to_dict(self):
        return asdict(self)

    def sort_key(self):
        return (SEVERITY_ORDER[self.severity], self.file, self.line, self.type, self.target, self.message)


def is_declaration(file: str) -> bool:
    return file.endswith((".d.ts", ".d.mts", ".d.cts"))

