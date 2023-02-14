import fs from 'node:fs'
import path from 'node:path'

import findUp from '@commonjs/find-up'
import { outdent } from 'outdent'
import { prepareSingleFileReplaceTscAliasPaths } from 'tsc-alias-sync'

export function patchEslint() {
	const tsMonorepoPatchedSymbol = Symbol('tsmr-patched')

	if (!(fs as any)[tsMonorepoPatchedSymbol]) {
		;(fs as any)[tsMonorepoPatchedSymbol] = true

		/**
			Whenever TypeScript reads a file, it's always through a call to `ts.sys.readFile` before the call to `fs.readFileSync`. This allows us to consistently determine when a file is needed for building a TypeScript project through the `currentTypescriptSourceFile` variable (which we compare with the file path passed to `fs.readFileSync`).

			However, it seems like simply overwriting the `ts.sys.readFile` function doesn't always work, so we instead patch it at "compile time" by patching `fs.readFileSync` to return a modified version of `typescript/lib/typescript.js`
		*/
		const patchTypescript = (fileContents: string) =>
			fileContents.replace(
				'readFile: readFile',
				outdent`
					readFile: (...args) => {
						globalThis.currentTypescriptSourceFile = args[0]
						const file = readFile(...args)
						globalThis.currentTypescriptSourceFile = null
						return file
					}
				`
			)
		const tsConfigToFileReplacer = new Map()

		const { statSync } = fs
		const { existsSync } = fs
		const { readFileSync } = fs

		const shouldStubTsconfigLintJson = (filePath: string) => {
			if (path.basename(filePath) !== 'tsconfig.lint.json') {
				return false
			}

			const dir = path.dirname(filePath)

			return (
				!existsSync(filePath) && existsSync(path.join(dir, 'tsconfig.json'))
			)
		}

		;(fs as any).statSync = (...args: any[]) => {
			if (shouldStubTsconfigLintJson(args[0])) {
				return statSync(path.join(path.dirname(args[0]), 'tsconfig.json'))
			}
			// Otherwise, just pass through
			else {
				return (statSync as any)(...args)
			}
		}

		fs.existsSync = (...args) => {
			if (typeof args[0] !== 'string') {
				return existsSync(...args)
			}

			if (shouldStubTsconfigLintJson(args[0])) {
				return true
			} else {
				return existsSync(...args)
			}
		}

		const tsExtensions = new Set(['.ts', '.tsx', '.cts', '.mts'])
		fs.readFileSync = (...args) => {
			if (typeof args[0] !== 'string') {
				return (readFileSync as any)(...args)
			}

			if (args[0].endsWith('/node_modules/typescript/lib/typescript.js')) {
				return patchTypescript((readFileSync as any)(...args))
			}

			// We don't want to process files in `node_modules`
			if (args[0].includes('/node_modules/')) {
				return (readFileSync as any)(...args)
			}

			if (shouldStubTsconfigLintJson(args[0])) {
				return outdent`
					{
						"extends": "./tsconfig.json",
						"include": [".*", "*.*", "**/*.*", "**/.*"]
					}
				`
			}

			const { ext } = path.parse(args[0])
			/**
				In order to make ESLint use source files for type inference, we want to dynamically replace path aliases in source TypeScript files. However, we only want to do this when TypeScript ESLint is building the TypeScript project, **not** when ESLint is running linting rules on the files (or else ESLint will process the file with the replaced paths, leading to auto-lint fixes that mess up the original aliased import paths).
			*/
			if (
				(globalThis as any).currentTypescriptSourceFile === args[0] &&
				tsExtensions.has(ext)
			) {
				let tsConfigPath = findUp.sync('tsconfig.json', {
					cwd: path.dirname(args[0]),
				})
				if (tsConfigPath === undefined) {
					return (readFileSync as any)(...args)
				}

				const tsconfigTypecheckPath = path.join(
					path.dirname(tsConfigPath),
					'tsconfig.typecheck.json'
				)
				if (fs.existsSync(tsconfigTypecheckPath)) {
					tsConfigPath = tsconfigTypecheckPath
				}

				let fileReplacer = tsConfigToFileReplacer.get(tsConfigPath)
				if (fileReplacer === undefined) {
					fileReplacer = prepareSingleFileReplaceTscAliasPaths({
						configFile: tsConfigPath,
						outDir: path.dirname(tsConfigPath),
					})
					tsConfigToFileReplacer.set(tsConfigPath, fileReplacer)
				}

				const fileContents = readFileSync(args[0], 'utf8')
				const newContents = fileReplacer({
					fileContents,
					filePath: args[0],
				})

				return newContents
			}

			return (readFileSync as any)(...args)
		}
	}
}
