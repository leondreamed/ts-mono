import path from 'node:path'

import { program } from 'commander'

import {
	getMonorepoDir,
	getPackageDir,
	shouldPackageBeChecked,
} from '~/utils/package.js'
import { setupLintAndTypecheck } from '~/utils/typecheck.js'

await program
	.argument('<packageSlug>')
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
	.parseAsync()
