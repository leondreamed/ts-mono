import fs from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { getMonorepoDir } from '~/utils/package.js'

const tsmrConfigSchema = z.object({
	turboArgs: z
		.union([
			z
				.string()
				.array()
				.optional()
				.default(() => []),
			z.object({
				typecheck: z.string().array().optional(),
				lint: z.string().array().optional(),
				buildTypecheck: z.string().array().optional(),
			}),
		])
		.optional(),
})

type TsmrConfig = z.infer<typeof tsmrConfigSchema>

export async function getTsmrConfig() {
	const monorepoDir = getMonorepoDir()
	let tsmrConfig: TsmrConfig = {}
	for (const configFileName of [
		'tsmr.config.cjs',
		'tsmr.config.mjs',
		'tsmr.config.js',
	]) {
		if (fs.existsSync(path.join(monorepoDir, configFileName))) {
			// eslint-disable-next-line no-await-in-loop -- We only import once
			const { default: unparsedTsmrConfig } = (await import(
				path.join(monorepoDir, configFileName)
			)) as {
				default: unknown
			}
			tsmrConfig = tsmrConfigSchema.parse(unparsedTsmrConfig)
			break
		}
	}

	return tsmrConfig
}
