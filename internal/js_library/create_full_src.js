const fs = require("fs-extra");
const path = require("path");
const ts = require("typescript");

// Node modules that are automatically available in a Node environment.
// Synced from https://github.com/DefinitelyTyped/DefinitelyTyped/blob/e22846ad77459b3ece25598db93c2013e8c76716/types/node/index.d.ts.
const NODE_MODULES = new Set([
  "buffer",
  "querystring",
  "events",
  "http",
  "cluster",
  "zlib",
  "os",
  "https",
  "punycode",
  "repl",
  "readline",
  "vm",
  "child_process",
  "url",
  "dns",
  "net",
  "dgram",
  "fs",
  "path",
  "string_decoder",
  "tls",
  "crypto",
  "stream",
  "util",
  "assert",
  "tty",
  "domain",
  "constants",
  "module",
  "process",
  "v8",
  "timers",
  "console",
  "async_hooks",
  "http2",
  "perf_hooks"
]);

const [
  nodePath,
  scriptPath,
  targetLabel,
  installedNpmPackagesDir,
  buildfilePath,
  joinedRequires,
  joinedInternalDeps,
  joinedSrcs,
  destinationDir
] = process.argv;

const buildfileDir = path.dirname(buildfilePath);
const required = new Set(joinedRequires.split("|"));
const internalDeps = joinedInternalDeps.split("|");
const srcs = joinedSrcs.split("|");

fs.mkdirSync(destinationDir);

const packageJson = fs.readFileSync(
  path.join(installedNpmPackagesDir, "package.json")
);
const packageDefinition = JSON.parse(packageJson);
const deps = {
  ...(packageDefinition.dependencies || {}),
  ...(packageDefinition.devDependencies || {})
};
for (const name of required) {
  if (!name) {
    // Occurs when there are no dependencies.
    continue;
  }
  if (!(name in deps)) {
    console.error(
      `
No package "${name}" declared in ${npmPackagesLabel}.
Are you requiring the correct packages in ${targetLabel}?
`
    );
    process.exit(1);
  }
}

if (fs.existsSync(path.join(installedNpmPackagesDir, "node_modules"))) {
  // Find all the packages we depend on indirectly. We'll only include those.
  const analyzedPackageNames = new Set();
  const toAnalyzePackageNames = Array.from(required);
  for (let i = 0; i < toAnalyzePackageNames.length; i++) {
    findPackageDependencies(toAnalyzePackageNames[i]);
  }
  function findPackageDependencies(name) {
    if (!name) {
      // Occurs when there are no dependencies.
      return;
    }
    if (analyzedPackageNames.has(name)) {
      // Already processed.
      return;
    }
    analyzedPackageNames.add(name);
    const packageJsonPath = path.join(
      installedNpmPackagesDir,
      "node_modules",
      name,
      "package.json"
    );
    if (!fs.existsSync(packageJsonPath)) {
      return;
    }
    try {
      const package = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (!package.dependencies) {
        return;
      }
      for (const dependencyName of Object.keys(package.dependencies)) {
        toAnalyzePackageNames.push(dependencyName);
      }
    } catch (e) {
      console.warn(`Could not read package.json for package ${name}.`, e);
      return;
    }
  }

  // Create a symbolic link from node_modules.
  fs.mkdirSync(path.join(destinationDir, "node_modules"));
  for (const packageName of analyzedPackageNames) {
    if (packageName.indexOf("/") !== -1) {
      const [parentName, nestedPackageName] = packageName.split("/");
      fs.ensureDirSync(path.join(destinationDir, "node_modules", parentName));
    }
    fs.symlinkSync(
      path.join(installedNpmPackagesDir, "node_modules", packageName),
      path.join(destinationDir, "node_modules", packageName)
    );
  }
}

const validFilePaths = new Set();

// Copy every internal dependency into the appropriate location.
for (const internalDep of internalDeps) {
  if (!internalDep) {
    continue;
  }
  const [joinedSrcs, compiledDir] = internalDep.split(":");
  const srcs = joinedSrcs.split(";");
  for (const src of srcs) {
    if (!src) {
      continue;
    }
    validFilePaths.add(
      path.join(
        path.dirname(src),
        src.endsWith(".js") || src.endsWith(".jsx")
          ? path.parse(src).name
          : path.basename(src)
      )
    );
  }
  fs.copySync(compiledDir, destinationDir, {
    dereference: true
  });
}

// Copy source code.
const srcsSet = new Set(srcs);
for (const src of srcs) {
  if (!src) {
    continue;
  }
  if (!fs.existsSync(src)) {
    console.error(`
Missing file ${src} required by ${targetLabel}.
`);
    process.exit(1);
  }
  const destinationFilePath = path.join(destinationDir, src);
  fs.ensureDirSync(path.dirname(destinationFilePath));
  if (
    !destinationFilePath.endsWith(".js") &&
    !destinationFilePath.endsWith(".jsx")
  ) {
    // Assets and other non-JavaScript files should simply be copied.
    fs.copySync(src, destinationFilePath);
    continue;
  }
  const sourceText = fs.readFileSync(src, "utf8");
  const sourceFile = ts.createSourceFile(
    path.basename(src),
    sourceText,
    ts.ScriptTarget.Latest,
    true
  );
  for (const statement of sourceFile.statements) {
    // TODO: Also handle require statements.
    if (statement.kind === ts.SyntaxKind.ImportDeclaration) {
      const importFrom = statement.moduleSpecifier.text;
      if (
        importFrom.startsWith("./") ||
        importFrom.startsWith("../") ||
        importFrom.startsWith("@/")
      ) {
        let importPathFromWorkspace;
        if (importFrom[0] === "@") {
          // Workspace-level import, e.g. "@/src/some/path".
          importPathFromWorkspace = importFrom.substr(2);
        } else {
          importPathFromWorkspace = path.join(path.dirname(src), importFrom);
        }
        let replaceWith;
        if (validFilePaths.has(importPathFromWorkspace)) {
          // Found a match.
          replaceWith =
            "./" + path.relative(path.dirname(src), importPathFromWorkspace);
        } else {
          // This must be a local import (in the same target).
          // It could either be a JavaScript import, in which case the
          // extension will have been omitted, or it could be an asset such
          // as a CSS stylesheet, in which case the extension does not need
          // to be appended.
          const candidateEndings = [".js", ".jsx", ""];
          let foundMatch = false;
          for (const candidateEnding of candidateEndings) {
            if (srcsSet.has(importPathFromWorkspace + candidateEnding)) {
              // Good, the file exists.
              foundMatch = true;
              break;
            }
          }
          if (foundMatch) {
            // Make sure to replace any absolute imports such as "@/src/some/path"
            // with relative imports, so we don't need to deal with them at a later
            // stage.
            replaceWith =
              "./" + path.relative(path.dirname(src), importPathFromWorkspace);
          } else {
            console.error(`
Could not find a match for import "${importFrom}".
Are you missing a source file or a dependency in ${targetLabel}?
`);
            process.exit(1);
          }
        }
        statement.moduleSpecifier = ts.createLiteral(replaceWith);
      } else {
        // This must be an external package.
        let packageName;
        const splitImportFrom = importFrom.split("/");
        if (splitImportFrom.length >= 2 && splitImportFrom[0].startsWith("@")) {
          // Example: @storybook/react.
          packageName = splitImportFrom[0] + "/" + splitImportFrom[1];
        } else {
          // Example: react.
          packageName = splitImportFrom[0];
        }
        if (!required.has(packageName) && !NODE_MODULES.has(packageName)) {
          console.error(`
Found an import statement referring to an undeclared dependency: "${packageName}".
Make sure to specify requires = ["${packageName}"] in ${targetLabel}.
`);
          process.exit(1);
        }
      }
    }
  }
  const updatedFile = ts.createPrinter().printFile(sourceFile);
  fs.writeFileSync(destinationFilePath, updatedFile, "utf8");
}
