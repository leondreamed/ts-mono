# TS Monorepo

TS Monorepo provides the utilities to create the ultimate solution to a TypeScript monorepo.

## Architecture

- [pnpm](https://pnpm.io) for managing and linking workspace packages.
- [ESLint](https://eslint.org) + [TypeScript ESLint](https://typescript-eslint.io/) for code style (including formatting).
- [Turborepo](https://turbo.build/repo) for faster linting and typechecking.
- [Lefthook](https://github.com/evilmartians/lefthook) for Git hooks that keep your codebase clean.

For the ultimate developer experience working with a TypeScript monorepo, integrating many of these tools requires non-trivial configuration and patches. TS Monorepo provides these configurations so you can focus on your code.

## Patches

### TypeScript

TypeScript provides a feature known as [project references](https://www.typescriptlang.org/docs/handbook/project-references.html), which make it possible to reference other workspace packages for type information. Unfortunately, the built-in project references feature has a significant limitation: [the lack of support for circular references](https://github.com/microsoft/TypeScript/issues/33685).

Developers should not be forced to re-structure their project in an acyclic way, and TS Monorepo makes this possible. Instead of running `tsc --build` on each subproject, TS Monorepo instead performs typechecking in two steps. First, it generates all the declaration files of each project and stores them in a `dist-typecheck` folder in the root of each workspace package. Then, we run `tsc --noEmit` in each project folder (without the `--build` flag).

Normally, this would be much slower than running `tsc --build` in a single project, but thanks to Turborepo, we can cache the outputs of `dist-typecheck` to make keeping the declaration files up-to-date a fast operation.

### ESLint

Using ESLint in a TypeScript monorepo also presents some challenges. To use type-aware rules, TypeScript ESLint needs to build a TypeScript program before linting the project. However, this process is different than type checking because of its real-time nature. For the best developer experience, we need to always have the program built by TypeScript ESLint stay up-to-sync with our code changes. In other words, if we modify a type in one workspace package, all the other workspace packages which import that type also need to be immediately updated.

To solve this problem, we need to tell TypeScript ESLint to use the source files of our projects to build the TypeScript program. Unfortunately, while there [is an experimental TypeScript ESLint flag for this](https://github.com/typescript-eslint/typescript-eslint/issues/2094), it requires a significant amount of memory and leads to OOM errors with large TypeScript monorepos.

Instead, TS Monorepo takes a different approach. Instead of loading the `tsconfig.json` files of all workspace projects, it only uses the one `tsconfig.json` file in the active project, causing TypeScript ESLint to treat other files in different workspace packages as if they were a file from the active project. However, this comes with a evident problem: files in other projects may use the same type mapping prefixes as files in the active linted project.

To overcome this challenge, we dynamically patch the `fs.readFileSync` function to automatically modify the import paths using [tsc-alias](https://github.com/leondreamed/tsc-alias-sync) based on where the file is located in the file system. However, this solution then creates another problem: if we pass the altered file to ESLint, any auto-fixes that ESLint applies on the file will have the aliased path imports replaced with the relative ones!

To solve this new problem, we need a way to differentiate between when a file is read for building the TypeScript program and when a file is read for linting. Luckily, TypeScript exposes a function called `ts.createSourceFile` that it _always_ calls before reading a file from the filesystem. Thus, we can patch the `ts.createSourceFile` function and the `fs.readFileSync` function to only transform the import paths when a file is used for building the TypeScript program.

### Turbo

Turborepo's caching abilities is crucial for speeding up many of the tasks inside TS Monorepo. However, it comes with a significant limitation: the lack of support for circular references inside the monorepo.

To work around this issue, we always specify workspace dependencies inside the `peerDependencies` property in the `package.json` files. However, this leads so issues with `pnpm`, as `pnpm` does not by default install dependencies inside `peerDependencies`.

This forces us to patch `pnpm` using the `.pnpmfile.cjs` file, where we leverage the `readPackage` hook to automatically add workspace packages in `peerDependencies` to `devDependencies` when `pnpm install` is ran.
