#!/usr/bin/env node

import path from 'node:path'

import { Command, program } from 'commander'

import {
	getMonorepoDir,
	getPackageDir,
	shouldPackageBeChecked,
} from '~/utils/package.js'
import { turboLint, turboTypecheck } from '~/utils/turbo.js'
import {
	buildTypecheckFolder,
	deleteCachedTypecheckFiles,
	setupLintAndTypecheck,
	turboBuildTypecheckFolders,
	typecheck,
} from '~/utils/typecheck.js'

await program
	.name('tsmr')
	.addCommand(
		new Command('build-typecheck')
			.allowUnknownOption(true)
			.argument('<packageSlug>')
			.argument('[tsconfigFile]')
			.action(async (packageSlug: string, tsconfigFile?: string) => {
				const { exitCode } = await buildTypecheckFolder({
					packageSlug,
					logs: 'full',
					tsconfigFile,
				})

				process.exit(exitCode)
			})
	)
	.addCommand(
		new Command('lint')
			.argument('<packageSlug>')
			.allowUnknownOption(true)
			.option('--only-show-errors')
			.action(
				async (packageSlug: string, options?: { onlyShowErrors?: boolean }) => {
					if (!(await shouldPackageBeChecked({ packageSlug }))) {
						console.info(`Skipping lint for package ${packageSlug}`)
						process.exit(0)
					}

					// We only run the `setupLintAndTypecheck` function if we're linting independently of Turbo.
					// Otherwise, we run this function once before running Turbo so we don't need to re-run it.
					if (process.env.TURBO_HASH === undefined) {
						await setupLintAndTypecheck({ logs: 'full' })
					}

					const packageDir = getPackageDir({ packageSlug })
					process.chdir(packageDir)
					const eslintFlags = ['--cache', '--fix']

					if (options?.onlyShowErrors) {
						eslintFlags.push('--quiet')
					}

					process.argv = [...process.argv.slice(0, 2), ...eslintFlags, '.']

					const monorepoDir = getMonorepoDir()
					// Resolve `eslint` from the monorepo root
					const eslintBinPath = path.join(
						monorepoDir,
						'node_modules/eslint/bin/eslint.js'
					)

					await import(eslintBinPath)
				}
			)
	)
	.addCommand(
		new Command('typecheck')
			.allowUnknownOption(true)
			.argument('<packageSlug>')
			.argument('[tsconfigFile]')
			.allowUnknownOption(true)
			.action(async (packageSlug: string, tsconfigFile?: string) => {
				if (!(await shouldPackageBeChecked({ packageSlug }))) {
					console.info(`Skipping typecheck for package ${packageSlug}`)
					process.exit(0)
				}

				// We only run the `setupLintAndTypecheck` function if we're typechecking independently of Turbo. Otherwise,
				// we run this function once before running Turbo so we don't need to re-run it.
				if (process.env.TURBO_HASH === undefined) {
					await setupLintAndTypecheck({
						logs: 'summary',
					})
					console.info('Running typecheck...')
				}

				const result = await typecheck({
					packageSlug,
					tsconfigFile: tsconfigFile ?? 'tsconfig.json',
				})
				const exitCode = result?.exitCode ?? 0
				process.exit(exitCode)
			})
	)
	.addCommand(
		new Command('turbo-build-typecheck')
			.option('-f, --force')
			.allowUnknownOption(true)
			.action(async (options?: { force?: boolean }) => {
				if (options?.force) {
					console.info(
						'`--force` option detected; removing all typechecking caches and artifacts.'
					)

					await deleteCachedTypecheckFiles()

					console.info('Cached typecheck files removed.')
				}

				console.info('Building typecheck folders with Turbo...')
				const { exitCode } = await turboBuildTypecheckFolders({
					logs: 'full',
				})
				process.exit(exitCode)
			})
	)
	.addCommand(
		new Command('turbo-lint')
			.option('-f, --force')
			.allowUnknownOption(true)
			.action(async (options?: { force: boolean }) => {
				if (options?.force) {
					console.info(
						'`--force` option detected; removing all cached lint files and artifacts.'
					)

					await deleteCachedTypecheckFiles()

					console.info('Cached lint files removed.')
				}

				// Note that we don't need to call `generateDistTypecheckFolders` since we've patched ESLint to use the source files instead of the declarations
				await setupLintAndTypecheck({ logs: 'summary' })
				const { exitCode } = await turboLint({
					logs: 'full',
					onlyShowErrors: false,
				})
				process.exit(exitCode)
			})
	)
	.addCommand(
		new Command('turbo-typecheck')
			.option('-f, --force')
			.allowUnknownOption(true)
			.action(async (options?: { force: boolean }) => {
				if (options?.force) {
					console.info(
						'`--force` option detected; removing all typechecking caches and artifacts.'
					)

					await deleteCachedTypecheckFiles()

					console.info('Cached typecheck files removed.')
				}

				await setupLintAndTypecheck({ logs: 'summary' })
				const { exitCode } = await turboTypecheck({ logs: 'full' })
				process.exit(exitCode)
			})
	)
	.parseAsync()
