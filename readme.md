# TSMR

TSMR (**T**ype**S**cript **M**ono**r**epo) provides the utilities to create a fully type-safe solution for a TypeScript monorepo.

## Installation

To use `tsmr`, install it from npm using your favorite package manager:

```sh
npm install --save-dev tsmr
```

Then, add the following `package.json` scripts to all your workspace packages:

```jsonc
{
  "scripts": {
    "lint": "tsmr lint",
    "typecheck": "tsmr typecheck",
    "build-typecheck": "tsmr build-typecheck"
  }
}
```

Then, add the following `package.json` scripts to the `package.json` in your monorepo root:

```jsonc
{
  "scripts": {
    "lint": "tsmr turbo-lint",
    "typecheck": "tsmr turbo-typecheck",
    "build-typecheck": "tsmr turbo-build-typecheck"
  }
}
```

To support TSMR's typechecking, you also want to add an `exports` property similar to the following in your `package.json`:

```jsonc
{
  "exports": {
    ".": {
      "typecheck": "./dist-typecheck/index.d.ts",
      "default": "./src/index.ts"
    }
  }
}
```

> This distinction between the generated type definitions and the source code is important for optimal developer experience when using an editor like VSCode. VSCode reads the `package.json`'s exports and uses that to determine the entrypoint of the package for TypeScript intellisense while editing (this technique is known as ["internal packages"](https://turborepo.com/posts/you-might-not-need-typescript-project-references). However, we want to avoid using internal packages during typechecking, since it would cause duplication of effort as that package would be type-checked each time it's used by another package (instead, during typechecking, we want TypeScript to use the generated type definition files to improve type-checking speed). Thus, we make this distinction through a custom "exports" property called `typecheck` that is hardcoded to use with TSMR (TSMR  dynamically replaces this property with `types` before running `tsc` so that TypeScript uses the generated declaration files for typechecking.

Optionally, create a `tsmr.config.cjs` file in your monorepo root to configure tmsr options:

```javascript
module.exports = {
  // Can also be a single array of strings
  turboArgs: {
    buildTypecheck: ['--continue', '--cache-dir=.turbo'],
    typecheck: ['--cache-dir=.turbo'],
    lint: ['--cache-dir=.turbo'],
  }
}
```

After, add the following line in your `.eslintrc.cjs` file:

```typescript
require('tsmr/patch-eslint')

module.exports = // your ESLint config
```

> **Note:** If you're using Next.js's `next lint` command, you may have to add `require('tsmr/patch-eslint')` inside your `next.config.js` file since the ESLint patch script relies on patching TypeScript when it is first read from the filesystem.

## Architecture

- [pnpm](https://pnpm.io) for managing and linking workspace packages.
- [ESLint](https://eslint.org) + [TypeScript ESLint](https://typescript-eslint.io/) for code style (including formatting).
- [Turborepo](https://turbo.build/repo) for faster linting and typechecking.
- [Lefthook](https://github.com/evilmartians/lefthook) for Git hooks that keep your codebase clean.

For the ultimate developer experience working with a TypeScript monorepo, integrating many of these tools requires non-trivial configuration and patches. TSMR provides these configurations so you can focus on your code.

## Patches

### TypeScript

TypeScript provides a feature known as [project references](https://www.typescriptlang.org/docs/handbook/project-references.html), which make it possible to reference other workspace packages for type information. Unfortunately, the built-in project references feature has a significant limitation: [the lack of support for circular references](https://github.com/microsoft/TypeScript/issues/33685).

Developers should not be forced to re-structure their project in an acyclic way, and TSMR makes this possible. Instead of running `tsc --build` on each subproject, TSMR instead performs typechecking in two steps. First, it generates all the declaration files of each project and stores them in a `dist-typecheck` folder in the root of each workspace package. Then, we run `tsc --noEmit` in each project folder (without the `--build` flag).

Normally, this would be much slower than running `tsc --build` in a single project, but thanks to Turborepo, we can cache the outputs of `dist-typecheck` to make keeping the declaration files up-to-date a fast operation.

### ESLint

Using ESLint in a TypeScript monorepo also presents some challenges. To use type-aware rules, TypeScript ESLint needs to build a TypeScript program before linting the project. However, this process is different than type checking because of its real-time nature. For the best developer experience, we need to always have the program built by TypeScript ESLint stay up-to-sync with our code changes. In other words, if we modify a type in one workspace package, all the other workspace packages which import that type also need to be immediately updated.

To solve this problem, we need to tell TypeScript ESLint to use the source files of our projects to build the TypeScript program. Unfortunately, while there [is an experimental TypeScript ESLint flag for this](https://github.com/typescript-eslint/typescript-eslint/issues/2094), it requires a significant amount of memory and leads to OOM errors with large TypeScript monorepos.

Instead, TSMR takes a different approach. Instead of loading the `tsconfig.json` files of all workspace projects, it only uses the one `tsconfig.json` file in the active project, causing TypeScript ESLint to treat other files in different workspace packages as if they were a file from the active project. However, this comes with a evident problem: files in other projects may use the same type mapping prefixes as files in the active linted project.

To overcome this challenge, we dynamically patch the `fs.readFileSync` function to automatically modify the import paths using [tsc-alias](https://github.com/leondreamed/tsc-alias-sync) based on where the file is located in the file system. However, this solution then creates another problem: if we pass the altered file to ESLint, any auto-fixes that ESLint applies on the file will have the aliased path imports replaced with the relative ones!

To solve this new problem, we need a way to differentiate between when a file is read for building the TypeScript program and when a file is read for linting. To fix this, we patch the TypeScript source code at runtime to set a global variable whenever `sys.readFile` that contains the current file being read, and unset it when the function is finished. Thus, we can patch the `ts.createSourceFile` function and the `fs.readFileSync` function to only transform the import paths when a file is used for building the TypeScript program.

### Turbo

Turborepo's caching abilities is crucial for speeding up many of the tasks inside TSMR. However, it comes with a significant limitation: the lack of support for circular references inside the monorepo.

To work around this issue, we always specify workspace dependencies inside the `peerDependencies` property in the `package.json` files. However, this leads so issues with `pnpm`, as `pnpm` does not by default install dependencies inside `peerDependencies`.

This forces us to patch `pnpm` using the `.pnpmfile.cjs` file, where we leverage the `readPackage` hook to automatically add workspace packages in `peerDependencies` to `devDependencies` when `pnpm install` is ran.
