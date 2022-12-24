import { program } from 'commander'

import { turboTypecheck } from '~/utils/turbo.js'
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
				'`--force` option detected; removing all typechecking caches and artifacts.'
			)

			await deleteCachedTypecheckFiles()

			console.info('Cached typecheck files removed.')
		}

		await setupLintAndTypecheck({ logs: 'summary' })
		const { exitCode } = await turboTypecheck({ logs: 'full' })
		process.exit(exitCode)
	})
	.parseAsync()
