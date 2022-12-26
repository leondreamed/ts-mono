#!/usr/bin/env node
import { program } from 'commander'

import { turboLint } from '~/utils/turbo.js'
import {
	deleteCachedTypecheckFiles,
	setupLintAndTypecheck,
} from '~/utils/typecheck.js'

await program
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
	.parseAsync()
