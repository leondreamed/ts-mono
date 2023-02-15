import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import chalk from 'chalk'
import { execa } from 'execa'
import { globby } from 'globby'
import invariant from 'tiny-invariant'
import { replaceTscAliasPaths } from 'tsc-alias'

import { getTsmrConfig } from '~/utils/config.js'
import {
	getMonorepoDir,
	getPackageDir,
	getPackageJson,
	getPackageSlug,
	getPackageSlugs,
} from '~/utils/package.js'

/**
	A wrapper around `tsc` that patches `fs.readFileSync` so that `tsc` looks at a workspace package's `dist-typecheck` folder instead of the `src` folder.
*/
export async function typecheck({
	packageSlug,
	tsconfigFile,
	tscArguments,
}: {
	packageSlug: string
	tsconfigFile: string
	tscArguments?: string[]
}): Promise<{ exitCode: number } | null> {
	const filePathsToBePatched = new Set<string>()
	const packageSlugs = await getPackageSlugs()
	// Precompute a list of files that should be patched by going through the `package.json` files of each workspace package
	await Promise.all(
		Object.values(packageSlugs).map(async (packageSlug) => {
			const packageDir = await getPackageDir({ packageSlug })
			const { exports } = await getPackageJson({ packageSlug })
			if (Array.isArray(exports)) {
				console.error(
					`Arrays in "exports" property is not supported (package ${packageSlug}).`
				)
				process.exit(1)
			}

			if (
				exports === null ||
				exports === undefined ||
				typeof exports === 'string'
			) {
				return
			}

			// If the export keys are relative paths
			if (Object.keys(exports)[0]?.startsWith('.')) {
				// Loop through all the relative paths and select the "types" property (if they have one)
				for (const exportValue of Object.values(exports)) {
					if (exportValue === null) continue
					if (
						typeof exportValue === 'object' &&
						typeof (exportValue as any).types === 'string'
					) {
						filePathsToBePatched.add(
							path.join(packageDir, (exportValue as any).types)
						)
					}
				}
			}
			// Else, the keys are import specifiers
			else {
				// Find the "types" import specifier
				if (typeof (exports as any).types === 'string') {
					filePathsToBePatched.add(
						path.join(packageDir, (exports as any).types)
					)
				}
			}
		})
	)

	const { readFileSync } = fs
	// We need to patch `fs.readFileSync` to replace `export * from './src/index.js'` with `export * from './dist-typecheck/index.js'`
	fs.readFileSync = (...args) => {
		if (typeof args[0] !== 'string') {
			return (readFileSync as any)(...args)
		}

		// Ignore non-Dialect packages
		if (args[0].includes('/node_modules/')) {
			return (readFileSync as any)(...args)
		}

		if (filePathsToBePatched.has(args[0])) {
			const indexTsContents = readFileSync(args[0], 'utf8')

			// TODO: find a way to generalize this patch for @dialect-inc/websites-shared
			if (indexTsContents.includes('./scripts/index.mts')) {
				return indexTsContents.replace('/scripts/', '/dist-typecheck/')
			}

			return indexTsContents.replaceAll('/src/', '/dist-typecheck/')
		}

		return (readFileSync as any)(...args)
	}

	const packageDir = await getPackageDir({ packageSlug })
	process.chdir(packageDir)
	process.argv = [
		// The third argument to argv is the package name, which we don't want to forward to `tsc`
		...process.argv.slice(0, 2),
		'-p',
		tsconfigFile,
	]
	process.argv.push(...(tscArguments ?? []))

	const tscPath = createRequire(import.meta.url).resolve('typescript/lib/tsc')

	const exitCodePromise = new Promise<{ exitCode: number }>((resolve) => {
		const exit = process.exit.bind(process)
		process.exit = ((exitCode = 0) => {
			process.exit = exit
			resolve({ exitCode })
		}) as any
	})

	await import(tscPath)
	return exitCodePromise
}

/**
	For accurate linting and typechecking, we should ensure that the dependencies of all packages are installed for accurate TypeScript type checking.

	We do this by running `pnpm install --ignore-scripts` with a `--filter` flag for each package that does not have a `node_modules` folder.
*/
export async function setupLintAndTypecheck({
	logs,
	turboArguments,
}: {
	logs: 'full' | 'summary' | 'none'
	turboArguments?: string[]
}) {
	const packageSlugs = await getPackageSlugs()
	const packageNamesWithoutNodeModules: string[] = []
	await Promise.all(
		Object.values(packageSlugs).map(async (packageSlug) => {
			const packageDir = await getPackageDir({ packageSlug })
			if (!fs.existsSync(path.join(packageDir, 'node_modules'))) {
				// Ignore packages that don't specify any dependencies (since they won't ever have a node_modules folder)

				const packageJson = await getPackageJson({ packageSlug })
				if (
					Object.keys(packageJson.dependencies ?? {}).length === 0 &&
					Object.keys(packageJson.devDependencies ?? {}).length === 0 &&
					Object.keys(packageJson.peerDependencies ?? {}).length === 0
				) {
					return
				}

				invariant(
					packageJson.name !== undefined,
					`package at ${packageDir} is missing a name property`
				)
				packageNamesWithoutNodeModules.push(packageJson.name)
			}
		})
	)

	if (packageNamesWithoutNodeModules.length > 0) {
		process.stderr.write(
			`Some packages were detected without a \`node_modules\` folder, running \`pnpm install --ignore-scripts\` inside the following packages:\n`
		)

		for (const packageName of packageNamesWithoutNodeModules) {
			process.stderr.write(chalk.dim(`- ${packageName}\n`))
		}

		await execa(
			'pnpm',
			[
				'install',
				'--ignore-scripts',
				'--config.skip-pnpmfile',
				...packageNamesWithoutNodeModules.map(
					(packageName) => `--filter=${packageName}`
				),
			],
			{ stdio: logs === 'full' ? 'inherit' : 'ignore', cwd: getMonorepoDir() }
		)

		// In order to keep track of which packages' scripts have not been run, we create a `metadata.json` file inside the workspace's `node_modules`.
		// This is necessary so that if we ever need to install these packages normally, they depend on npm scripts to be run (since otherwise they might be broken). If we know that these scripts haven't been run, we can delete `node_modules` and re-install to make pnpm run these scripts.
		await Promise.all(
			packageNamesWithoutNodeModules.map(async (packageName) => {
				const packageSlug = getPackageSlug({ packageName })
				const packageDir = await getPackageDir({ packageSlug })
				const metadataFilePath = path.join(
					packageDir,
					'node_modules/metadata.json'
				)
				await fs.promises.mkdir(path.dirname(metadataFilePath), {
					recursive: true,
				})
				await fs.promises.writeFile(
					metadataFilePath,
					JSON.stringify({ ignoredScripts: true })
				)
			})
		)
	}

	/**
		We use Turbo to generate all the `dist-typecheck` folders since it handles caching.

		Note: we only call this when the typecheck script isn't being run by turbo (our turbo scripts will generate the dist-typecheck folders before continuing).
	*/
	if (process.env.TURBO_HASH === undefined) {
		await turboBuildTypecheckFolders({ logs, turboArguments })
	}
}

export async function buildTypecheckFolder({
	packageSlug,
	logs = 'full',
	tsconfigFile,
	tscArguments,
}: {
	packageSlug: string
	tsconfigFile?: string
	logs: 'full' | 'summary' | 'none'
	tscArguments?: string[]
}): Promise<{ exitCode: number }> {
	if (logs !== 'none') {
		console.info('Generating `dist-typecheck` folders...')
	}

	const { readFileSync } = fs

	fs.readFileSync = ((...args: any) => {
		const hasTsCheckComment = (contents: string) =>
			/\/\/\s*@ts-check\b/.test(contents.trimStart())

		/**
			To increase performance of generating the `dist-typecheck` files, we disable type checking for each file by adding a // @ts-nocheck to the top of every TypeScript file.
		*/
		const { ext } = path.parse(args[0])
		if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
			const fileContents = readFileSync(args[0], 'utf8')
			if (fileContents.startsWith('#')) {
				const [firstLine, ...remainingLines] = fileContents.split('\n')
				let remainingLinesString = remainingLines.join('\n')
				if (hasTsCheckComment(remainingLinesString)) {
					remainingLinesString = remainingLinesString.replace(
						'@ts-check',
						'@ts-nocheck'
					)
				}

				return firstLine! + '\n// @ts-nocheck\n' + remainingLinesString
			} else if (hasTsCheckComment(fileContents)) {
				return fileContents.replace('@ts-check', '@ts-nocheck')
			} else {
				return '// @ts-nocheck\n' + fileContents
			}
		}

		return (readFileSync as any)(...args)
	}) as any

	process.chdir(await getPackageDir({ packageSlug }))
	const tscPath = createRequire(import.meta.url).resolve('typescript/lib/tsc')
	if (tsconfigFile === undefined) {
		process.argv = process.argv.slice(0, 2)
	} else {
		process.argv = [...process.argv.slice(0, 2), '-p', tsconfigFile]
	}

	process.argv.push(...(tscArguments ?? []))

	const exitCodePromise = new Promise<{ exitCode: number }>((resolve) => {
		const exit = process.exit.bind(process)
		process.exit = ((exitCode = 0) => {
			process.exit = exit
			resolve({ exitCode })
		}) as any
	})

	await import(tscPath)

	// Without `tsc --build`, TypeScript will use the declaration files as the types for workspace packages.
	// In order for TypeScript to properly resolve path aliases in these declaration files, we need to
	// run `tsc-alias` on these declarations.
	await replaceTscAliasPaths({
		configFile: tsconfigFile ?? 'tsconfig.json',
	})

	return exitCodePromise
}

export async function turboBuildTypecheckFolders({
	logs,
	turboArguments,
}: {
	turboArguments?: string[]
	logs: 'full' | 'summary' | 'none'
}): Promise<{ exitCode: number }> {
	const monorepoDir = getMonorepoDir()
	const tsmrConfig = await getTsmrConfig()
	const turboArgs = Array.isArray(tsmrConfig.turboArgs)
		? tsmrConfig.turboArgs
		: tsmrConfig.turboArgs?.buildTypecheck ?? []

	turboArgs.push(...(turboArguments ?? []))

	if (logs !== 'none') {
		console.info('Generating `dist-typecheck` folders with Turbo...')
	}

	const { exitCode } = await execa(
		'pnpm',
		['exec', 'turbo', 'build-typecheck', ...turboArgs],
		{
			cwd: monorepoDir,
			stdio: logs === 'full' ? 'inherit' : 'pipe',
		}
	)

	if (logs !== 'none') {
		console.info('Finished generating `dist-typecheck` folders!')
	}

	return { exitCode }
}

export async function deleteCachedTypecheckFiles() {
	const packageSlugs = await getPackageSlugs()
	await Promise.all([
		fs.promises.rm(path.join(getMonorepoDir(), 'node_modules/.cache/turbo'), {
			force: true,
			recursive: true,
		}),
		...Object.values(packageSlugs).flatMap(async (packageSlug) => {
			const packageDir = await getPackageDir({ packageSlug })
			const tsbuildinfoFiles = await globby(
				path.join(packageDir, '*.tsbuildinfo')
			)
			const distTypecheckFolders = await globby(
				path.join(packageDir, 'dist-typecheck'),
				{
					onlyFiles: false,
					expandDirectories: false,
				}
			)
			const turboFolders = await globby(path.join(packageDir, '.turbo'), {
				onlyFiles: false,
				expandDirectories: false,
			})

			return [
				...tsbuildinfoFiles.map(async (tsbuildinfoFile) =>
					fs.promises.rm(tsbuildinfoFile)
				),
				...distTypecheckFolders.map(async (distTypecheckFolder) =>
					fs.promises.rm(distTypecheckFolder, { recursive: true })
				),
				...turboFolders.map(async (turboFolder) =>
					fs.promises.rm(turboFolder, { recursive: true })
				),
			]
		}),
	])
}

export async function deleteCachedLintFiles() {
	const packageSlugs = await getPackageSlugs()
	const monorepoDir = getMonorepoDir()
	await Promise.all([
		fs.promises.rm(path.join(monorepoDir, 'node_modules/.cache/turbo'), {
			recursive: true,
			force: true,
		}),
		...Object.values(packageSlugs).flatMap(async (packageSlug) => {
			const packageDir = await getPackageDir({ packageSlug })
			const eslintcacheFiles = await globby(
				path.join(packageDir, '*.eslintcache')
			)
			const turboFolders = await globby(path.join(packageDir, '.turbo'), {
				onlyFiles: false,
				expandDirectories: false,
			})

			return [
				...eslintcacheFiles.map(async (tsbuildinfoFile) =>
					fs.promises.rm(tsbuildinfoFile)
				),
				...turboFolders.map(async (turboFolder) =>
					fs.promises.rm(turboFolder, { recursive: true })
				),
			]
		}),
	])
}
