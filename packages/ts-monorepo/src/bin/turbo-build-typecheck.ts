import { program } from 'commander'

import {
	deleteCachedTypecheckFiles,
	turboBuildTypecheckFolders,
} from '~/utils/typecheck.js'

await program
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
	.parseAsync()
