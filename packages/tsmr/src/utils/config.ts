import path from 'node:path'

import { z } from 'zod'

import { getMonorepoDir } from '~/utils/package.js'

const tsmrConfigSchema = z.object({
	turboArgs: z.union([
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
	]),
})

export async function getTsmrConfig() {
	const monorepoDir = getMonorepoDir()
	const { default: tsmrConfig } = (await import(path.join(monorepoDir))) as {
		default: unknown
	}
	return tsmrConfigSchema.parse(tsmrConfig)
}
