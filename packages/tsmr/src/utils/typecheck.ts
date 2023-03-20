import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { parse } from '@npm/tsconfig'
import chalk from 'chalk'
import { execa } from 'execa'
import { findUpSync } from 'find-up'
import { globby } from 'globby'
import invariant from 'tiny-invariant'
import { replaceTscAliasPaths } from 'tsc-alias'
import { prepareSingleFileReplaceTscAliasPaths } from 'tsc-alias-sync'

import { getTsmrConfig } from '~/utils/config.js'
import {
	getMonorepoDir,
	getPackageDir,
	getPackageJson,
	getPackageSlug,
	getPackageSlugs,
} from '~/utils/package.js'

/**
	A wrapper around `tsc` that patches `fs.readFileSync` so that `tsc` reads the `typecheck` property from `package.json` as the `types` property.
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
	const packageDir = await getPackageDir({ packageSlug })
	process.chdir(packageDir)
	process.argv = [
		// The third argument to argv is the package name, which we don't want to forward to `tsc`
		...process.argv.slice(0, 2),
		'-p',
		tsconfigFile,
		// We don't want to emit any declaration files when typechecking (we already did that with `build-typecheck`)
		'--noEmit',
		'--emitDeclarationOnly',
		'--customConditions',
		'typecheck',
		'false',
	]

	const tsmrConfig = await getTsmrConfig()
	process.argv.push(
		...(tscArguments ?? []),
		...(tsmrConfig.typecheck?.args ?? [])
	)

	const tscPath = createRequire(process.cwd()).resolve('typescript/lib/tsc')

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
			{
				stdio: logs === 'full' ? 'inherit' : 'ignore',
				cwd: getMonorepoDir(),
			}
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

/**
	When we build typecheck folders (which are the `dist-typecheck` folders that contain the built type definitions for a package), we treat each package's dependencies as an "internal package" (@see https://turborepo.com/posts/you-might-not-need-typescript-project-references)

	In order to force packages to become "internal packages", we need to remove the "references" property from the package's `tsconfig.json` file.
*/
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
	const tsConfigToFileReplacer = new Map()

	const javascriptExtensions = new Set([
		'.js',
		'.jsx',
		'.ts',
		'.tsx',
		'.mjs',
		'.cjs',
		'.cts',
		'.mts',
	])

	fs.readFileSync = ((...args: any) => {
		const { ext: fileExt } = path.parse(args[0])
		const originalFileContents = (readFileSync as any)(...args)

		if (/tsconfig\.(\w+\.)?json/.test(path.basename(args[0]))) {
			try {
				const tsconfig = parse(
					originalFileContents.toString(),
					path.basename(args[0])
				)
				delete tsconfig.references
				return JSON.stringify(tsconfig, null, '\t')
			} catch (error) {
				console.error('Failed to parse TSConfig:', error)
				process.exit(1)
			}
		}

		if (!javascriptExtensions.has(fileExt)) {
			return originalFileContents
		}

		// We don't want to modify files in node_modules
		if (args[0].includes('/node_modules/')) {
			return originalFileContents
		}

		if (!javascriptExtensions.has(fileExt)) {
			return originalFileContents
		}

		let fileContentsWithRelativePaths: string = originalFileContents.toString()

		/**
			In order for TypeScript to correctly generate the type declarations, we need to dynamically replace aliased paths when reading the file.
		*/

		// We only need to replace aliased paths in source files
		let tsConfigPath = findUpSync('tsconfig.json', {
			cwd: path.dirname(args[0]),
		})

		if (tsConfigPath !== undefined) {
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
			fileContentsWithRelativePaths = fileReplacer({
				fileContents,
				filePath: args[0],
			})
		}

		const hasTsCheckComment = (contents: string) =>
			/\/\/\s*@ts-check\b/.test(contents.trimStart())

		/**
			To increase performance of generating the `dist-typecheck` files, we disable type checking for each file by adding a // @ts-nocheck to the top of every TypeScript file.
		*/
		if (fileContentsWithRelativePaths.startsWith('#')) {
			const [firstLine, ...remainingLines] =
				fileContentsWithRelativePaths.split('\n')
			let remainingLinesString = remainingLines.join('\n')
			if (hasTsCheckComment(remainingLinesString)) {
				remainingLinesString = remainingLinesString.replace(
					'@ts-check',
					'@ts-nocheck'
				)
			}

			return firstLine! + '\n// @ts-nocheck\n' + remainingLinesString
		} else if (hasTsCheckComment(fileContentsWithRelativePaths)) {
			return fileContentsWithRelativePaths.replace('@ts-check', '@ts-nocheck')
		} else {
			return '// @ts-nocheck\n' + fileContentsWithRelativePaths
		}
	}) as any

	process.chdir(await getPackageDir({ packageSlug }))
	const tscPath = createRequire(process.cwd()).resolve('typescript/lib/tsc')
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

	await exitCodePromise

	// Unfortunately, `@ts-nocheck` does not suppress "non-portable" type errors (which we don't care about), so we manually return an exit code of 0.
	return { exitCode: 0 }
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
			env: {
				...tsmrConfig.env,
			},
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
