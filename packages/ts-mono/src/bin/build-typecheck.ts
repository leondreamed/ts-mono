#!/usr/bin/env node
import { program } from 'commander'

import { buildTypecheckFolder } from '~/utils/typecheck.js'

await program
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
	.parseAsync()
