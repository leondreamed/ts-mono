#!/usr/bin/env node
import { program } from 'commander'

import { shouldPackageBeChecked } from '~/utils/package.js'
import { setupLintAndTypecheck, typecheck } from '~/utils/typecheck.js'

await program
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
	.parseAsync()
