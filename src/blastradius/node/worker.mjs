// Protocol v1. This worker reads source/configuration but never loads project code.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import postcss from 'postcss';
import scss from 'postcss-scss';
import semver from 'semver';

const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const assetPattern = /\.(?:css|scss|sass|less|json|ya?ml|html?|md|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|mp[34]|wav|pdf|txt|wasm)$/i;
const posix = value => value.split(path.sep).join('/');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const issue = (file, line, type, target = '', message = '', severity = 'high') => ({ file, line, type, severity, target, message });

function ancestors(start, root) {
  const result = [];
  let current = start;
  while (inside(root, current)) {
    result.push(current);
    if (current === root) break;
    current = path.dirname(current);
  }
  return result;
}

function analyze({ root: rootInput, files }) {
  const root = path.resolve(rootInput);
  const configCache = new Map();
  const directoryConfigCache = new Map();
  const manifestCache = new Map();
  const directoryManifestCache = new Map();
  const existenceCache = new Map();
  const realpathCache = new Map();
  const packageCache = new Map();
  const sourceFiles = new Map(files.filter(input => input.checker === 'javascript').map(input => {
    const absolute = path.resolve(root, input.file);
    return [absolute, ts.createSourceFile(absolute, input.content, ts.ScriptTarget.Latest, true)];
  }));
  // A memory-only compiler host supplies grammar checks and lexical binding. No
  // standard libraries, project modules, emit, or semantic diagnostics are loaded.
  let syntaxProgram;
  const program = () => {
    if (!syntaxProgram) {
      syntaxProgram = ts.createProgram([...sourceFiles.keys()], {
        allowJs: true, noLib: true, noResolve: true, noEmit: true,
        target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve,
      }, {
        getSourceFile: name => sourceFiles.get(path.resolve(name)),
        getDefaultLibFileName: () => '', writeFile: () => {},
        getCurrentDirectory: () => root, getDirectories: () => [],
        fileExists: name => sourceFiles.has(path.resolve(name)),
        readFile: name => sourceFiles.get(path.resolve(name))?.text,
        getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
      });
    }
    return syntaxProgram;
  };
  const fileExists = file => {
    if (!existenceCache.has(file)) {
      try { existenceCache.set(file, fs.statSync(file).isFile()); }
      catch { existenceCache.set(file, false); }
    }
    return existenceCache.get(file);
  };
  const result = [];
  function configuration(file) {
    const directory = path.dirname(file);
    if (directoryConfigCache.has(directory)) return directoryConfigCache.get(directory);
    let config;
    for (const parent of ancestors(directory, root)) {
      config = ['tsconfig.json', 'jsconfig.json'].map(name => path.join(parent, name)).find(fileExists);
      if (config) break;
    }
    if (!configCache.has(config)) {
      let options = {
        allowJs: true, jsx: ts.JsxEmit.Preserve, resolveJsonModule: true,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.Latest,
      };
      let errors = [];
      if (config) {
        const read = ts.readConfigFile(config, ts.sys.readFile);
        if (read.error) errors = [read.error];
        else {
          const parsed = ts.parseJsonConfigFileContent(read.config, { ...ts.sys, readDirectory: () => [] }, path.dirname(config), undefined, config);
          options = { ...options, ...parsed.options };
          errors = parsed.errors.filter(error => ![18002, 18003].includes(error.code));
        }
      }
      configCache.set(config, { options, errors, cache: ts.createModuleResolutionCache(root, name => name, options) });
    }
    const value = configCache.get(config);
    directoryConfigCache.set(directory, value);
    return value;
  }

  function manifest(file) {
    const directory = path.dirname(file);
    if (directoryManifestCache.has(directory)) return directoryManifestCache.get(directory);
    for (const parent of ancestors(directory, root)) {
      const candidate = path.join(parent, 'package.json');
      if (fileExists(candidate)) {
        if (!manifestCache.has(candidate)) manifestCache.set(candidate, readJson(candidate) || {});
        const value = manifestCache.get(candidate);
        directoryManifestCache.set(directory, value);
        return value;
      }
    }
    directoryManifestCache.set(directory, {});
    return directoryManifestCache.get(directory);
  }

  function installedPackage(file, name) {
    const key = `${path.dirname(file)}:${name}`;
    if (packageCache.has(key)) return packageCache.get(key);
    for (const parent of ancestors(path.dirname(file), root)) {
      const directory = path.join(parent, 'node_modules', name);
      if (fileExists(path.join(directory, 'package.json'))) {
        packageCache.set(key, readJson(path.join(directory, 'package.json')) || {});
        return packageCache.get(key);
      }
      // Packages can omit package.json while still exposing index.js.
      if (fileExists(path.join(directory, 'index.js'))) { packageCache.set(key, {}); return {}; }
    }
    packageCache.set(key, null);
    return null;
  }

  for (const input of files) {
    const file = input.file;
    const absolute = path.resolve(root, file);
    if (!inside(root, absolute)) throw new Error('Input file is outside the scan root.');
    const output = { file, issues: [], imports: [], ignored_imports: [], limitations: [] };
    if (input.checker === 'jsonc') {
      const parsed = ts.parseConfigFileTextToJson(file, input.content);
      if (parsed.error) {
        const line = parsed.error.file ? parsed.error.file.getLineAndCharacterOfPosition(parsed.error.start || 0).line + 1 : 1;
        output.issues.push(issue(file, line, 'invalid_json', '', ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'), 'medium'));
      } else output.parsed_json = parsed.config;
      result.push(output);
      continue;
    }
    if (input.checker === 'css') {
      output.references = [];
      try {
        const tree = /\.scss$/i.test(file) ? scss.parse(input.content, { from: file }) : postcss.parse(input.content, { from: file });
        tree.walkAtRules(/^(import|use|forward)$/i, rule => {
          // Sass interpolation and load-path modules cannot be resolved without a build configuration.
          for (const match of rule.params.matchAll(/(?:url\(\s*)?["']([^"']+)["']|url\(\s*([^\s)]+)\s*\)/g)) {
            output.references.push({ target: match[1] || match[2], line: rule.source.start.line, directive: rule.name });
          }
        });
      } catch (error) {
        output.issues.push(issue(file, error.line || 1, 'invalid_css', '', error.reason || 'Invalid stylesheet syntax', 'medium'));
      }
      result.push(output);
      continue;
    }
    const source = sourceFiles.get(absolute);
    const diagnostics = /\.(?:[cm]?js|jsx)$/i.test(file) ? program().getSyntacticDiagnostics(source) : source.parseDiagnostics;
    for (const diagnostic of diagnostics) {
      const line = source.getLineAndCharacterOfPosition(diagnostic.start || 0).line + 1;
      output.issues.push(issue(file, line, 'parse_error', '', ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')));
    }
    const config = configuration(absolute);
    for (const error of config.errors) {
      output.issues.push(issue(file, 1, 'unsupported_resolution', 'tsconfig/jsconfig', ts.flattenDiagnosticMessageText(error.messageText, '\n'), 'medium'));
    }
    const pkg = manifest(absolute);
    const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
    const imports = [];
    function collect(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typeOnly = node.isTypeOnly || clause?.isTypeOnly ||
          (!clause?.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly));
        imports.push({ expression: node.moduleSpecifier, typeOnly: Boolean(typeOnly), commonjs: false });
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
        imports.push({ expression: node.moduleReference.expression, typeOnly: node.isTypeOnly, commonjs: true });
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require' && !program().getTypeChecker().getSymbolAtLocation(node.expression)?.declarations?.some(declaration => declaration.getSourceFile() === source && !declaration.getSourceFile().isDeclarationFile)))) {
        if (node.arguments[0]) imports.push({ expression: node.arguments[0], typeOnly: false, commonjs: node.expression.kind !== ts.SyntaxKind.ImportKeyword });
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        imports.push({ expression: node.argument.literal, typeOnly: true, commonjs: false });
      }
      ts.forEachChild(node, collect);
    }
    collect(source);
    for (const item of imports) {
      const expression = item.expression;
      const line = source.getLineAndCharacterOfPosition(expression.getStart(source)).line + 1;
      if (!ts.isStringLiteralLike(expression)) {
        output.issues.push(issue(file, line, 'unsupported_resolution', expression.getText(source).slice(0, 160), 'Computed module specifiers cannot be resolved statically.', 'medium'));
        continue;
      }
      const specifier = expression.text;
      const clean = specifier.split(/[?#]/)[0];
      if (builtins.has(specifier.replace(/^node:/, '')) || assetPattern.test(clean)) {
        output.ignored_imports.push({ file, line, target: specifier, reason: assetPattern.test(clean) ? 'non-source import' : 'Node built-in' });
        continue;
      }
      const addIssue = (type, message, severity = 'high') => output.issues.push(issue(file, line, type, specifier, message, severity));
      const addEdge = target => output.imports.push({ source: file, target });
      if (!specifier || specifier.includes('\0') || specifier.includes('\\') || path.isAbsolute(specifier)) {
        addIssue('invalid_path', 'The module specifier is empty, absolute, or contains invalid path characters.');
        addEdge(`unresolved:${file}:${specifier}`);
        continue;
      }
      if (/^[a-z][\w+.-]*:/i.test(specifier) || /[?!]/.test(specifier)) {
        addIssue('unsupported_resolution', 'URL and bundler-loader module specifiers are outside static resolution.', 'medium');
        addEdge(`unresolved:${file}:${specifier}`);
        continue;
      }
      const relative = specifier.startsWith('.');
      if (relative && !inside(root, path.resolve(path.dirname(absolute), specifier))) {
        addIssue('invalid_path', 'Relative import escapes the scan root.');
        addEdge(`unresolved:${file}:${specifier}`);
        continue;
      }
      if (config.errors.length) {
        addEdge(`unresolved:${file}:${specifier}`);
        continue;
      }
      const resolution = ts.resolveModuleName(specifier, absolute, config.options, ts.sys, config.cache, undefined,
        item.commonjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext).resolvedModule;
      if (resolution && inside(root, resolution.resolvedFileName) && !posix(path.relative(root, resolution.resolvedFileName)).split('/').includes('node_modules')) {
        if (!sourcePattern.test(resolution.resolvedFileName) || /\.d\.[cm]?ts$/.test(resolution.resolvedFileName)) {
          output.ignored_imports.push({ file, line, target: specifier, reason: 'non-source or declaration-only import' });
        } else {
          if (!realpathCache.has(resolution.resolvedFileName)) realpathCache.set(resolution.resolvedFileName, fs.realpathSync(resolution.resolvedFileName));
          const real = realpathCache.get(resolution.resolvedFileName);
          if (!inside(root, real)) addIssue('invalid_path', 'Resolved module points outside the scan root.');
          else addEdge(`file:${posix(path.relative(root, resolution.resolvedFileName))}`);
        }
        continue;
      }
      const alias = Object.keys(config.options.paths || {}).some(pattern => {
        const [prefix, suffix] = pattern.split('*');
        return pattern.includes('*') ? specifier.startsWith(prefix) && specifier.endsWith(suffix || '') : specifier === pattern;
      });
      if (relative || alias) {
        addIssue('missing_local_module', 'No source module matches this local import.');
        addEdge(`unresolved:${file}:${specifier}`);
        continue;
      }
      if (specifier.startsWith('#')) {
        addIssue('unsupported_resolution', 'Package import mapping could not be resolved.', 'medium');
        addEdge(`unresolved:${file}:${specifier}`);
        continue;
      }
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      const installed = installedPackage(absolute, name);
      const declaration = declared[name];
      const selfReference = pkg.name === name;
      addEdge(`package:${name}`);
      if (!declaration && !selfReference) addIssue('undeclared_external_package', 'Imported package is not declared in the nearest package.json.');
      else if (!installed && !selfReference && !(item.typeOnly && resolution)) addIssue('declared_but_not_installed', 'Declared package is not installed locally.');
      else if (!resolution) addIssue('unsupported_resolution', 'Package is present, but this export or module path could not be resolved.', 'medium');
      if (installed?.version && typeof declaration === 'string' && semver.valid(installed.version) && semver.validRange(declaration) && !semver.satisfies(installed.version, declaration, { includePrerelease: true })) {
        addIssue('version_mismatch', `Installed version ${installed.version} does not satisfy declared range ${declaration}.`, 'medium');
      }
    }
    result.push(output);
  }
  return { files: result, runtime: { node: process.versions.node, typescript: ts.version } };
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
    if (request.version !== 1) throw new Error('Unsupported protocol version; expected 1.');
    let result;
    if (request.method === 'ping') result = { protocol: 1, typescript: ts.version };
    else if (request.method === 'analyze') result = analyze(request.params);
    else throw new Error('Unknown parser method.');
    process.stdout.write(JSON.stringify({ version: 1, id: request.id, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ version: 1, id: request?.id ?? null, error: error.message }) + '\n');
  }
}
