import fs from 'node:fs'
import path from 'node:path'

import { getProjectDir } from 'lion-utils'
import onetime from 'onetime'
import { type PackageJson } from 'type-fest'

export const getMonorepoDir = onetime(() =>
	getProjectDir(process.cwd(), { monorepoRoot: true })
)

export const getPackagesDir = onetime(() => {
	const monorepoDir = getMonorepoDir()
	return path.join(monorepoDir, 'packages')
})

export const getPackageSlugs = onetime(() => {
	const packagesDir = getPackagesDir()
	return fs.readdirSync(packagesDir).filter((packageSlug) => {
		const packageDir = path.join(packagesDir, packageSlug)
		return (
			fs.statSync(packageDir).isDirectory() &&
			fs.existsSync(path.join(packageDir, 'package.json'))
		)
	})
})

export function getPackageDir({ packageSlug }: { packageSlug: string }) {
	const packagesDir = getPackagesDir()
	return path.join(packagesDir, packageSlug)
}

export async function getPackageJson({ packageSlug }: { packageSlug: string }) {
	const packageJson = JSON.parse(
		await fs.promises.readFile(
			path.join(getPackageDir({ packageSlug }), 'package.json'),
			'utf8'
		)
	) as PackageJson

	return packageJson
}

export async function shouldPackageBeChecked({
	packageSlug,
}: {
	packageSlug: string
}): Promise<boolean> {
	const packageDir = getPackageDir({ packageSlug })
	const nodeModulesPath = path.join(packageDir, 'node_modules')
	const metadataPath = path.join(nodeModulesPath, 'metadata.json')
	if (!fs.existsSync(nodeModulesPath)) return false
	if (fs.existsSync(metadataPath)) {
		const metadata = JSON.parse(
			await fs.promises.readFile(metadataPath, 'utf8')
		) as { ignoreScripts?: boolean }
		if (metadata.ignoreScripts) {
			return false
		}
	}

	return true
}
